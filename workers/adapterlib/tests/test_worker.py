"""The SP3 worker loop against a fake API (docs/api-contract.md, "Worker protocol").

The adapter is the scripted fixture (no model); tests/../workers/ownloop/tests/test_worker.py
runs the same loop with the own loop against the fake model server.
"""

from __future__ import annotations

import json
import random
import shlex
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from support import SCRIPTED_CMD, attrs, errors, read_jsonl
from worker_support import (
    EXPERIMENT,
    LEAK_CMD,
    TRIAL_PLACES,
    alive,
    pids_with_env,
    rows_in_turn,
    worker_spec,
)

from evals_adapter.fake_api import FAKE_WORKER_TOKEN, FakeWorkerApi, make_claim
from evals_adapter.proxy import ProxyError
from evals_adapter.worker import (
    ApiClient,
    ApiProxyClient,
    ClaimLost,
    NetworkError,
    TrialControl,
    TrialStopped,
    Worker,
    WorkerConfig,
    claim_problem,
    files_manifest,
)

QUICK = {"turns": [{"reply": "Your EMI is Rs 8,997.26.", "model_calls": 2}]}
SLOW = {"turns": [{"sleep_s": 60, "reply": "never sent"}]}


@pytest.fixture
def api(tmp_path):
    server = FakeWorkerApi(runs_dir=tmp_path / "runs")
    server.calls = lambda trial_id, role: rows_in_turn(tmp_path / "trial")
    yield server
    server.close()


def config(tmp_path: Path, api: FakeWorkerApi, cmd: list[str] = SCRIPTED_CMD, **kw) -> WorkerConfig:
    values = {
        "api_url": api.url,
        "token": FAKE_WORKER_TOKEN,
        "harness": "scripted",
        "adapter_cmd": cmd,
        "worker_id": "w-test",
        "trial_root": tmp_path / "trial",
        "runs_dir": tmp_path / "runs",
        "heartbeat_s": 0.2,
        "idle_base_s": 0.01,
        "idle_max_s": 0.05,
        "retry_base_s": 0.01,
        "retry_max_s": 0.05,
    }
    values.update(kw)
    return WorkerConfig(**values)


def attempt_dir(tmp_path: Path, trial_id: str = "t_test_0001", attempt: int = 1) -> Path:
    return tmp_path / "runs" / EXPERIMENT / trial_id / f"attempt-{attempt}"


def serve_in_thread(worker: Worker, **kw) -> threading.Thread:
    thread = threading.Thread(target=worker.serve, kwargs=kw, daemon=True)
    thread.start()
    return thread


def test_claim_run_store_report(tmp_path, api):
    spec = worker_spec(harness_options=QUICK)
    api.claims.append(make_claim(spec, state_files={"client.json": b'{"name": "Meera"}'}))
    worker = Worker(config(tmp_path, api))
    assert worker.serve(exit_on_idle=True) == 0
    assert worker.outcomes == [("t_test_0001", 1, "reported")]

    (claim_req,) = api.requests("claim")[:1]
    assert claim_req["body"] == {"worker_id": "w-test", "harness": "scripted"}
    (body,) = api.reports()
    assert body["worker_id"] == "w-test" and body["attempt"] == 1
    report = body["runner_report"]
    assert errors("runner-report", report) == []
    assert report["label"] == "agent" and report["end_state"] == "answered"
    assert report["trial_id"] == "t_test_0001" and report["attempt"] == 1
    assert errors("result", body["result"]) == []
    assert body["result"]["final_answer"] == "Your EMI is Rs 8,997.26."
    for span in body["spans"]:
        assert errors("span", span) == [], span

    # Stored whole, at the contract's path, and the manifest matches what is on disk (the fake
    # API checked every hash before answering 200).
    folder = attempt_dir(tmp_path)
    assert body["files"] == files_manifest(folder)
    paths = {row["path"] for row in body["files"]}
    assert {"result.json", "trace.jsonl", "runner-report.json", "stdout.log", "stderr.log"} <= paths
    assert json.loads((folder / "runner-report.json").read_text()) == report
    assert [r["status"] for r in api.requests("report")] == [200]
    assert not list(folder.parent.glob(".attempt-*")), "partial folder left behind"
    # D3: nothing of the trial is left in the trial folder.
    assert list((tmp_path / "trial").iterdir()) == []


