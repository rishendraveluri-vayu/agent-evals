"""The openai-agents gate tests (contract v2 section 8), against the fake model server.

They skip until IMPLEMENTED is True in src/openai_agents_adapter/adapter.py. Needs `uv sync` once in
services/fake-llm and services/finance-mcp.
"""

import json
import sys
from pathlib import Path

import pytest
from evals_adapter.gate import FakeServer, Gate

from openai_agents_adapter.adapter import IMPLEMENTED

CAPS_FILE = (
    Path(__file__).resolve().parents[1] / "src" / "openai_agents_adapter" / "capabilities.json"
)
CAPS = json.loads(CAPS_FILE.read_text())
GATE = Gate(
    harness="openai-agents",
    adapter_cmd=[sys.executable, "-m", "openai_agents_adapter.adapter"],
    capabilities=CAPS,
    # If the harness renames MCP tools, say how, e.g. lambda n: f"mcp__finance__{n}".
    tool_name=lambda name: name,
)

pytestmark = pytest.mark.skipif(not IMPLEMENTED, reason="adapter not implemented yet")


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
