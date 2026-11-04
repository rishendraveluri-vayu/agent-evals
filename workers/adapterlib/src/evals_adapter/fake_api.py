"""A stand-in for the API's worker endpoints (docs/api-contract.md, "Worker protocol"), for the
worker's tests. It hands out scripted claims, records every request, and can be told to lose a
claim, drop a connection or refuse a report. The real lease logic is the API's; this only plays
the answers a worker must handle. Nothing here talks to a model.

    api = FakeWorkerApi(runs_dir=tmp / "runs")
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
    """The four worker endpoints on a local port, under `prefix` (the real API's is /api).

    - `claims`: handed out in order by POST /worker/claim. A dict is a 200 claim, an int is a
      bare status; when the list is empty the answer is 204.
    - `lose`: trial ids whose heartbeats (and later calls) get 409 claim_lost.
    - `calls`: (trial_id, role) -> spend-log rows for GET .../calls.
    - `report_faults`: one entry per report request, in order. "drop" records the report, then
      closes the connection without an answer (the API stored it but the worker never heard);
      an int is answered as that status without storing.
    - `runs_dir`: when set, a report is checked against the stored attempt folder's hashes.
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
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else None
                if self.headers.get("Authorization") != f"Bearer {outer.token}":
                    self._send(401, {"error": "unauthorized", "message": "bad worker token"})
                    return
                if not url.path.startswith(outer.prefix + "/worker/"):
                    self._send(404, {"error": "not_found", "message": url.path})
                    return
                parts = [unquote(p) for p in url.path[len(outer.prefix) + 1 :].split("/")]
                query = {k: v[0] for k, v in parse_qs(url.query).items()}
                answer = outer._answer(method, parts, query, body)
                if answer == "drop":
                    self.close_connection = True
                    return
                self._send(*answer)

            def do_GET(self) -> None:  # noqa: N802
                self._route("GET")

            def do_POST(self) -> None:  # noqa: N802
                self._route("POST")

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
                self._record("claim", item["trial_id"], body, 200)
                return 200, item
            self._record("claim", None, body, item)
            return (item, None) if item == 204 else (item, {"error": "scripted", "message": "x"})
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
            problem = self._check_files(trial_id, body)
            if problem:
                self._record("report", trial_id, body, 400)
                return 400, {"error": "hash_mismatch", "message": problem}
            key = (trial_id, body["attempt"])
            with self._lock:
                duplicate = key in self.accepted
                self.accepted.setdefault(key, body)
            self._record("report", trial_id, body, "drop" if fault == "drop" else 200)
            if fault == "drop":
                return "drop"
            return 200, {"status": "duplicate" if duplicate else "stored"}
        return 404, {"error": "not_found", "message": "/".join(parts)}

    def _check_files(self, trial_id: str, body: dict[str, Any]) -> str | None:
        if self.runs_dir is None:
            return None
        experiment = self.experiments.get(trial_id) or "no-experiment"
        folder = self.runs_dir / experiment / trial_id / f"attempt-{body['attempt']}"
        if not folder.is_dir():
            return f"{folder} does not exist"
        for row in body.get("files", []):
            path = folder / row["path"]
            if not path.is_file():
                return f"{row['path']} missing"
            data = path.read_bytes()
            if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
                return f"{row['path']} does not match its hash"
        return None