def test_spend_rows_from_the_api_become_chat_spans(tmp_path, api):
    api.calls = lambda trial_id, role: rows_in_turn(
        tmp_path / "trial", n=2, spends=[0.0001, 0.0002]
    )
    api.claims.append(make_claim(worker_spec(harness_options=QUICK)))
    Worker(config(tmp_path, api)).serve(exit_on_idle=True)
    (body,) = api.reports()
    assert {r["body"]["role"] for r in api.requests("calls")} == {"agent"}
    usage = body["runner_report"]["proxy_usage"]
    assert usage["complete"] is True and usage["model_calls"] == 2
    assert usage["cost_usd"] == pytest.approx(0.0003)
    (turn,) = [s for s in body["spans"] if s["name"] == "agent.turn"]
    chats = [s for s in body["spans"] if s["name"].startswith("chat ")]
    assert len(chats) == 2
    for chat, cost in zip(chats, [0.0001, 0.0002], strict=True):
        a = attrs(chat)
        assert chat["parentSpanId"] == turn["spanId"]
        assert a["evals.source"] == "proxy" and a["evals.role"] == "agent"
        assert a["evals.cost_usd"] == cost
        assert (attempt_dir(tmp_path) / a["evals.request_ref"]).is_file()
    stored = read_jsonl(attempt_dir(tmp_path) / "trace.jsonl")
    assert stored == body["spans"]


def test_idle_204_backs_off_with_jitter_and_resets_after_a_claim(tmp_path, api):
    delays: list[float] = []
    api.claims += [204, 204, 204, 500, make_claim(worker_spec(harness_options=QUICK)), 204]
    cfg = config(tmp_path, api, idle_base_s=1.0, idle_max_s=4.0)
    worker = Worker(cfg, sleep=delays.append, rand=lambda: 0.5)
    worker.serve(max_trials=1)
    # 1, 2, 4, then capped at 4; each scaled by the jitter factor 0.5 + 0.5 * rand.
    assert delays == [0.75, 1.5, 3.0, 3.0]
    assert worker.outcomes == [("t_test_0001", 1, "reported")]

    jittered = Worker(cfg, sleep=delays.append, rand=random.Random(7).random)
    samples = [jittered.idle_backoff_s(n) for n in range(6)]
    for n, value in enumerate(samples):
        ceiling = min(4.0, 2.0**n)
        assert ceiling / 2 <= value <= ceiling
    assert len(set(samples)) == len(samples)


def test_claim_lost_kills_the_trial_and_reports_nothing(tmp_path, api):
    api.claims.append(make_claim(worker_spec(harness_options=SLOW)))
    worker = Worker(config(tmp_path, api))
    started = time.time()
    thread = serve_in_thread(worker, max_trials=1)
    assert api.wait_for("heartbeat", 2, trial_id="t_test_0001")
    marker = f"EVALS_TRIAL_DIR={tmp_path / 'trial'}"
    assert pids_with_env(marker), "the adapter should be running"
    api.lose.add("t_test_0001")
    thread.join(timeout=20)
    assert not thread.is_alive()
    assert time.time() - started < 15, "the 60 s trial was not killed"
    assert worker.outcomes == [("t_test_0001", 1, "stopped")]
    assert api.reports() == []
    assert not attempt_dir(tmp_path).exists()
    assert pids_with_env(marker) == []
    assert list((tmp_path / "trial").iterdir()) == []
    beats = api.requests("heartbeat")
    assert beats[0]["body"] == {"worker_id": "w-test", "attempt": 1}
    assert beats[-1]["status"] == 409
    time.sleep(0.6)
    assert len(api.requests("heartbeat")) == len(beats), "heartbeats went on after the 409"


def test_report_retried_after_a_network_error_is_the_same_report(tmp_path, api):
    # The API stores the first report, then the connection drops before the answer: the worker
    # cannot tell, so it sends the same attempt again and the API answers it as a no-op.
    api.report_faults = ["drop", 503]
    api.claims.append(make_claim(worker_spec(harness_options=QUICK)))
    worker = Worker(config(tmp_path, api))
    worker.serve(exit_on_idle=True)
    assert worker.outcomes == [("t_test_0001", 1, "reported")]
    sent = api.requests("report")
    assert [r["status"] for r in sent] == ["drop", 503, 200]
    assert sent[0]["body"] == sent[1]["body"] == sent[2]["body"]
    assert {r["body"]["attempt"] for r in sent} == {1}
    assert list(api.accepted) == [("t_test_0001", 1)]


def test_a_refused_report_is_not_retried(tmp_path, api):
    api.report_faults = [400]
    api.claims.append(make_claim(worker_spec(harness_options=QUICK)))
    worker = Worker(config(tmp_path, api))
    worker.serve(exit_on_idle=True)
    assert worker.outcomes == [("t_test_0001", 1, "failed")]
    assert [r["status"] for r in api.requests("report")] == [400]
    assert attempt_dir(tmp_path).is_dir(), "the stored folder stays, nothing is deleted"
    assert list((tmp_path / "trial").iterdir()) == []


