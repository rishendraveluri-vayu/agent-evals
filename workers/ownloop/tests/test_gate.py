"""The own loop's gate tests (contract v2 section 8), against the fake model server."""

import json
import sys
from pathlib import Path

import pytest
from evals_adapter.gate import FakeServer, Gate

CAPS_FILE = Path(__file__).resolve().parents[1] / "src" / "ownloop" / "capabilities.json"
CAPS = json.loads(CAPS_FILE.read_text())
GATE = Gate(
    harness="ownloop", adapter_cmd=[sys.executable, "-m", "ownloop.adapter"], capabilities=CAPS
)


@pytest.fixture(scope="module")
def fake():
    server = FakeServer()
    yield server
    server.stop()


def test_answer(tmp_path, fake):
    GATE.test_answer(tmp_path, fake)


def test_settings(tmp_path, fake):
    GATE.test_settings(tmp_path, fake)


def test_unset_not_sent(tmp_path, fake):
    GATE.test_unset_not_sent(tmp_path, fake)


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
