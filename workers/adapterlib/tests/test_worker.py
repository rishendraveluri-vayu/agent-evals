"""The SP3 worker loop against a fake API (docs/api-contract.md, "Worker protocol").

The adapter is the scripted fixture (no model); tests/../workers/ownloop/tests/test_worker.py
runs the same loop with the own loop against the fake model server.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import shlex
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from support import SCRIPTED_CMD, SimServer, attrs, client_sim, errors, read_jsonl
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

FAR = time.monotonic() + 3600  # an upload deadline that never passes in a test

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
        "heartbeat_s": 0.2,
        "idle_base_s": 0.01,
        "idle_max_s": 0.05,
        "retry_base_s": 0.01,
        "retry_max_s": 0.05,
    }
    values.update(kw)
    return WorkerConfig(**values)


def attempt_dir(tmp_path: Path, trial_id: str = "t_test_0001", attempt: int = 1) -> Path:
    """Where the fake API stores an attempt's uploads, as the API does under runs/."""
    return tmp_path / "runs" / EXPERIMENT / trial_id / f"attempt-{attempt}"


def serve_in_thread(worker: Worker, **kw) -> threading.Thread:
    thread = threading.Thread(target=worker.serve, kwargs=kw, daemon=True)
    thread.start()
    return thread


def test_claim_run_upload_report(tmp_path, api):
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

    # Every file of out/ went to the API before the report, each with its hash, and the report
    # names exactly those files (the fake API checked every hash before answering 200).
    uploads = api.requests("upload")
    assert [u["status"] for u in uploads] == [201] * len(uploads)
    stored = api.stored("t_test_0001")
    assert sorted(stored) == [row["path"] for row in body["files"]]
    for u in uploads:
        data = stored[u["body"]["path"]]
        assert u["body"]["sha256"] == "sha256:" + hashlib.sha256(data).hexdigest()
        assert u["body"]["query"]["worker_id"] == "w-test" and u["body"]["query"]["attempt"] == "1"
    assert max(u["t"] for u in uploads) < api.requests("report")[0]["t"]
    folder = attempt_dir(tmp_path)
    assert body["files"] == files_manifest(folder)
    paths = {row["path"] for row in body["files"]}
    assert {"result.json", "trace.jsonl", "runner-report.json", "stdout.log", "stderr.log"} <= paths
    assert json.loads((folder / "runner-report.json").read_text()) == report
    assert [r["status"] for r in api.requests("report")] == [200]
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
    assert api.stored("t_test_0001"), "the uploaded files stay with the API, nothing is deleted"
    assert list((tmp_path / "trial").iterdir()) == []


def test_uploads_are_retried_after_a_dropped_answer_and_a_5xx(tmp_path, api):
    # The first upload is stored but its answer is lost, so it is sent again, refused once with a
    # 503, and sent a third time, when the API answers it as a repeat of what it holds.
    api.upload_faults = ["drop", 503]
    api.claims.append(make_claim(worker_spec(harness_options=QUICK)))
    worker = Worker(config(tmp_path, api))
    worker.serve(exit_on_idle=True)
    assert worker.outcomes == [("t_test_0001", 1, "reported")]
    sent = api.requests("upload")
    assert [u["status"] for u in sent[:4]] == ["drop", 503, 200, 201]
    assert len({u["body"]["path"] for u in sent[:3]}) == 1
    assert sent[3]["body"]["path"] != sent[0]["body"]["path"]
    (body,) = api.reports()
    assert sorted(api.stored("t_test_0001")) == [row["path"] for row in body["files"]]


def test_a_file_the_api_already_holds_differently_is_never_overwritten(tmp_path, api):
    api.files[("t_test_0001", 1)] = {"result.json": b"an earlier result"}
    api.claims.append(make_claim(worker_spec(harness_options=QUICK)))
    worker = Worker(config(tmp_path, api))
    worker.serve(exit_on_idle=True)
    assert worker.outcomes == [("t_test_0001", 1, "failed")]
    assert api.reports() == []
    conflicts = [u for u in api.requests("upload") if u["status"] == 409]
    assert [u["body"]["path"] for u in conflicts] == ["result.json"]
    assert api.stored("t_test_0001")["result.json"] == b"an earlier result"
    assert list((tmp_path / "trial").iterdir()) == []


def test_claim_lost_during_the_upload_stops_without_a_report(tmp_path, api):
    api.upload_faults = [None, "lose"]
    api.claims.append(make_claim(worker_spec(harness_options=QUICK)))
    worker = Worker(config(tmp_path, api))
    worker.serve(exit_on_idle=True)
    assert worker.outcomes == [("t_test_0001", 1, "stopped")]
    assert [u["status"] for u in api.requests("upload")] == [201, 409]
    assert api.reports() == []
    assert list((tmp_path / "trial").iterdir()) == []


