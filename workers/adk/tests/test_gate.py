"""The ADK gate tests (contract v2 section 8), against the fake model server.

Needs `uv sync` once in services/fake-llm and services/finance-mcp.
"""

import json
import sys
from pathlib import Path

import pytest
from evals_adapter.gate import FakeServer, Gate

# The tests never import adk_adapter: importing it clears provider, ADK and LiteLLM variables
# from os.environ (it is the trial process's entry point), which would hide LITELLM_MASTER_KEY
# from the proxy tests.

CAPS_FILE = Path(__file__).resolve().parents[1] / "src" / "adk_adapter" / "capabilities.json"
CAPS = json.loads(CAPS_FILE.read_text())
GATE = Gate(
    harness="adk",
    adapter_cmd=[sys.executable, "-m", "adk_adapter.adapter"],
    capabilities=CAPS,
    # ADK keeps MCP tool names as they are (no tool_name_prefix is set).
    tool_name=lambda name: name,
    # ADK fences every MCP tool and parameter description; D20 keeps it. Declared exactly here
    # and in capabilities.json known_differences.
    description_wrapper=(
        "<<<BEGIN_UNTRUSTED_TOOL_DESCRIPTION>>>\n",
        "\n<<<END_UNTRUSTED_TOOL_DESCRIPTION>>>",
    ),
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
