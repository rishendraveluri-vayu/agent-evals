"""Hermes's gate tests (contract v2 section 8), against the fake model server.

The adapter runs on Hermes's own environment. Point HERMES_SRC at a checkout of the pinned SHA
with `uv sync --locked --extra mcp` done (scripts/setup_hermes.sh does both); the tests skip
without one.
"""

import json
import os
import subprocess
from pathlib import Path

import pytest
from evals_adapter.gate import FakeServer, Gate

HERE = Path(__file__).resolve().parents[1]
REPO = HERE.parents[1]
HERMES_SRC = Path(os.environ.get("HERMES_SRC", HERE / ".hermes-agent"))
HERMES_PY = HERMES_SRC / ".venv" / "bin" / "python"
PINNED = "6112c2adb9e11f69734a29be9d2696f345ffa06a"

pytestmark = pytest.mark.skipif(not HERMES_PY.exists(), reason=f"no Hermes env at {HERMES_SRC}")

CAPS = json.loads((HERE / "src" / "hermes_adapter" / "capabilities.json").read_text())
GATE = Gate(
    harness="hermes",
    adapter_cmd=[str(HERMES_PY), "-m", "hermes_adapter.adapter"],
    capabilities=CAPS,
    tool_name=lambda name: f"mcp__finance__{name}",
    env={"PYTHONPATH": f"{HERE / 'src'}:{REPO / 'workers' / 'adapterlib' / 'src'}"},
)


@pytest.fixture(scope="module")
def fake():
    server = FakeServer()
    yield server
    server.stop()


def test_checkout_is_the_pinned_sha_and_clean():
    head = subprocess.run(
        ["git", "-C", str(HERMES_SRC), "rev-parse", "HEAD"], capture_output=True, text=True
    )
    assert head.stdout.strip() == PINNED
    dirty = subprocess.run(
        ["git", "-C", str(HERMES_SRC), "status", "--porcelain", "--untracked-files=no"],
        capture_output=True,
        text=True,
    )
    assert dirty.stdout.strip() == ""


def test_answer(tmp_path, fake):
    GATE.test_answer(tmp_path, fake)


def test_settings(tmp_path, fake):
    GATE.test_settings(tmp_path, fake)


def test_steps(tmp_path, fake):
    GATE.test_steps(tmp_path, fake)


def test_tools(tmp_path, fake):
    GATE.test_tools(tmp_path, fake)


def test_timeout(tmp_path, fake):
    GATE.test_timeout(tmp_path, fake)


def test_malformed_tool_call(tmp_path, fake):
    GATE.test_malformed_tool_call(tmp_path, fake)


def test_no_harness_retries(tmp_path, fake):
    GATE.test_no_harness_retries(tmp_path, fake)


def test_conversation(tmp_path, fake):
    GATE.test_conversation(tmp_path, fake)