def test_only_regular_files_are_uploaded_and_names_survive_the_url(tmp_path, api):
    """A trial could leave a symlink in out/ pointing at the worker's environment or another
    file; the worker sends regular files only, and never follows a link."""
    out = tmp_path / "out"
    (out / "artifacts" / "deep").mkdir(parents=True)
    (out / "result.json").write_text("{}")
    (out / "artifacts" / "deep" / "a b%#?.txt").write_text("odd name")
    secret = tmp_path / "secret.txt"
    secret.write_text("EVALS_WORKER_TOKEN=leaked")
    (out / "artifacts" / "link.txt").symlink_to(secret)
    (out / "artifacts" / "linked-dir").symlink_to(tmp_path)
    os.mkfifo(out / "artifacts" / "pipe")
    worker = Worker(config(tmp_path, api))
    api.experiments["t_x"] = EXPERIMENT
    rows = worker.upload("t_x", 1, out, TrialControl(), FAR)
    assert [r["path"] for r in rows] == ["artifacts/deep/a b%#?.txt", "result.json"]
    assert api.stored("t_x") == {"artifacts/deep/a b%#?.txt": b"odd name", "result.json": b"{}"}
    assert b"leaked" not in b"".join(api.stored("t_x").values())


def test_a_file_over_the_limit_is_not_sent_but_flagged(tmp_path, api):
    out = tmp_path / "out"
    out.mkdir()
    (out / "small.txt").write_text("small")
    (out / "big.bin").write_bytes(b"x" * 200)
    api.experiments["t_x"] = EXPERIMENT
    api.strict_files = False
    worker = Worker(config(tmp_path, api, max_file_bytes=100))
    rows = worker.upload("t_x", 1, out, TrialControl(), FAR)
    assert [r["path"] for r in rows] == ["big.bin", "small.txt"]
    assert rows[0]["bytes"] == 200 and rows[0]["sha256"] == hashlib.sha256(b"x" * 200).hexdigest()
    assert sorted(api.stored("t_x")) == ["small.txt"]
    assert [u["body"]["path"] for u in api.requests("upload")] == ["small.txt"]
    # The API's own limit is enforced too: a 413 is logged and the file stays in the manifest.
    api.max_file_bytes = 100
    rows = Worker(config(tmp_path, api)).upload("t_y", 1, out, TrialControl(), FAR)
    assert [r["path"] for r in rows] == ["big.bin", "small.txt"]
    assert [u["status"] for u in api.requests("upload", trial_id="t_y")] == [201]
    # The report then names the file the API does not hold, and the API flags it.
    ApiClient(api.url, FAKE_WORKER_TOKEN).report(
        "t_y", {"worker_id": "w-test", "attempt": 1, "files": rows}
    )
    assert api.problems[("t_y", 1)] == ["big.bin not uploaded"]


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


def test_a_second_trial_of_the_same_conversation_reuses_the_simulator_replies(tmp_path, api):
    """D22 through the worker loop: trial 1's new simulator replies go to the API with its other
    files; the API's claim for trial 2 of the same conversation task carries them, so trial 2 has
    the same conversation without one simulator call."""
    sim = SimServer(
        ["Will I lose the house?", "OK. What should I do first?", "Thank you. [[END_CONVERSATION]]"]
    )
    api.calls = lambda trial_id, role: []
    api.serve_sim_cache = True
    turns = [{"reply": "{{last_user}}", "model_calls": 0}]
    keys = {"model": "sk-trial-agent-fake", "sim": "sk-trial-sim-fake"}
    try:
        for n in (1, 2):
            spec = worker_spec(f"t_sim_{n}", harness_options={"turns": turns})
            spec["task"]["client_sim"] = client_sim(sim.url)
            spec["task"]["messages"] = [{"role": "user", "content": "I don't know where to start."}]
            api.claims.append(make_claim(spec, keys=keys))
        worker = Worker(config(tmp_path, api))
        worker.serve(max_trials=1)
        calls_in_trial_1 = len(sim.requests)
        worker.serve(exit_on_idle=True)
    finally:
        sim.close()
    assert [o[2] for o in worker.outcomes] == ["reported", "reported"]
    assert calls_in_trial_1 == 3
    assert len(sim.requests) == 3, "trial 2 called the simulator"
    assert {r["auth"] for r in sim.requests} == {"Bearer sk-trial-sim-fake"}

    first, second = api.reports("t_sim_1")[0], api.reports("t_sim_2")[0]
    replies = [json.loads(line) for line in api.stored("t_sim_1")["sim_replies.jsonl"].splitlines()]
    assert [r["reply"] for r in replies] == [
        "Will I lose the house?",
        "OK. What should I do first?",
        "Thank you. [[END_CONVERSATION]]",
    ]
    assert api.handed[0]["sim_cache"] == {}
    assert api.handed[1]["sim_cache"] == {r["key"]: r["reply"] for r in replies}
    assert "sim_replies.jsonl" not in api.stored("t_sim_2"), "trial 2 had no new replies"

    def hits(body):
        return [
            attrs(s)["evals.sim.cache_hit"] for s in body["spans"] if s["name"] == "client_sim.turn"
        ]

    assert hits(first) == [False, False, False]
    assert hits(second) == [True, True, True]
    assert first["runner_report"]["label"] == second["runner_report"]["label"] == "agent"
    transcript = first["result"]["conversation"]["transcript"]
    assert second["result"]["conversation"]["transcript"] == transcript
    assert transcript[-1]["content"] == "Thank you."


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