def test_an_existing_attempt_folder_is_never_overwritten(tmp_path, api):
    folder = attempt_dir(tmp_path)
    folder.mkdir(parents=True)
    (folder / "result.json").write_text("an earlier result")
    api.claims.append(make_claim(worker_spec(harness_options=QUICK)))
    worker = Worker(config(tmp_path, api))
    worker.serve(exit_on_idle=True)
    assert worker.outcomes == [("t_test_0001", 1, "failed")]
    assert api.reports() == []
    assert (folder / "result.json").read_text() == "an earlier result"
    assert sorted(p.name for p in folder.iterdir()) == ["result.json"]


def test_adapter_crash_is_stored_and_reported_as_infra(tmp_path, api):
    spec = worker_spec(harness_options={"crash_before_lib": 3})
    api.calls = lambda trial_id, role: []
    api.claims.append(make_claim(spec))
    Worker(config(tmp_path, api)).serve(exit_on_idle=True)
    (body,) = api.reports()
    assert body["runner_report"]["label"] == "infra:adapter_crash"
    assert body["result"] is None
    assert "crashing on purpose" in (attempt_dir(tmp_path) / "stderr.log").read_text()


@pytest.mark.parametrize(
    ("change", "problem"),
    [
        ({"attempt": 2}, "spec.trial.attempt"),
        ({"trial_id": "../escape"}, "not a usable id"),
        ({"state_files": {"../client.json": "e30="}}, "plain relative path"),
        ({"state_files": {"client.json": "not base64!"}}, "valid base64"),
        ({"keys": {"sim": "x"}}, "keys.model"),
    ],
)
def test_claims_the_worker_cannot_run_faithfully_are_refused(tmp_path, api, change, problem):
    claim = make_claim(worker_spec(harness_options=QUICK))
    claim.update(change)
    assert problem in (claim_problem(claim) or "")
    api.claims.append(claim)
    worker = Worker(config(tmp_path, api))
    worker.serve(exit_on_idle=True)
    assert worker.outcomes[0][2] == "refused"
    assert api.requests("heartbeat") == [] and api.reports() == []


def test_no_state_leaks_between_trials_on_a_host(tmp_path, api):
    """D3 in-process: trial 1 writes into every part of the trial folder and leaves processes;
    trial 2 starts from an empty folder and sees none of it. The image test repeats this in a
    worker container, with the container-wide sweep."""
    api.calls = lambda trial_id, role: []
    write = worker_spec("t_leak_1", harness_options={"phase": "write", "places": TRIAL_PLACES})
    check = worker_spec("t_leak_2", harness_options={"phase": "check", "places": TRIAL_PLACES})
    api.claims += [make_claim(write), make_claim(check)]
    worker = Worker(config(tmp_path, api, cmd=LEAK_CMD))
    worker.serve(exit_on_idle=True)
    assert [o[2] for o in worker.outcomes] == ["reported", "reported"]
    root = tmp_path / "runs" / EXPERIMENT
    wrote = json.loads((root / "t_leak_1/attempt-1/artifacts/leak-view.json").read_text())
    assert set(wrote["wrote"].values()) == {"written"}
    assert len(wrote["spawned"]) == 2
    seen = json.loads((root / "t_leak_2/attempt-1/artifacts/leak-view.json").read_text())
    assert seen["seen"] == dict.fromkeys(TRIAL_PLACES)
    assert seen["home"] == [] and seen["tmp"] == []
    assert not [p for p in seen["trial_listing"] if "leak" in p], seen["trial_listing"]
    assert seen["sleepers"] == []
    assert not any(alive(pid) for pid in wrote["spawned"])


def test_api_proxy_client_maps_keys_and_reads_calls_through_the_api(tmp_path, api):
    client = ApiProxyClient(
        ApiClient(api.url, FAKE_WORKER_TOKEN), "t_1", {"model": "sk-a", "sim": None}, retry_s=0
    )
    agent = client.create_key("t_1", "agent", 0.5, ["fake/x"])
    assert (agent.key, agent.token) == ("sk-a", "agent")
    with pytest.raises(ProxyError, match="keys.sim"):
        client.create_key("t_1", "sim", 0.1, ["fake/sim"])
    with pytest.raises(ProxyError, match="claim is t_1"):
        client.create_key("t_2", "agent", 0.5, ["fake/x"])
    assert client.revoke([agent]) is None

    rows = [{"request_id": "r1", "startTime": "2026-11-04T10:00:00Z"}]
    api.calls = lambda trial_id, role: rows if (trial_id, role) == ("t_1", "agent") else []
    got, complete = client.call_records("agent", expect_at_least=1, min_wait_s=0, settle_s=0)
    assert (got, complete) == (rows, True)

    api.lose.add("t_1")
    with pytest.raises(ClaimLost):
        client.call_records("agent", min_wait_s=0, settle_s=0)
    control = TrialControl()
    control.stop("claim_lost")
    stopped = ApiProxyClient(ApiClient(api.url, FAKE_WORKER_TOKEN), "t_1", {}, control)
    with pytest.raises(TrialStopped):
        stopped.call_records("agent")


