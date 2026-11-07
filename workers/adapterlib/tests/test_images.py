"""The worker images under the D3 runtime: netcheck, a real trial against the fake model, the
leak test between two trials, and killing the worker mid-trial. Uses `docker run` and a private
network only, never compose, and only the fake model server.

Opt in, after building the images (workers/build_images.sh):

    EVALS_IMAGE_TESTS=1 uv run pytest -q tests/test_images.py

EVALS_IMAGE_TAG (default dev) tests images built with the same tag by workers/build_images.sh.

The worker reaches the fake API and the fake model on the host through --network host. That
network is for the test's plumbing only; the network rules themselves are what netcheck checks.
As in compose, the worker container mounts nothing but the read-only test fixtures: it uploads
each trial's files to the (fake) API, which stores them on the host.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import pytest
from support import FIXTURES, REPO
from worker_support import CONTAINER_PLACES, EXPERIMENT, worker_spec

from evals_adapter.fake_api import (
    FAKE_WORKER_TOKEN,
    FakeWorkerApi,
    make_claim,
    rows_from_fake_requests,
)
from evals_adapter.source_hash import source_sha256

HARNESSES = {
    "ownloop": "ownloop",
    "hermes": "hermes_adapter",
    "langgraph": "langgraph_adapter",
    "adk": "adk_adapter",
    "openai-agents": "openai_agents_adapter",
}
# x-worker-runtime in docker-compose.yml, as docker run flags.
RUNTIME = [
    "--read-only",
    "--tmpfs",
    "/trial:size=512m,uid=10001,gid=10001,mode=0700",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
]
FIXTURE_PY = "/opt/harness/bin/python /fixtures/{}"
MARKER = "leak-marker-from-trial-1"
TAG = os.environ.get("EVALS_IMAGE_TAG", "dev")

pytestmark = pytest.mark.skipif(
    os.environ.get("EVALS_IMAGE_TESTS") != "1" or shutil.which("docker") is None,
    reason="image tests are opt-in: EVALS_IMAGE_TESTS=1 after workers/build_images.sh",
)


def image(harness: str) -> str:
    name = f"agent-evals/worker-{harness}:{TAG}"
    found = subprocess.run(["docker", "image", "inspect", name], capture_output=True)
    if found.returncode != 0:
        pytest.skip(f"{name} not built")
    return name


def docker(*args: str, check: bool = True, timeout: float = 300) -> subprocess.CompletedProcess:
    proc = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise AssertionError(f"docker {' '.join(args)}: {proc.returncode}\n{proc.stderr[-3000:]}")
    return proc


def api_runs(tmp_path: Path) -> Path:
    """Where the fake API stores uploads, as the API's runs/. Only the host process writes it."""
    return tmp_path / "runs"


def worker_args(api: FakeWorkerApi, worker_id: str, cmd: str | None) -> list[str]:
    args = [
        "--network",
        "host",
        *RUNTIME,
        "-v",
        f"{FIXTURES}:/fixtures:ro",
        "-e",
        f"EVALS_API_URL={api.url}",
        "-e",
        f"EVALS_WORKER_TOKEN={FAKE_WORKER_TOKEN}",
        "-e",
        f"EVALS_WORKER_ID={worker_id}",
    ]
    if cmd is not None:
        args += ["-e", f"EVALS_ADAPTER_CMD={cmd}"]
    return args


@pytest.mark.parametrize("harness", HARNESSES)
def test_netcheck_in_the_image(harness):
    """workers/base's netcheck inside each image, on an internal network with stand-ins for the
    API, LiteLLM and the fake model (any HTTP answer counts as reachable)."""
    img = image(harness)
    net = f"sp3-netcheck-{uuid.uuid4().hex[:8]}"
    stubs = []
    docker("network", "create", "--internal", net)
    try:
        for alias, port in (("api", 3000), ("litellm", 4000), ("fake-llm", 8080)):
            name = f"{net}-{alias}"
            docker(
                "run", "-d", "--rm", "--name", name, "--network", net, "--network-alias", alias,
                "--entrypoint", "/opt/harness/bin/python", img, "-m", "http.server", str(port),
            )  # fmt: skip
            stubs.append(name)
        time.sleep(1.5)
        proc = docker(
            "run", "--rm", "--network", net, *RUNTIME, "--entrypoint", "/opt/harness/bin/python",
            img, "/opt/worker/netcheck.py", check=False,
        )  # fmt: skip
        rows = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
        assert proc.returncode == 0, rows or proc.stderr
        assert {r["check"] for r in rows} >= {"internet blocked", "root read-only"}
        assert all(r["ok"] for r in rows), rows
    finally:
        for name in stubs:
            docker("rm", "-f", name, check=False)
        docker("network", "rm", net, check=False)


