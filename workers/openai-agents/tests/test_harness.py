"""Checks specific to the Agents SDK adapter, beyond the shared gate: the D18 cases the gate does
not script (an unknown tool, a tool that reports an error), and tracing being off.

The fake server takes extra scripts at runtime (POST /_fake/scripts), so nothing outside this
folder changes.
"""

import json
import urllib.request

import pytest
from evals_adapter.gate import FakeServer
from evals_adapter.trace import attr_dict
from test_gate import GATE

from openai_agents_adapter.adapter import parse_error, tool_text


@pytest.fixture(scope="module")
def fake():
    server = FakeServer()
    yield server
    server.stop()


def register(fake: FakeServer, script: dict) -> None:
    req = urllib.request.Request(
        f"http://127.0.0.1:{fake.port}/_fake/scripts",
        data=json.dumps(script).encode(),
        method="POST",
        headers={"content-type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=5)  # noqa: S310


def text(content) -> str:
    """A message's content as text: a string, or a list of text parts (MCP results)."""
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content)


def error_events(run, kind: str) -> list[dict]:
    return [
        e
        for s in run.spans
        for e in s.get("events", [])
        if e["name"] == "evals.error" and attr_dict(e).get("evals.error.kind") == kind
    ]


def tool_messages(run, request_index: int) -> list[dict]:
    body = GATE.agent_requests(run)[request_index]["body"]
    return [m for m in body["messages"] if m.get("role") == "tool"]


def test_unknown_tool_goes_back_to_the_model(tmp_path, fake):
    """D18: tool_not_found_behavior returns the SDK's error to the model instead of raising."""
    register(
        fake,
        {
            "name": "oa-unknown-tool",
            "steps": [
                {"tool_calls": [{"name": "no_such_tool", "arguments": {}}]},
                {"text": "I could not use that tool, so here is my answer."},
            ],
        },
    )
    run = GATE.run(tmp_path, fake, GATE.spec(tmp_path / "trial", "oa-unknown-tool", fake))
    GATE.check_schemas(run)
    assert run.result["end_state"] == "answered", run.explain()
    assert len(error_events(run, "unknown_tool")) == 1
    (msg,) = tool_messages(run, 1)
    seen = text(msg["content"])
    assert seen == "Tool 'no_such_tool' not found.", seen
    (span,) = run.spans_named("execute_tool")
    attrs = attr_dict(span)
    assert attrs["gen_ai.tool.name"] == "no_such_tool"
    assert attrs["evals.tool.is_error"] is True
    assert attrs["evals.error.kind"] == "unknown_tool"
    assert attrs["evals.tool.result"] == seen
    assert run.result["counts"]["tool_errors"] == 1


def test_a_tool_error_reaches_the_model_unmasked(tmp_path, fake):
    """An MCP result flagged isError passes through as the server wrote it; only exceptions get
    the SDK's fixed text. The span carries the server's flag."""
    register(
        fake,
        {
            "name": "oa-tool-error",
            "steps": [
                {
                    "tool_calls": [
                        {
                            "name": "calculate_emi",
                            "arguments": {
                                "principal": 0,
                                "annual_rate_pct": 9,
                                "tenure_months": 240,
                            },
                        }
                    ]
                },
                {"text": "That loan amount does not work; please check it."},
            ],
        },
    )
    run = GATE.run(tmp_path, fake, GATE.spec(tmp_path / "trial", "oa-tool-error", fake))
    GATE.check_schemas(run)
    assert run.result["end_state"] == "answered", run.explain()
    (span,) = run.spans_named("execute_tool")
    attrs = attr_dict(span)
    assert attrs["evals.tool.is_error"] is True, attrs
    assert attrs["evals.error.kind"] == "tool_error"
    (msg,) = tool_messages(run, 1)
    seen = text(msg["content"])
    assert "An error occurred while running the tool" not in seen
    assert seen == attrs["evals.tool.result"]
    assert run.result["counts"]["malformed_tool_calls"] == 0


def test_importing_the_adapter_turns_tracing_off():
    """Nothing may go to api.openai.com: no spans are made and no exporter is registered."""
    from agents import trace
    from agents.tracing import get_trace_provider

    import openai_agents_adapter.adapter  # noqa: F401

    assert type(trace("probe")).__name__ == "NoOpTrace"
    assert tuple(get_trace_provider()._multi_processor._processors) == ()


def test_tool_text_and_parse_error():
    assert tool_text("plain") == "plain"
    assert tool_text({"type": "text", "text": "a"}) == "a"
    assert tool_text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "a\nb"
    assert parse_error('{"a": 1}') is None
    assert parse_error("") is None
    assert parse_error('{"a": 1') is not None
    assert parse_error("[1]") == "not a JSON object"
