"""LiteLLM as the source of truth for model calls (R10.9, contract v2 sections 6 and 10).

The runner gives each trial its own virtual key with a spend cap, then reads LiteLLM's spend
log for that key after the adapter exits. Each logged call becomes a `chat <model>` span under
the agent turn it happened in, with its full request and response bodies stored as artifacts.
Hidden harness retries show up here as extra spans, which is why the counts come from here.

Checked against LiteLLM v1.99.4 on 3 Nov: `GET /spend/logs?api_key=<token>` returns one row per
call, failures included (`status: failure`, `metadata.error_information.error_code`), and with
`store_prompts_in_spend_logs` the bodies are in `proxy_server_request` and `response`. Rows are
written in batches: LiteLLM flushes every `proxy_batch_write_at + randint(0, 5)` seconds, the
interval drawn once when it starts (proxy_server.py, `batch_writing_interval`), so with our 1 s
a row lands 1 to 6 s after its call, plus the write itself (SPEND_LOG_QUIET_S).

LiteLLM's own retries (D16) do not add rows: a request it retried is still one row, with the
retries in `metadata.attempted_retries` (checked 4 Nov). So a span is one request the harness
sent, `evals.proxy.attempts` says how many tries the provider got, and a harness retry is
still an extra span.
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

# How long after the adapter exits the runner waits before it takes LiteLLM's log as complete:
# LiteLLM's longest flush interval with `proxy_batch_write_at: 1` (6 s, see above) and a second for
# the write. Soak test (6 Nov): the agent key's read ended about 2 s after the adapter exited (once
# the harness's own count was met) and the simulator key's, with no floor, 1.5 s later, while rows
# landed 0.1 to 2.3 s after their call; 9 of the 11 trials short of a call (8 simulated-client
# calls, one Hermes summary call its own count leaves out) were still marked complete.
SPEND_LOG_QUIET_S = 7.0


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

    def _spend_rows(self, token: str) -> list[dict]:
        """One read of LiteLLM's spend log for a key. The SP3 worker reads it through the API
        instead (`evals_adapter.worker.ApiProxyClient`), with the same wait and settle logic."""
        return self._request("GET", f"/spend/logs?api_key={token}") or []

    def read_calls(
        self,
        wants: list[tuple[str, int]],
        since: float | None = None,
        quiet_s: float = SPEND_LOG_QUIET_S,
        settle_s: float = 1.5,
        max_wait_s: float = 30.0,
        poll_s: float = 0.3,
        slow_read_s: float = 2.0,
    ) -> tuple[dict[str, list[dict]], bool]:
        """Every logged call for each key, oldest first, and whether the log is shown complete.

        `wants` is (token, floor) per key: the floor is how many calls the trial is known to
        have made with it (the runner's `_harness_calls` and `_sim_calls`). LiteLLM writes its
        log in batches, so the record counts as complete only when every key holds at least its
        floor, `quiet_s` has passed since `since` (when the adapter exited: no call can start
        after it, and LiteLLM's last batch is written within SPEND_LOG_QUIET_S), and no key's
        count has changed for `settle_s`. The wait also covers calls nobody counted, such as
        Hermes's summary call at its step limit. If `max_wait_s` of waiting runs out first, the
        records are returned with complete=False and the trial is flagged, never trusted. No read
        before `since + quiet_s - settle_s` could show anything, so the first one waits until then.

        A read slower than `slow_read_s` was held up retrying (the worker reads through the API,
        and retries while the API, LiteLLM or Postgres is down, up to its own deadline), so its
        time does not use up `max_wait_s`: otherwise every trial that ended just before an outage
        was flagged although its log was whole (seen on the fixsoak stack, 6 Nov)."""
        start = time.time()
        since = start if since is None else since
        not_before = since + quiet_s
        first = not_before - settle_s
        waited = 0.0
        if first > start:
            time.sleep(min(first - start, max_wait_s))
            waited = time.time() - start
        last: dict[str, int] | None = None
        stable_since = time.time()
        rows: dict[str, list[dict]] = {}
        complete = False
        while True:
            began = time.time()
            rows = {token: self._spend_rows(token) for token, _ in wants}
            now = time.time()
            if now - began < slow_read_s:
                waited += now - began
            counts = {token: len(r) for token, r in rows.items()}
            if counts != last:
                last, stable_since = counts, now
            enough = all(counts[token] >= floor for token, floor in wants)
            if enough and now >= not_before and now - stable_since >= settle_s:
                complete = True
                break
            if waited > max_wait_s:
                break
            time.sleep(poll_s)
            waited += poll_s
        order = lambda r: (r.get("startTime") or "", r.get("request_id") or "")  # noqa: E731
        return {token: sorted(r, key=order) for token, r in rows.items()}, complete

    def call_records(
        self,
        token: str,
        expect_at_least: int = 0,
        settle_s: float = 1.5,
        min_wait_s: float = 2.0,
        max_wait_s: float = 30.0,
    ) -> tuple[list[dict], bool]:
        """One key's calls, waiting at least `min_wait_s` from now (read_calls)."""
        rows, complete = self.read_calls(
            [(token, expect_at_least)], None, min_wait_s, settle_s, max_wait_s
        )
        return rows[token], complete

    @staticmethod
    def usage(records: list[dict], complete: bool = True) -> dict[str, Any]:
        """`model_calls` counts the requests the harness sent (one row each), `attempts` the
        requests LiteLLM sent the provider for them (D16 retries included), and
        `retried_calls` the calls that needed more than one attempt."""
        failed = [r for r in records if r.get("status") != "success"]
        last = records[-1] if records else None
        return {
            "complete": complete,
            "model_calls": len(records),
            "attempts": sum(provider_attempts(r) for r in records),
            "retried_calls": sum(1 for r in records if provider_attempts(r) > 1),
            "failed_calls": len(failed),
            "input_tokens": sum(int(r.get("prompt_tokens") or 0) for r in records),
            "output_tokens": sum(int(r.get("completion_tokens") or 0) for r in records),
            "cost_usd": round(sum(float(r.get("spend") or 0.0) for r in records), 8),
            "last_status": call_status(last) if last else None,
        }


def provider_attempts(row: dict) -> int:
    """How many times LiteLLM sent this logged call to the provider (D16).

    LiteLLM v1.99.4 writes one spend-log row per request it receives, however many times its
    router retried it, and puts the retries in `metadata.attempted_retries` (checked 4 Nov
    against the fake: 429, 429, 200 is one success row with attempted_retries 2). A call
    refused before routing (a budget stop) has no attempted_retries and never reached the
    provider, so it counts 0."""
    retries = (row.get("metadata") or {}).get("attempted_retries")
    if isinstance(retries, bool) or not isinstance(retries, int):
        return 0
    return 1 + max(retries, 0)


def call_status(row: dict) -> str:
    """'200' for success, LiteLLM's error code for a failure, 'budget_exceeded' for a cap."""
    if row.get("status") == "success":
        return "200"
    info = (row.get("metadata") or {}).get("error_information") or {}
    if str(info.get("error_budget_limit") or "None") != "None":
        return "budget_exceeded"
    return str(info.get("error_code") or "unknown")


def call_error(row: dict | None) -> str | None:
    """LiteLLM's error message for a failed call (`error_information.error_message`), or None
    for a success or a row without one. LiteLLM's own words, whichever harness made the call:
    the soak test's 404 row says `404: {'error': "Team doesn't exist in db. ..."}`."""
    if not row or row.get("status") == "success":
        return None
    info = (row.get("metadata") or {}).get("error_information") or {}
    message = info.get("error_message")
    return str(message)[:2000] if message else None


# LiteLLM's note inside a stored string it has cut short (v1.99.4).
TRUNCATION_NOTE = "MAX_STRING_LENGTH_PROMPT_IN_DB"


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


def merge_proxy_spans(
    paths: TrialPaths, records: list[dict], trial_id: str, role: str = "agent"
) -> int:
    """Append one `chat <model>` span per logged call to trace.jsonl and store the bodies.
    Returns spans written.

    role "agent": the agent's calls, parented to the agent turn whose time window holds the
    call's start. role "sim": the simulated client's calls (its own key), parented to the
    client_sim.turn span they belong to, so the simulator's cost is visible but separate."""
    from evals_adapter.trace import read_spans

    spans = read_spans(paths.trace)
    if not spans and not records:
        return 0
    trial_trace = trace_id_for(trial_id)
    root = next((s for s in spans if not s.get("parentSpanId")), None)
    parent_name = "agent.turn" if role == "agent" else "client_sim.turn"
    turns = sorted(
        (s for s in spans if s["name"] == parent_name), key=lambda s: int(s["startTimeUnixNano"])
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
        stem = f"{n:04d}" if role == "agent" else f"{role}-{n:04d}"
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
            "evals.role": role,
            "evals.attempt": attempt,
            # LiteLLM's own tries at this call (D16); evals.attempt counts the harness's.
            "evals.proxy.attempts": provider_attempts(row),
            "evals.proxy.status": status,
            "evals.proxy.request_id": row.get("request_id"),
            "evals.cost_usd": float(row.get("spend") or 0.0),
            "evals.request_ref": f"artifacts/proxy/{stem}.request.json",
            "evals.response_ref": f"artifacts/proxy/{stem}.response.json",
            "evals.request.stream": req.get("stream"),
            # A cut-short body cannot feed the invariance diff; flag it rather than trust it.
            "evals.request.truncated": TRUNCATION_NOTE in json.dumps(req),
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
