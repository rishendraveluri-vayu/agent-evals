"""A stand-in for the API's worker endpoints (docs/api-contract.md, "Worker protocol"), for the
worker's tests. It hands out scripted claims, stores uploaded files as the API does, records every
request, and can be told to lose a claim, drop a connection or refuse an upload or a report. The
real lease logic is the API's; this only plays the answers a worker must handle. Nothing here
talks to a model.

    api = FakeWorkerApi(runs_dir=tmp / "runs")  # where uploads land, as the API's runs/
    api.claims.append(make_claim(spec))
    ...  # run a worker against api.url
    api.reports()  # what the worker sent
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

FAKE_WORKER_TOKEN = "wt-test-not-a-secret"
MAX_FILE_BYTES = 64 * 1024 * 1024  # the API's limit (apps/api/src/trials/trial-files.ts)


def _sha(value: str | None) -> str | None:
    """`sha256:<hex>` or bare hex, any case, as `sha256:<hex>`; None for anything else."""
    text = (value or "").strip().lower()
    text = text.removeprefix("sha256:")
    if len(text) == 64 and all(c in "0123456789abcdef" for c in text):
        return "sha256:" + text
    return None


def _safe_rel(rel: str) -> bool:
    if not rel or rel.startswith("/") or "\\" in rel or "\0" in rel:
        return False
    return all(part not in ("", ".", "..") for part in rel.split("/"))


def make_claim(
    spec: dict[str, Any],
    state_files: dict[str, bytes] | None = None,
    keys: dict[str, str | None] | None = None,
    lease_s: int = 60,
    **extra: Any,
) -> dict[str, Any]:
    """A 200 claim body for `spec`, with the attempt taken from the spec."""
    body = {
        "trial_id": spec["trial"]["id"],
        "attempt": spec["trial"]["attempt"],
        "spec": spec,
        "state_files": {
            name: base64.b64encode(data).decode() for name, data in (state_files or {}).items()
        },
        "keys": keys or {"model": "sk-trial-agent-fake", "sim": None},
        "budgets": {"trial_usd": 0.5, "sim_usd": 0.1},
        "lease_s": lease_s,
    }
    body.update(extra)
    return body


def spend_row(
    n: int,
    start: str,
    end: str,
    model: str = "fake/finance-emi",
    messages: list[dict[str, Any]] | None = None,
    spend: float = 0.000034,
    status: str = "success",
) -> dict[str, Any]:
    """One LiteLLM spend-log row in v1.99.4's shape (see tests/test_proxy.py)."""
    return {
        "request_id": f"req-{n}",
        "status": status,
        "model": model.replace("fake/", "openai/"),
        "model_group": model,
        "prompt_tokens": 8,
        "completion_tokens": 13 if status == "success" else 0,
        "spend": spend if status == "success" else 0.0,
        "startTime": start,
        "endTime": end,
        "metadata": {"error_information": None},
        "proxy_server_request": {
            "model": model,
            "messages": messages or [{"role": "user", "content": f"call {n}"}],
            "temperature": 0.2,
            "max_tokens": 1024,
        },
        "response": {"choices": [{"finish_reason": "stop"}]},
    }