@pytest.fixture(scope="module")
def fake():
    from evals_adapter.gate import FAKE_DIR, FakeServer

    if not (FAKE_DIR / ".venv" / "bin" / "fake-llm").exists():
        pytest.skip("run `uv sync` in services/fake-llm")
    server = FakeServer()
    yield server
    server.stop()


@pytest.mark.parametrize("harness", HARNESSES)
def test_a_real_trial_in_the_image(harness, tmp_path, fake):
    """The image's own adapter command, the finance server at /opt/finance-mcp, the read-only
    root: one finance-emi trial against the fake model, claimed and reported through the loop."""
    from evals_adapter.gate import CLIENT_EXAMPLE, Gate

    img = image(harness)
    caps = json.loads(
        (REPO / "workers" / harness / "src" / HARNESSES[harness] / "capabilities.json").read_text()
    )
    fake.reset()
    spec = Gate(harness=harness, adapter_cmd=[], capabilities=caps).spec(
        Path("/trial"), "finance-emi", fake
    )
    spec["trial"].update(id=f"t_img_{harness}", experiment_id=EXPERIMENT)
    spec["tools"]["mcp_servers"][0]["command"] = [
        "/opt/finance-mcp/bin/finance-mcp", "--transport", "stdio", "--state-dir", "/trial/state",
    ]  # fmt: skip
    runs = api_runs(tmp_path)
    api = FakeWorkerApi(runs_dir=runs)
    api.calls = lambda trial_id, role: (
        rows_from_fake_requests(fake.requests()) if role == "agent" else []
    )
    api.claims.append(make_claim(spec, state_files={"client.json": CLIENT_EXAMPLE.read_bytes()}))
    try:
        proc = docker(
            "run", "--rm", *worker_args(api, f"img-{harness}", None), img, "--exit-on-idle",
            check=False, timeout=240,
        )  # fmt: skip
    finally:
        api.close()
    (body,) = api.reports() or [None]
    assert body is not None, proc.stderr[-4000:]
    report, result = body["runner_report"], body["result"]
    folder = runs / EXPERIMENT / f"t_img_{harness}" / "attempt-1"
    stderr = (folder / "stderr.log").read_text(errors="replace")[-3000:]
    assert report["label"] == "agent", (report["adapter"], stderr)
    assert result["end_state"] == "answered", (result["end_detail"], stderr)
    assert "8,997" in (result["final_answer"] or "")
    assert result["counts"]["tool_calls"] == 1
    assert report["proxy_usage"]["model_calls"] == len(fake.requests()) >= 2
    assert report["adapter"]["leftover_processes"] >= 0
    assert (folder / "runner-report.json").is_file()
    assert sorted(api.stored(f"t_img_{harness}")) == [row["path"] for row in body["files"]]
    # D85: every claim named the adapter code in the image, which hashes as this checkout's
    # source does (an image built before a source edit fails here: rebuild it).
    code = source_sha256(
        [
            REPO / "workers" / harness / "src" / HARNESSES[harness],
            REPO / "workers" / "adapterlib" / "src" / "evals_adapter",
        ]
    )
    sent = [c["body"].get("adapter_sha256") for c in api.requests("claim")]
    assert sent and sent == [code] * len(sent), (sent, code, proc.stderr[-2000:])


@pytest.fixture(scope="module", params=list(HARNESSES))
def leak_views(request, tmp_path_factory):
    """Two trials in a row in one container: trial 1 writes markers everywhere it can and leaves
    processes behind (one with an empty environment in its own session); trial 2 looks."""
    harness = request.param
    img = image(harness)
    tmp = tmp_path_factory.mktemp(f"leak-{harness}")
    runs = api_runs(tmp)
    api = FakeWorkerApi(runs_dir=runs)
    opts = {"places": CONTAINER_PLACES, "escape": True}
    for n, phase in ((1, "write"), (2, "check")):
        spec = worker_spec(f"t_leak_{n}", harness_options={**opts, "phase": phase})
        api.claims.append(make_claim(spec))
    try:
        proc = docker(
            "run", "--rm", *worker_args(api, f"leak-{harness}", FIXTURE_PY.format("leak_probe.py")),
            img, "--exit-on-idle", check=False, timeout=240,
        )  # fmt: skip
    finally:
        api.close()
    assert [r["status"] for r in api.requests("report")] == [200, 200], proc.stderr[-4000:]
    root = runs / EXPERIMENT
    wrote = json.loads((root / "t_leak_1/attempt-1/artifacts/leak-view.json").read_text())
    seen = json.loads((root / "t_leak_2/attempt-1/artifacts/leak-view.json").read_text())
    stored = api.stored("t_leak_1")
    return {"harness": harness, "wrote": wrote, "seen": seen, "log": proc.stderr, "stored": stored}


