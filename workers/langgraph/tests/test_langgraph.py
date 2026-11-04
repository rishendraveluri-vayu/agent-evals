"""LangGraph's own tool-error paths (D18), beyond the shared gate, against the fake model server.

Each test registers a fake script at run time, runs one trial through the adapter, and checks
what reached the model and how the trace and counts report it. They pin the findings in the
README, so a LangGraph upgrade that changes one fails here.
"""

import json
import urllib.request

import pytest
from evals_adapter.gate import FakeServer
from evals_adapter.trace import attr_dict
from langgraph_adapter.adapter import IMPLEMENTED
from test_gate import GATE

pytestmark = pytest.mark.skipif(not IMPLEMENTED, reason="adapter not implemented yet")

EMI = {"principal": 1000000, "annual_rate_pct": 9, "tenure_months": 240}


@pytest.fixture(scope="module")
def fake():
    server = FakeServer()
    yield server
    server.stop()


def register(fake, name: str, steps: list[dict]) -> None:
    body = json.dumps({"name": name, "steps": steps}).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{fake.port}/_fake/scripts",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310
        assert resp.status in (200, 201)


def tool_messages(request: dict) -> list[dict]:
    return [m for m in request["body"]["messages"] if m.get("role") == "tool"]


def test_malformed_beside_a_valid_call_goes_back_in_langchains_words(tmp_path, fake):
    """With a valid call in the same reply the loop goes on, and LangChain answers the
    malformed one itself at the next model call (factory._patch_invalid_tool_calls)."""
    register(
        fake,
        "lg-mixed",
        [
            {
                "tool_calls": [
                    {"name": "calculate_emi", "arguments": '{"principal": 1000000'},
                    {"name": "calculate_emi", "arguments": EMI},
                ]
            },
            {"text": "Your EMI would be about Rs 8,997 a month."},
        ],
    )
    run = GATE.run(tmp_path, fake, GATE.spec(tmp_path / "trial", "lg-mixed", fake))
    GATE.check_schemas(run)
    assert run.result["end_state"] == "answered", run.explain()
    assert run.result["counts"]["malformed_tool_calls"] == 1
    assert run.result["counts"]["tool_calls"] == 2
    second = GATE.agent_requests(run)[1]
    texts = sorted(json.dumps(m["content"]) for m in tool_messages(second))
    assert len(texts) == 2
    assert any("arguments were malformed or truncated" in t for t in texts), texts
    assert any("8997.26" in t for t in texts), texts
    spans = {attr_dict(s)["evals.tool.is_error"]: attr_dict(s) for s in run.spans_named("execute")}
    assert spans[True]["evals.error.kind"] == "malformed_tool_call"
    assert "malformed or truncated" in spans[True]["evals.tool.result"]


def test_unknown_tool_goes_back_to_the_model(tmp_path, fake):
    register(
        fake,
        "lg-unknown",
        [
            {"tool_calls": [{"name": "no_such_tool", "arguments": {}}]},
            {"text": "I cannot look that up."},
        ],
    )
    run = GATE.run(tmp_path, fake, GATE.spec(tmp_path / "trial", "lg-unknown", fake))
    GATE.check_schemas(run)
    assert run.result["end_state"] == "answered", run.explain()
    (msg,) = tool_messages(GATE.agent_requests(run)[1])
    assert "no_such_tool is not a valid tool" in json.dumps(msg["content"])
    (span,) = run.spans_named("execute_tool")
    assert attr_dict(span)["evals.error.kind"] == "unknown_tool"
    assert run.result["counts"]["tool_errors"] == 1


def test_tool_error_from_the_server_goes_back_to_the_model(tmp_path, fake):
    """A finance-server error (isError) comes back as an error ToolMessage, not an exception."""
    register(
        fake,
        "lg-tool-error",
        [
            {"tool_calls": [{"name": "calculate_emi", "arguments": {**EMI, "principal": -5}}]},
            {"text": "The principal has to be positive."},
        ],
    )
    run = GATE.run(tmp_path, fake, GATE.spec(tmp_path / "trial", "lg-tool-error", fake))
    GATE.check_schemas(run)
    assert run.result["end_state"] == "answered", run.explain()
    assert len(tool_messages(GATE.agent_requests(run)[1])) == 1
    (span,) = run.spans_named("execute_tool")
    assert attr_dict(span)["evals.tool.is_error"] is True
    assert attr_dict(span)["evals.error.kind"] == "tool_error"


def test_tool_results_reach_the_model_as_text_parts(tmp_path, fake):
    run = GATE.run(tmp_path, fake, GATE.spec(tmp_path / "trial", "finance-emi", fake))
    (msg,) = tool_messages(GATE.agent_requests(run)[1])
    assert isinstance(msg["content"], list) and msg["content"][0]["type"] == "text"
    assert "8997.26" in msg["content"][0]["text"]


def test_the_harness_keeps_its_own_record_of_the_conversation(tmp_path, fake):
    run = GATE.run(tmp_path, fake, GATE.spec(tmp_path / "trial", "finance-emi", fake))
    assert "artifacts/langgraph-messages.json" in run.result["artifacts"]
    saved = json.loads((run.trial_dir / "out/artifacts/langgraph-messages.json").read_text())
    assert [m["type"] for m in saved] == ["human", "ai", "tool", "ai"]
    assert run.result["applied_settings"]["recursion_limit"]["value"] == 9999
