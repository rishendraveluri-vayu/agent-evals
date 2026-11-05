"""The langgraph gate tests (contract v2 section 8), against the fake model server.

They skip until IMPLEMENTED is True in src/langgraph_adapter/adapter.py. Needs `uv sync` once in
services/fake-llm and services/finance-mcp.
"""

import json
import sys
from pathlib import Path

import pytest
from evals_adapter.gate import NO_CALCULATOR_TOOLS, FakeServer, Gate
from langgraph_adapter.adapter import IMPLEMENTED

CAPS_FILE = Path(__file__).resolve().parents[1] / "src" / "langgraph_adapter" / "capabilities.json"
CAPS = json.loads(CAPS_FILE.read_text())
GATE = Gate(
    harness="langgraph",
    adapter_cmd=[sys.executable, "-m", "langgraph_adapter.adapter"],
    capabilities=CAPS,
    # langchain-mcp-adapters keeps the server's tool names (tool_name_prefix is off).
    tool_name=lambda name: name,
    # D18: with only malformed tool calls in a reply, LangGraph's router ends the run, so the
    # error never reaches the model. The adapter labels the run agent_error (known_differences).
    malformed_ends_in="agent_error",
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


def test_tools_without_calculators(tmp_path, fake):
    """D70's finance-no-calculators: only its 11 tools reach the model."""
    GATE.test_tools(tmp_path, fake, NO_CALCULATOR_TOOLS, "finance-no-calculators")


def test_timeout(tmp_path, fake):
    GATE.test_timeout(tmp_path, fake)


def test_malformed_tool_call(tmp_path, fake):
    GATE.test_malformed_tool_call(tmp_path, fake)


def test_no_harness_retries(tmp_path, fake):
    GATE.test_no_harness_retries(tmp_path, fake)


def test_conversation(tmp_path, fake):
    GATE.test_conversation(tmp_path, fake)
