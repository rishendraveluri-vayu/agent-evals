"""LiteLLM as the source of truth for model calls (R10.9, contract v2 sections 6 and 10).

The runner gives each trial its own virtual key with a spend cap, then reads LiteLLM's spend
log for that key after the adapter exits. Each logged call becomes a `chat <model>` span under
the agent turn it happened in, with its full request and response bodies stored as artifacts.
Hidden harness retries show up here as extra spans, which is why the counts come from here.

Checked against LiteLLM v1.99.4 on 3 Nov: `GET /spend/logs?api_key=<token>` returns one row per
call, failures included (`status: failure`, `metadata.error_information.error_code`), and with
`store_prompts_in_spend_logs` the bodies are in `proxy_server_request` and `response`. Rows land
about 1 s after the call with `proxy_batch_write_at: 1`.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from evals_adapter.spec import TrialPaths
from evals_adapter.trace import (
    KIND_CLIENT,
    STATUS_ERROR,
    STATUS_OK,
    attributes,
    new_span_id,
    trace_id_for,
)


@dataclass
class TrialKey:
    key: str  # the secret, handed to the adapter in an environment variable
    token: str  # LiteLLM's hash of it, used to read the spend log and to revoke


class ProxyError(RuntimeError):
    pass


class ProxyClient:
    def __init__(self, base_url: str, master_key: str, timeout_s: float = 15.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.master_key = master_key
        self.timeout_s = timeout_s

    def _request(self, method: str, path: str, body: dict | None = None) -> Any:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": f"Bearer {self.master_key}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310
                return json.loads(resp.read().decode() or "null")
        except urllib.error.HTTPError as exc:
            raise ProxyError(f"{method} {path}: HTTP {exc.code}: {exc.read()[:300]!r}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise ProxyError(f"{method} {path}: {exc}") from exc

    def create_key(
        self, trial_id: str, role: str, max_budget_usd: float, models: list[str]
    ) -> TrialKey:
        data = self._request(
            "POST",
            "/key/generate",
            {
                "key_alias": f"{trial_id}:{role}",
                "max_budget": max_budget_usd,
                "models": models,
                "metadata": {"trial_id": trial_id, "role": role},
            },
        )
        return TrialKey(key=data["key"], token=data["token"])

    def revoke(self, keys: list[TrialKey]) -> None:
        if keys:
            self._request("POST", "/key/delete", {"keys": [k.token for k in keys]})

    def call_records(
        self, token: str, settle_s: float = 1.5, max_wait_s: float = 15.0
    ) -> list[dict]:
        """Every logged call for the key, oldest first. Polls until the count has not changed
        for `settle_s`, because LiteLLM writes the spend log in batches."""
        start = time.time()
        last_n, stable_since = -1, time.time()
        rows: list[dict] = []
        while True:
            rows = self._request("GET", f"/spend/logs?api_key={token}") or []
            if len(rows) != last_n:
                last_n, stable_since = len(rows), time.time()
            elif time.time() - stable_since >= settle_s:
                break
            if time.time() - start > max_wait_s:
                break
            time.sleep(0.3)
        return sorted(rows, key=lambda r: (r.get("startTime") or "", r.get("request_id") or ""))

    @staticmethod
    def usage(records: list[dict]) -> dict[str, Any]:
        failed = [r for r in records if r.get("status") != "success"]
        last = records[-1] if records else None
        return {
            "model_calls": len(records),
            "failed_calls": len(failed),
            "input_tokens": sum(int(r.get("prompt_tokens") or 0) for r in records),
            "output_tokens": sum(int(r.get("completion_tokens") or 0) for r in records),
            "cost_usd": round(sum(float(r.get("spend") or 0.0) for r in records), 8),
            "last_status": call_status(last) if last else None,
        }


def call_status(row: dict) -> str:
    """'200' for success, LiteLLM's error code for a failure, 'budget_exceeded' for a cap."""
    if row.get("status") == "success":
        return "200"
    info = (row.get("metadata") or {}).get("error_information") or {}
    if str(info.get("error_budget_limit") or "None") != "None":
        return "budget_exceeded"
    return str(info.get("error_code") or "unknown")