def test_api_client_errors(tmp_path):
    dead = ApiClient("http://127.0.0.1:9", FAKE_WORKER_TOKEN, timeout_s=1)
    with pytest.raises(NetworkError):
        dead.claim("w", "scripted")
    server = FakeWorkerApi()
    try:
        wrong = ApiClient(server.url, "wrong-token")
        with pytest.raises(Exception, match="401"):
            wrong.claim("w", "scripted")
        assert ApiClient(server.url, FAKE_WORKER_TOKEN).claim("w", "scripted") is None
    finally:
        server.close()


# ---- the worker as a process: kill it, restart it, stop it -----------------------------------


def worker_process(tmp_path: Path, api: FakeWorkerApi, worker_id: str, *args: str):
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "EVALS_API_URL": api.url,
        "EVALS_WORKER_TOKEN": FAKE_WORKER_TOKEN,
        "EVALS_HARNESS": "scripted",
        "EVALS_ADAPTER_CMD": shlex.join(SCRIPTED_CMD),
        "EVALS_WORKER_ID": worker_id,
    }
    log = open(tmp_path / f"{worker_id}.log", "wb")  # noqa: SIM115 - closed by the caller
    proc = subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            "-m",
            "evals_adapter.worker",
            "--trial-root",
            str(tmp_path / "trial"),
            "--runs-dir",
            str(tmp_path / "runs"),
            "--heartbeat-s",
            "0.2",
            *args,
        ],
        env=env,
        stdout=log,
        stderr=log,
    )
    return proc, log


def test_killed_worker_leaves_no_half_result_and_a_restart_claims_fresh_work(tmp_path, api):
    """SP3 done-when, worker side. The API's half (lease lapse, abandoned, re-queue) is the API's
    own test; here the fake API plays it by handing out attempt 2 after the kill."""
    marker = f"EVALS_TRIAL_DIR={tmp_path / 'trial'}"
    api.claims.append(make_claim(worker_spec(harness_options=SLOW)))
    first, log1 = worker_process(tmp_path, api, "w-kill-1", "--max-trials", "1")
    try:
        assert api.wait_for("heartbeat", 2, trial_id="t_test_0001")
        orphans = pids_with_env(marker)
        assert orphans, "the trial's adapter should be running"
    finally:
        first.kill()
        first.wait()
        log1.close()
    time.sleep(0.3)  # a heartbeat already on the wire may still land
    beats = len(api.requests("heartbeat"))
    time.sleep(0.6)
    assert len(api.requests("heartbeat")) == beats, "a dead worker kept its lease alive"
    assert api.reports() == []
    trial_runs = tmp_path / "runs" / EXPERIMENT / "t_test_0001"
    assert not trial_runs.exists() or not list(trial_runs.iterdir()), "half-stored attempt"
    # On a shared host the adapter outlives the worker (its own session). In a container it dies
    # with the worker; the restart must clean it up either way.
    assert all(alive(pid) for pid in orphans)
    assert (tmp_path / "trial" / "spec.json").exists()

    api.claims.append(make_claim(worker_spec(attempt=2, harness_options=QUICK)))
    second, log2 = worker_process(tmp_path, api, "w-kill-2", "--max-trials", "1")
    try:
        assert second.wait(timeout=60) == 0
    finally:
        log2.close()
    assert not any(alive(pid) for pid in orphans), "the restart left the old trial running"
    assert "leftover process" in (tmp_path / "w-kill-2.log").read_text()
    (body,) = api.reports()
    assert (body["worker_id"], body["attempt"]) == ("w-kill-2", 2)
    assert body["runner_report"]["label"] == "agent"
    assert sorted(p.name for p in trial_runs.iterdir()) == ["attempt-2"]
    roots = [s for s in body["spans"] if "parentSpanId" not in s]
    assert len(roots) == 1 and attrs(roots[0])["evals.trial.attempt"] == 2
    assert list((tmp_path / "trial").iterdir()) == []


def test_sigterm_stops_the_trial_without_a_report(tmp_path, api):
    marker = f"EVALS_TRIAL_DIR={tmp_path / 'trial'}"
    api.claims.append(make_claim(worker_spec(harness_options=SLOW)))
    proc, log = worker_process(tmp_path, api, "w-term")
    try:
        assert api.wait_for("heartbeat", 1, trial_id="t_test_0001")
        started = time.time()
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=20) == 0
        assert time.time() - started < 10
    finally:
        if proc.poll() is None:
            proc.kill()
        log.close()
    assert api.reports() == []
    assert pids_with_env(marker) == []
    assert list((tmp_path / "trial").iterdir()) == []
    assert "stopped (shutdown)" in (tmp_path / "w-term.log").read_text()
