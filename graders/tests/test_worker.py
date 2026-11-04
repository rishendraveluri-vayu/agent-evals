"""evals-grader against a small fake of the API's grading endpoints (the real API is covered by
apps/api/test/grading.e2e-spec.ts)."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from support import real

from evals_graders import FRAMEWORK_VERSION
from evals_graders.canonical import grader_version, spec_sha256
from evals_graders.worker import GraderApi, run_once

TOKEN = "wt-test"
RUBRIC_MD = b"<!-- notes -->\nJudge as a careful adviser would.\n"
GRADER_PY = (
    b"def grade(trial):\n    return {'pass': '28 months' in (trial['final_answer'] or '')}\n"
)


def sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


class FakeApi:
    def __init__(
        self,
        trial_dir,
        graders,
        files_override=None,
        report_status=200,
        file_status=200,
        extra_claim=None,
    ):
        self.extra_claim = extra_claim or {}
        self.files = {p.name: p.read_bytes() for p in trial_dir.iterdir() if p.is_file()}
        self.served = dict(self.files, **(files_override or {}))
        self.graders = graders
        self.reports: list[dict[str, Any]] = []
        self.downloads: list[str] = []
        self.claims = 0
        self.report_status = report_status
        self.file_status = file_status
        self.job_left = True

    def claim_body(self) -> dict[str, Any]:
        entries = []
        files = {}
        for spec in self.graders:
            names = {}
            if spec["type"] == "unit_test":
                names = {"grader.py": sha(GRADER_PY)}
                files["grader.py"] = {
                    "sha256": sha(GRADER_PY),
                    "base64": base64.b64encode(GRADER_PY).decode(),
                }
            if spec["type"] == "judge":
                names = {spec["rubric"]: sha(RUBRIC_MD)}
                files[spec["rubric"]] = {
                    "sha256": sha(RUBRIC_MD),
                    "base64": base64.b64encode(RUBRIC_MD).decode(),
                }
            entries.append({"spec": spec, "spec_sha256": spec_sha256(spec, names)})
        manifest = [{"path": k, "bytes": len(v), "sha256": sha(v)} for k, v in self.files.items()]
        manifest.append(
            {"path": "artifacts/proxy/0001.request.json", "bytes": 10, "sha256": sha(b"x")}
        )
        return {
            "job_id": "g_1",
            "attempt": 1,
            "trial_id": "t_1",
            "lease_s": 120,
            "graders": entries,
            "grader_files": files,
            "trial": {"files": manifest, "end_state": "answered"},
            "task": {"id": "draft-x", "summary": "A client asks where to start."},
            **self.extra_claim,
        }


@pytest.fixture
def serve():
    servers = []

    def start(api: FakeApi) -> GraderApi:
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status: int, body: Any = None, raw: bytes | None = None):
                data = (
                    raw if raw is not None else (b"" if body is None else json.dumps(body).encode())
                )
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):  # noqa: N802
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    return self.reply(401, {"error": "unauthorized"})
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/api/grader/claim":
                    api.claims += 1
                    if not api.job_left:
                        return self.reply(204)
                    api.job_left = False
                    return self.reply(200, api.claim_body())
                if self.path == "/api/grader/trials/t_1/grades":
                    api.reports.append(body)
                    if api.report_status != 200:
                        return self.reply(api.report_status, {"error": "claim_lost"})
                    return self.reply(
                        200, {"job_id": "g_1", "outcome": body["outcome"], "duplicate": False}
                    )
                return self.reply(404)

            def do_GET(self):  # noqa: N802
                prefix = "/api/trials/t_1/files/"
                if self.path.startswith(prefix):
                    name = self.path[len(prefix) :]
                    api.downloads.append(name)
                    if api.file_status != 200:
                        return self.reply(api.file_status, {"error": "unavailable"})
                    if name in api.served:
                        return self.reply(200, raw=api.served[name])
                return self.reply(404, {"error": "not_found"})

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return GraderApi(f"http://127.0.0.1:{server.server_address[1]}/api", TOKEN, timeout_s=5)

    yield start
    for s in servers:
        s.shutdown()


GRADERS = [
    {
        "id": "interest",
        "type": "number",
        "expected": {"from_tool": "debt_payoff_plan", "field": "total_interest"},
    },
    {"id": "unit", "type": "unit_test"},
    {"id": "answered", "type": "end_state", "states": ["answered"]},
]


def test_claims_downloads_grades_and_reports(serve, tmp_path):
    api = FakeApi(real("hermes-single"), GRADERS)
    client = serve(api)
    assert run_once(client, "grader-1", tmp_path) == "graded"
    # only what graders read is downloaded, never the proxy bodies
    assert sorted(api.downloads) == ["result.json", "runner-report.json", "trace.jsonl"]
    [report] = api.reports
    assert (report["worker_id"], report["job_id"], report["attempt"]) == ("grader-1", "g_1", 1)
    assert report["framework_version"] == FRAMEWORK_VERSION
    assert [g["verdict"] for g in report["grades"]] == ["pass", "pass", "pass"]
    assert report["outcome"] == "pass"
    # each version is built from the API's spec hash, so the API can check it
    claimed = api.claim_body()["graders"]
    for g, c in zip(report["grades"], claimed, strict=True):
        assert g["grader_version"] == grader_version(c["spec_sha256"], FRAMEWORK_VERSION)
    assert run_once(client, "grader-1", tmp_path) == "idle"


def test_a_file_that_differs_from_the_manifest_is_reported_as_error_grades(serve, tmp_path):
    api = FakeApi(
        real("hermes-single"), GRADERS[:1], files_override={"result.json": b'{"tampered": true}'}
    )
    assert run_once(serve(api), "grader-1", tmp_path) == "graded"
    [report] = api.reports
    g = report["grades"][0]
    assert g["verdict"] == "error" and "differs from the trial's manifest" in g["reason"]
    assert report["problems"]


def test_a_lost_claim_drops_the_job(serve, tmp_path):
    api = FakeApi(real("hermes-single"), GRADERS[:1], report_status=409)
    assert run_once(serve(api), "grader-1", tmp_path) == "dropped"


def test_files_the_api_cannot_serve_now_leave_the_job_to_lapse(serve, tmp_path):
    api = FakeApi(real("hermes-single"), GRADERS[:1], file_status=503)
    assert run_once(serve(api), "grader-1", tmp_path) == "unavailable"
    assert api.reports == []


# ---- the judge: the rubric comes in the claim, the key only with an approval -----------------

JUDGE = {
    "id": "advice",
    "type": "judge",
    "rubric": "configs/rubrics/test.v1.md",
    "criteria": [{"id": "clear", "text": "The answer is clear."}],
}


@pytest.fixture
def fake_litellm():
    calls: list[dict[str, Any]] = []
    reply = {"content": ""}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append({"auth": self.headers.get("Authorization"), "body": body})
            data = json.dumps(
                {"choices": [{"message": {"content": reply["content"]}, "finish_reason": "stop"}]}
            ).encode()
            self.send_response(200)
            self.send_header("x-litellm-response-cost", "0.001")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}", calls, reply
    server.shutdown()


def test_an_approved_judge_reads_the_rubric_from_the_claim_and_calls_with_its_key(
    serve, fake_litellm, tmp_path
):
    url, calls, reply = fake_litellm
    final = json.loads((real("hermes-single") / "result.json").read_text())["final_answer"]
    reply["content"] = json.dumps(
        {"criteria": [{"id": "clear", "verdict": "yes", "quote": final[:50]}]}
    )
    judge = {"base_url": url, "api_key": "sk-judge-e1", "model": "fake/judge"}
    api = FakeApi(real("hermes-single"), [JUDGE], extra_claim={"judge": judge})
    assert run_once(serve(api), "grader-1", tmp_path) == "graded"
    [call] = calls
    assert call["auth"] == "Bearer sk-judge-e1" and call["body"]["model"] == "fake/judge"
    system, user = (m["content"] for m in call["body"]["messages"])
    assert system.startswith("Judge as a careful adviser would.")
    assert user.startswith("## The task\n\nA client asks where to start.")
    [g] = api.reports[0]["grades"]
    assert g["verdict"] == "pass" and g["evidence"][0]["quote_found"] is True
    claimed = api.claim_body()["graders"][0]
    assert g["grader_version"] == grader_version(claimed["spec_sha256"], FRAMEWORK_VERSION)


def test_no_approval_in_the_claim_means_no_call(serve, fake_litellm, tmp_path):
    _, calls, _ = fake_litellm
    api = FakeApi(real("hermes-single"), [JUDGE])
    assert run_once(serve(api), "grader-1", tmp_path) == "graded"
    assert calls == []
    assert api.reports[0]["grades"][0]["verdict"] == "not_implemented"


def test_nothing_is_spent_judging_a_trial_whose_files_are_not_intact(serve, fake_litellm, tmp_path):
    url, calls, _ = fake_litellm
    judge = {"base_url": url, "api_key": "sk-judge-e1", "model": "fake/judge"}
    api = FakeApi(
        real("hermes-single"),
        [JUDGE],
        files_override={"result.json": b'{"tampered": true}'},
        extra_claim={"judge": judge},
    )
    assert run_once(serve(api), "grader-1", tmp_path) == "graded"
    assert calls == []
    assert api.reports[0]["grades"][0]["verdict"] == "error"