def rows_from_fake_requests(requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """LiteLLM-shaped rows for requests the fake model server captured, as if LiteLLM had sat in
    front of it: same order, times, model and messages."""
    rows = []
    for n, req in enumerate(requests, 1):
        body = req.get("body") or {}
        # `ts` has the full precision; `time` is cut to milliseconds.
        when = req.get("time")
        if isinstance(req.get("ts"), int | float):
            when = dt.datetime.fromtimestamp(req["ts"], dt.UTC).isoformat()
        row = spend_row(
            n,
            when,
            when,
            model=body.get("model") or "fake/unknown",
            messages=body.get("messages"),
        )
        row["proxy_server_request"] = {**body}
        rows.append(row)
    return rows


class FakeWorkerApi:
    """The five worker endpoints on a local port, under `prefix` (the real API's is /api).

    - `claims`: handed out in order by POST /worker/claim. A dict is a 200 claim, an int is a
      bare status; when the list is empty the answer is 204.
    - `lose`: trial ids whose heartbeats, calls, uploads and reports get 409 claim_lost.
    - `calls`: (trial_id, role) -> spend-log rows for GET .../calls.
    - uploads (PUT .../files/<path>) are checked as the API checks them (hash header, path,
      `max_file_bytes`), kept in `files[(trial_id, attempt)][path]`, and written under
      `runs_dir/<experiment>/<trial>/attempt-<n>/` when `runs_dir` is set. Never overwritten.
    - `upload_faults`, `report_faults`: one entry per request, in order. "drop" stores it, then
      closes the connection without an answer (the API stored it but the worker never heard);
      an int is answered as that status without storing; "lose" (uploads) loses the claim.
    - a report must name exactly what was uploaded; with `strict_files` (the default) anything
      else is a 400, otherwise it is accepted and listed in `problems`, as the real API does.
    - `sim_cache`: simulator replies by cache key, filled from each accepted report's uploaded
      sim_replies.jsonl (first reply per key kept). With `serve_sim_cache`, every claim whose
      task has a simulated client carries it, as the API's claim does (D22). The real API also
      scopes the cache by task, simulator model, settings and prompt; tests here use one.
    """

    def __init__(
        self, token: str = FAKE_WORKER_TOKEN, prefix: str = "/api", runs_dir: Path | None = None
    ) -> None:
        self.token = token
        self.prefix = prefix.rstrip("/")
        self.runs_dir = runs_dir
        self.claims: list[dict[str, Any] | int] = []
        self.lose: set[str] = set()
        self.calls: Callable[[str, str], list[dict[str, Any]]] = lambda trial_id, role: []
        self.report_faults: list[str | int] = []
        self.upload_faults: list[str | int] = []
        self.max_file_bytes = MAX_FILE_BYTES
        self.strict_files = True
        self.files: dict[tuple[str, int], dict[str, bytes]] = {}
        self.sim_cache: dict[str, str] = {}
        self.handed: list[dict[str, Any]] = []  # the claims as sent
        self.serve_sim_cache = False
        self.problems: dict[tuple[str, int], list[str]] = {}
        self.log: list[dict[str, Any]] = []
        self.accepted: dict[tuple[str, int], dict[str, Any]] = {}
        self.experiments: dict[str, str | None] = {}
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _send(self, status: int, body: Any = None) -> None:
                data = b"" if body is None else json.dumps(body).encode()
                self.send_response(status)
                if data:
                    self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if data:
                    self.wfile.write(data)

            def _route(self, method: str) -> None:
                url = urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                if method == "PUT" and length > outer.max_file_bytes:
                    # As the API: refused from the Content-Length, before the body is read.
                    self.close_connection = True
                    self._send(413, {"error": "file_too_large", "message": f"{length} bytes"})
                    return
                raw = self.rfile.read(length) if length else b""
                body: Any = raw if method == "PUT" else (json.loads(raw) if raw else None)
                if self.headers.get("Authorization") != f"Bearer {outer.token}":
                    self._send(401, {"error": "unauthorized", "message": "bad worker token"})
                    return
                if not url.path.startswith(outer.prefix + "/worker/"):
                    self._send(404, {"error": "not_found", "message": url.path})
                    return
                parts = [unquote(p) for p in url.path[len(outer.prefix) + 1 :].split("/")]
                query = {k: v[0] for k, v in parse_qs(url.query).items()}
                if method == "PUT":
                    query["sha256"] = self.headers.get("X-Content-Sha256") or ""
                    query["content_type"] = self.headers.get("Content-Type") or ""
                answer = outer._answer(method, parts, query, body)
                if answer == "drop":
                    self.close_connection = True
                    return
                self._send(*answer)

            def do_GET(self) -> None:  # noqa: N802
                self._route("GET")

            def do_POST(self) -> None:  # noqa: N802
                self._route("POST")

            def do_PUT(self) -> None:  # noqa: N802
                self._route("PUT")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}{self.prefix}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    # ---- what the worker sent

    def requests(self, kind: str | None = None, trial_id: str | None = None) -> list[dict]:
        with self._lock:
            rows = list(self.log)
        return [
            r
            for r in rows
            if (kind is None or r["kind"] == kind)
            and (trial_id is None or r.get("trial_id") == trial_id)
        ]

    def reports(self, trial_id: str | None = None) -> list[dict[str, Any]]:
        return [r["body"] for r in self.requests("report", trial_id)]

    def stored(self, trial_id: str, attempt: int = 1) -> dict[str, bytes]:
        """The files the worker uploaded for one attempt, by path."""
        with self._lock:
            return dict(self.files.get((trial_id, attempt), {}))

    def wait_for(self, kind: str, count: int = 1, timeout_s: float = 30.0, **match: Any) -> bool:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            if len(self.requests(kind, **match)) >= count:
                return True
            time.sleep(0.05)
        return False

    # ---- answers

    def _record(self, kind: str, trial_id: str | None, body: Any, status: Any) -> None:
        with self._lock:
            row = {"kind": kind, "trial_id": trial_id, "body": body, "status": status}
            self.log.append({**row, "t": time.time()})

    def _answer(self, method: str, parts: list[str], query: dict[str, str], body: Any) -> Any:
        if method == "POST" and parts == ["worker", "claim"]:
            with self._lock:
                item = self.claims.pop(0) if self.claims else 204
            if isinstance(item, dict):
                self.experiments[item["trial_id"]] = item["spec"]["trial"].get("experiment_id")
                if self.serve_sim_cache and item["spec"]["task"].get("client_sim"):
                    with self._lock:
                        item = {**item, "sim_cache": dict(self.sim_cache)}
                self.handed.append(item)
                self._record("claim", item["trial_id"], body, 200)
                return 200, item
            self._record("claim", None, body, item)
            return (item, None) if item == 204 else (item, {"error": "scripted", "message": "x"})
        if (
            method == "PUT"
            and len(parts) >= 5
            and parts[:2] + parts[3:4] == ["worker", "trials", "files"]
        ):
            return self._upload(parts[2], "/".join(parts[4:]), query, body)
        if len(parts) != 4 or parts[:2] != ["worker", "trials"]:
            return 404, {"error": "not_found", "message": "/".join(parts)}
        trial_id, action = parts[2], parts[3]
        lost = trial_id in self.lose
        if method == "POST" and action == "heartbeat":
            status = 409 if lost else 200
            self._record("heartbeat", trial_id, body, status)
            return (409, {"error": "claim_lost", "message": "lease lapsed"}) if lost else (200, {})
        if method == "GET" and action == "calls":
            role = query.get("role", "agent")
            if lost:
                self._record("calls", trial_id, {"role": role}, 409)
                return 409, {"error": "claim_lost", "message": "lease lapsed"}
            rows = self.calls(trial_id, role)
            self._record("calls", trial_id, {"role": role}, 200)
            return 200, rows
        if method == "POST" and action == "report":
            with self._lock:
                fault = self.report_faults.pop(0) if self.report_faults else None
            if lost:
                self._record("report", trial_id, body, 409)
                return 409, {"error": "claim_lost", "message": "lease lapsed"}
            if isinstance(fault, int):
                self._record("report", trial_id, body, fault)
                return fault, {"error": "scripted", "message": "scripted failure"}
            problems = self._check_files(trial_id, body)
            if problems and self.strict_files:
                self._record("report", trial_id, body, 400)
                return 400, {"error": "hash_mismatch", "message": "; ".join(problems)}
            key = (trial_id, body["attempt"])
            with self._lock:
                duplicate = key in self.accepted
                self.accepted.setdefault(key, body)
                self.problems.setdefault(key, problems)
                replies = self.files.get(key, {}).get("sim_replies.jsonl", b"")
                for line in replies.decode("utf-8", "replace").splitlines():
                    if line.strip():
                        row = json.loads(line)
                        self.sim_cache.setdefault(row["key"], row["reply"])
            self._record("report", trial_id, body, "drop" if fault == "drop" else 200)
            if fault == "drop":
                return "drop"
            return 200, {"status": "duplicate" if duplicate else "stored", "problems": problems}
        return 404, {"error": "not_found", "message": "/".join(parts)}

    def attempt_dir(self, trial_id: str, attempt: int) -> Path | None:
        if self.runs_dir is None:
            return None
        experiment = self.experiments.get(trial_id) or "no-experiment"
        return self.runs_dir / experiment / trial_id / f"attempt-{attempt}"

    def _upload(self, trial_id: str, rel: str, query: dict[str, str], data: bytes) -> Any:
        """PUT .../files/<rel>, checked as the API checks it (apps/api worker.service upload)."""
        attempt = int(query["attempt"]) if query.get("attempt", "").isdigit() else None
        row = {"path": rel, "bytes": len(data), "sha256": query.get("sha256"), "query": query}
        with self._lock:
            fault = self.upload_faults.pop(0) if self.upload_faults else None
            if fault == "lose":  # the lease lapses while the files go up
                self.lose.add(trial_id)
        answer: Any
        sha = _sha(query.get("sha256"))
        if query.get("content_type") != "application/octet-stream":
            answer = 415, {"error": "unsupported_media_type", "message": "octet-stream only"}
        elif sha is None or not query.get("worker_id") or attempt is None:
            answer = 400, {"error": "invalid_upload", "message": "sha256, worker_id, attempt"}
        elif not _safe_rel(rel):
            answer = 400, {"error": "invalid_path", "message": rel}
        elif trial_id in self.lose:
            answer = 409, {"error": "claim_lost", "message": "lease lapsed"}
        elif isinstance(fault, int):
            answer = fault, {"error": "scripted", "message": "scripted failure"}
        elif "sha256:" + hashlib.sha256(data).hexdigest() != sha:
            answer = 400, {"error": "hash_mismatch", "message": rel}
        else:
            with self._lock:
                held = self.files.setdefault((trial_id, attempt), {})
                reported = (trial_id, attempt) in self.accepted
                if rel in held and held[rel] == data:
                    answer = (
                        200,
                        {"path": rel, "bytes": len(data), "sha256": sha, "duplicate": True},
                    )
                elif rel in held:
                    answer = 409, {"error": "file_conflict", "message": f"{rel} differs"}
                elif reported:
                    answer = 409, {"error": "already_reported", "message": rel}
                else:
                    held[rel] = data
                    answer = (
                        201,
                        {"path": rel, "bytes": len(data), "sha256": sha, "duplicate": False},
                    )
            folder = self.attempt_dir(trial_id, attempt)
            if answer[0] == 201 and folder is not None:
                (folder / rel).parent.mkdir(parents=True, exist_ok=True)
                (folder / rel).write_bytes(data)
            if fault == "drop":
                self._record("upload", trial_id, row, "drop")
                return "drop"
        self._record("upload", trial_id, row, answer[0])
        return answer

    def _check_files(self, trial_id: str, body: dict[str, Any]) -> list[str]:
        """What the report's manifest says that the uploads do not, as the API flags it."""
        held = self.stored(trial_id, body["attempt"])
        problems = []
        for row in body.get("files", []):
            data = held.get(row["path"])
            if data is None:
                problems.append(f"{row['path']} not uploaded")
            elif len(data) != row["bytes"] or "sha256:" + hashlib.sha256(data).hexdigest() != _sha(
                row["sha256"]
            ):
                problems.append(f"{row['path']} does not match what was uploaded")
        named = {row["path"] for row in body.get("files", [])}
        problems += [f"{rel} uploaded but not in the report" for rel in sorted(set(held) - named)]
        return problems
