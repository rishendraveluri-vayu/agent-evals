"""D36: the own loop on a cut-off reply, against the fake model's `length` fault.

A reply that stops at the output token cap (`finish_reason: length`) is re-sent once, the same
request with the cap doubled up to 8,192, with an `evals.token_cap_raised` event on the turn.
Cut off again, the turn ends as `token_limit`. `max_output_tokens` stays the first attempt's
cap. The re-send is a model call, so it needs a step left (D17).
"""

import pytest
from evals_adapter.gate import FakeServer
from evals_adapter.trace import attr_dict
from test_gate import GATE

FULL = (
    "Your EMI would be about Rs 8,997 a month for 20 years, and the total interest is about "
    "Rs 11.59 lakh."
)


@pytest.fixture(scope="module")
def fake():
    server = FakeServer()
    yield server
    server.stop()


def run(tmp_path, fake, script, **settings):
    result = GATE.run(tmp_path, fake, GATE.spec(tmp_path / "trial", script, fake, **settings))
    GATE.check_schemas(result)
    assert result.report["label"] == "agent", result.explain()
    return result


def cap_events(run_):
    (turn,) = run_.spans_named("agent.turn")
    events = [e for e in turn.get("events", []) if e["name"] == "evals.token_cap_raised"]
    return [attr_dict({"attributes": e.get("attributes", [])}) for e in events]


def sent_caps(run_):
    return [r["body"].get("max_tokens") for r in GATE.agent_requests(run_)]


def test_cut_off_reply_is_resent_once_with_the_cap_doubled(tmp_path, fake):
    result = run(tmp_path, fake, "finance-length", max_output_tokens=1024)
    assert result.result["end_state"] == "answered", result.explain()
    assert result.result["final_answer"] == FULL
    requests = GATE.agent_requests(result)
    assert [r["fault"] for r in requests] == [None, "length", None]
    assert sent_caps(result) == [1024, 1024, 2048]
    # The same request, apart from the cap: the cut reply is not kept in the conversation.
    second, third = requests[1]["body"], requests[2]["body"]
    assert second["messages"] == third["messages"]
    assert {k: v for k, v in second.items() if k != "max_tokens"} == {
        k: v for k, v in third.items() if k != "max_tokens"
    }
    assert cap_events(result) == [
        {"evals.token_cap.first": 1024, "evals.token_cap.raised": 2048, "evals.model_call.index": 2}
    ]
    assert result.result["counts"]["model_calls"] == 3
    # max_output_tokens means the first attempt's cap.
    assert result.result["applied_settings"]["max_output_tokens"]["value"] == 1024


def test_the_raised_cap_stops_at_8192(tmp_path, fake):
    result = run(tmp_path, fake, "finance-length", max_output_tokens=6000)
    assert result.result["end_state"] == "answered", result.explain()
    assert sent_caps(result) == [6000, 6000, 8192]
    assert cap_events(result)[0]["evals.token_cap.raised"] == 8192


def test_cut_off_again_ends_as_token_limit(tmp_path, fake):
    result = run(tmp_path, fake, "finance-length-always", max_output_tokens=1024)
    assert result.result["end_state"] == "token_limit", result.explain()
    assert sent_caps(result) == [1024, 1024, 2048]
    assert len(cap_events(result)) == 1
    detail = result.result["end_detail"]["harness_stop_reason"]
    assert detail == "length, again at the raised cap 2048", detail
    # The cut text is kept as the turn's reply, as before D36.
    assert result.result["final_answer"] == FULL[: -(-len(FULL) // 2)]


def test_no_resend_at_the_ceiling(tmp_path, fake):
    """At 8,192 the cap cannot be raised, so a re-send would be a plain retry (R10.11)."""
    result = run(tmp_path, fake, "finance-length", max_output_tokens=8192)
    assert result.result["end_state"] == "token_limit", result.explain()
    assert sent_caps(result) == [8192, 8192]
    assert cap_events(result) == []
    assert "not raisable" in result.result["end_detail"]["harness_stop_reason"]


def test_no_resend_without_a_step_left(tmp_path, fake):
    """The re-send is a model call (D17): at max_steps it is not made."""
    result = run(tmp_path, fake, "finance-length", max_output_tokens=1024, max_steps=2)
    assert result.result["end_state"] == "token_limit", result.explain()
    assert len(GATE.agent_requests(result)) == 2
    assert cap_events(result) == []
    assert "no step left" in result.result["end_detail"]["harness_stop_reason"]


def test_no_resend_when_no_cap_was_sent(tmp_path, fake):
    spec = GATE.spec(tmp_path / "trial", "finance-length", fake, max_output_tokens=None)
    spec["settings_sources"]["max_output_tokens"] = "harness_default"
    result = GATE.run(tmp_path, fake, spec)
    GATE.check_schemas(result)
    assert result.result["end_state"] == "token_limit", result.explain()
    assert sent_caps(result) == [None, None]
    assert cap_events(result) == []