def iso_to_ns(value: str | None) -> int:
    if not value:
        return 0
    ts = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return int(ts.timestamp() * 1_000_000_000)


def _request_body(row: dict) -> dict[str, Any]:
    body = dict(row.get("proxy_server_request") or {})
    meta = body.pop("metadata", None)  # LiteLLM's own metadata, headers included
    body.pop("litellm_call_id", None)
    if isinstance(meta, dict) and meta.get("headers"):
        body["_headers_seen"] = sorted(meta["headers"])  # names only
    return body


def merge_proxy_spans(paths: TrialPaths, records: list[dict], trial_id: str) -> int:
    """Append one `chat <model>` span per logged call to trace.jsonl, parented to the agent turn
    whose time window holds the call's start, and store the bodies. Returns spans written."""
    from evals_adapter.trace import read_spans

    spans = read_spans(paths.trace)
    if not spans and not records:
        return 0
    trial_trace = trace_id_for(trial_id)
    root = next((s for s in spans if not s.get("parentSpanId")), None)
    turns = sorted(
        (s for s in spans if s["name"] == "agent.turn"), key=lambda s: int(s["startTimeUnixNano"])
    )
    body_dir = paths.artifacts / "proxy"
    body_dir.mkdir(parents=True, exist_ok=True)
    previous_hash, attempt = None, 0
    lines = []
    for n, row in enumerate(records, 1):
        start, end = iso_to_ns(row.get("startTime")), iso_to_ns(row.get("endTime"))
        parent = root
        for turn in turns:
            if int(turn["startTimeUnixNano"]) <= start <= int(turn["endTimeUnixNano"]):
                parent = turn
        req = _request_body(row)
        resp = row.get("response") or {}
        msg_hash = hashlib.sha256(
            json.dumps(req.get("messages"), sort_keys=True).encode()
        ).hexdigest()
        attempt = attempt + 1 if msg_hash == previous_hash else 1
        previous_hash = msg_hash
        stem = f"{n:04d}"
        (body_dir / f"{stem}.request.json").write_text(
            json.dumps(req, ensure_ascii=False, indent=1)
        )
        (body_dir / f"{stem}.response.json").write_text(
            json.dumps(resp, ensure_ascii=False, indent=1)
        )
        status = call_status(row)
        finish = (
            [c.get("finish_reason") for c in resp.get("choices", [])]
            if isinstance(resp, dict)
            else []
        )
        attrs = {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": row.get("model_group") or req.get("model"),
            "gen_ai.response.model": row.get("model"),
            "gen_ai.request.temperature": req.get("temperature"),
            "gen_ai.request.max_tokens": req.get("max_tokens") or req.get("max_completion_tokens"),
            "gen_ai.usage.input_tokens": int(row.get("prompt_tokens") or 0),
            "gen_ai.usage.output_tokens": int(row.get("completion_tokens") or 0),
            "gen_ai.response.finish_reasons": [f for f in finish if f] or None,
            "evals.source": "proxy",
            "evals.attempt": attempt,
            "evals.proxy.status": status,
            "evals.proxy.request_id": row.get("request_id"),
            "evals.cost_usd": float(row.get("spend") or 0.0),
            "evals.request_ref": f"artifacts/proxy/{stem}.request.json",
            "evals.response_ref": f"artifacts/proxy/{stem}.response.json",
            "evals.request.stream": req.get("stream"),
            "evals.request.tool_count": len(req.get("tools") or []),
        }
        span: dict[str, Any] = {
            "traceId": trial_trace,
            "spanId": new_span_id(),
            "name": f"chat {attrs['gen_ai.request.model']}",
            "kind": KIND_CLIENT,
            "startTimeUnixNano": str(start),
            "endTimeUnixNano": str(max(end, start)),
            "attributes": attributes(attrs),
            "status": {"code": STATUS_OK if status == "200" else STATUS_ERROR},
        }
        if status != "200":
            info = (row.get("metadata") or {}).get("error_information") or {}
            span["status"]["message"] = str(info.get("error_message") or status)[:500]
        if parent is not None:
            span["parentSpanId"] = parent["spanId"]
        lines.append(json.dumps(span, ensure_ascii=False, separators=(",", ":")))
    with open(paths.trace, "a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(line + "\n")
    return len(lines)
