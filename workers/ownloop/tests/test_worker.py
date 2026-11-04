"""The SP3 worker loop with the own loop's real adapter: claim from a fake API, run against the
fake model server (as the gate tests do), upload, report. No real model is called."""

import sys

import pytest
from evals_adapter.fake_api import (
    FAKE_WORKER_TOKEN,
    FakeWorkerApi,
    make_claim,
    rows_from_fake_requests,
)
from evals_adapter.gate import CLIENT_EXAMPLE, FakeServer
from evals_adapter.trace import attr_dict
from evals_adapter.worker import Worker, WorkerConfig, files_manifest
from test_gate import GATE


@pytest.fixture(scope="module")
def fake():
    server = FakeServer()
    yield server
    server.stop()


def test_worker_claims_runs_and_reports_a_real_trial(tmp_path, fake):
    fake.reset()
    trial_root, runs = tmp_path / "trial", tmp_path / "runs"
    spec = GATE.spec(trial_root, "finance-emi", fake)
    spec["trial"].update(id="t_worker_1", experiment_id="e_worker")
    api = FakeWorkerApi(runs_dir=runs)
    # LiteLLM's rows for the trial key, built from what the fake model server received.
    api.calls = lambda trial_id, role: (
        rows_from_fake_requests(fake.requests()) if role == "agent" else []
    )
    api.claims.append(
        make_claim(
            spec,
            state_files={"client.json": CLIENT_EXAMPLE.read_bytes()},
            keys={"model": "sk-trial-fake", "sim": None},
        )
    )
    worker = Worker(
        WorkerConfig(
            api_url=api.url,
            token=FAKE_WORKER_TOKEN,
            harness="ownloop",
            adapter_cmd=[sys.executable, "-m", "ownloop.adapter"],
            worker_id="w-ownloop",
            trial_root=trial_root,
            heartbeat_s=0.5,
        )
    )
    try:
        worker.serve(exit_on_idle=True)
    finally:
        api.close()
    assert worker.outcomes == [("t_worker_1", 1, "reported")]
    (body,) = api.reports()
    report, result = body["runner_report"], body["result"]
    assert report["label"] == "agent", report
    assert result["end_state"] == "answered"
    assert "8,997" in result["final_answer"]
    (tool,) = [s for s in body["spans"] if s["name"].startswith("execute_tool")]
    assert "8997.26" in attr_dict(tool)["evals.tool.result"]
    (turn,) = [s for s in body["spans"] if s["name"] == "agent.turn"]
    chats = [s for s in body["spans"] if s["name"].startswith("chat ")]
    assert len(chats) == 2 == report["proxy_usage"]["model_calls"]
    assert report["proxy_usage"]["complete"] is True
    assert all(c["parentSpanId"] == turn["spanId"] for c in chats)
    # Uploaded to the API, which stores them under runs/; the worker never wrote there itself.
    folder = runs / "e_worker" / "t_worker_1" / "attempt-1"
    assert body["files"] == files_manifest(folder)
    assert sorted(api.stored("t_worker_1")) == [row["path"] for row in body["files"]]
    assert list(trial_root.iterdir()) == []