def test_no_state_leaks_between_trials_in_the_image(leak_views):
    wrote, seen = leak_views["wrote"], leak_views["seen"]
    writable = {k for k, v in wrote["wrote"].items() if v == "written"}
    # The read-only root leaves only the trial folder and /dev/shm writable; there is no /runs.
    assert writable == {
        "trial_root", "home", "tmp", "harness", "state", "artifacts", "cwd", "dev_shm",
    }, wrote["wrote"]  # fmt: skip
    assert len(wrote["spawned"]) == 3
    # Trial 2 starts from an empty folder and sees nothing trial 1 left, anywhere it looks.
    assert seen["seen"] == dict.fromkeys(seen["seen"]), seen["seen"]
    assert seen["home"] == [] and seen["tmp"] == [] and seen["dev_shm"] == []
    assert not [p for p in seen["trial_listing"] if "leak" in p], seen["trial_listing"]
    # Every process trial 1 left is gone, including the one that cleared its environment.
    assert seen["sleepers"] == []
    assert "leftover process" in leak_views["log"]
    # The worker token is in the worker's environment only, and the trial cannot read it.
    assert seen["token"]["pids_with_token"] == []
    assert seen["token"]["pid1_environ_readable"] is False


def test_a_trial_cannot_see_earlier_trials_stored_files(leak_views):
    """Trial 1's files, its marker among them, went to the API, which stores them outside the
    container. Trial 2 has no /runs or any other shared volume to find them on, and trial 1 had
    nowhere to write that trial 2 could read (D2, D3)."""
    wrote, seen, stored = leak_views["wrote"], leak_views["seen"], leak_views["stored"]
    assert stored["artifacts/leak.txt"] == MARKER.encode()
    assert wrote["wrote"]["runs"] != "written", wrote["wrote"]
    assert seen["seen"]["runs"] is None
    assert seen["runs"] == {"exists": False}
    assert "/runs" not in seen["mounts"], seen["mounts"]
    assert not [m for m in seen["mounts"] if m.startswith("/runs")]


@pytest.mark.parametrize("harness", HARNESSES)
def test_killing_the_worker_container_mid_trial(harness, tmp_path):
    """docker kill mid-trial: no upload, no report and no attempt folder. A fresh container cleans
    nothing up (its /trial is a new tmpfs) and claims the next attempt."""
    img = image(harness)
    runs = api_runs(tmp_path)
    api = FakeWorkerApi(runs_dir=runs)
    cmd = FIXTURE_PY.format("scripted_adapter.py")
    slow = {"turns": [{"sleep_s": 60, "reply": "never sent", "model_calls": 0}]}
    quick = {"turns": [{"reply": "Your EMI is Rs 8,997.26.", "model_calls": 0}]}
    api.claims.append(make_claim(worker_spec(harness_options=slow), lease_s=3))
    name = f"sp3-kill-{harness}-{uuid.uuid4().hex[:6]}"
    try:
        docker("run", "-d", "--name", name, *worker_args(api, f"{name}-1", cmd), img)
        assert api.wait_for("heartbeat", 2, trial_id="t_test_0001", timeout_s=60), docker(
            "logs", name, check=False
        ).stderr[-3000:]
        docker("kill", name)
        time.sleep(0.3)  # a heartbeat already on the wire may still land
        beats = len(api.requests("heartbeat"))
        time.sleep(1.5)
        assert len(api.requests("heartbeat")) == beats
        assert api.reports() == [] and api.requests("upload") == []
        trial_runs = runs / EXPERIMENT / "t_test_0001"
        assert not trial_runs.exists() or not list(trial_runs.iterdir())

        api.claims.append(make_claim(worker_spec(attempt=2, harness_options=quick)))
        docker(
            "run", "--rm", *worker_args(api, f"{name}-2", cmd), img, "--max-trials", "1",
            timeout=120,
        )  # fmt: skip
    finally:
        docker("rm", "-f", name, check=False)
        api.close()
    (body,) = api.reports()
    assert (body["worker_id"], body["attempt"]) == (f"{name}-2", 2)
    assert body["runner_report"]["label"] == "agent"
    assert sorted(p.name for p in trial_runs.iterdir()) == ["attempt-2"]
    assert MARKER not in json.dumps(body)
