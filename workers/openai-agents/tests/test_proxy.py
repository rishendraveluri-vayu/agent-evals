"""The Agents SDK gate through LiteLLM: the runner makes the trial's keys, LiteLLM routes fake/*
to the compose fake, and the model calls in the trace come from LiteLLM's records (R10.9).
Copied from workers/ownloop/tests/test_proxy.py; the Agents SDK additions say so.

Needs the compose stack up and EVALS_PROXY_URL=http://127.0.0.1:4000 plus LITELLM_MASTER_KEY.
"""

import pytest
from evals_adapter.gate import proxy_gate
from evals_adapter.trace import attr_dict
from test_gate import GATE

from openai_agents_adapter.adapter import IMPLEMENTED

PROXY = proxy_gate(GATE)
pytestmark = [
    pytest.mark.skipif(PROXY is None, reason="EVALS_PROXY_URL or LITELLM_MASTER_KEY unset"),
    pytest.mark.skipif(not IMPLEMENTED, reason="adapter not implemented yet"),
]


def test_answer_through_litellm(tmp_path):
    run = PROXY.test_answer(tmp_path, None)
    PROXY.check_proxy_records(run)
    assert run.report["proxy_usage"]["model_calls"] == 2


def test_settings_through_litellm(tmp_path):
    run = PROXY.test_settings(tmp_path, None)
    PROXY.check_proxy_records(run)
    for chat in run.spans_named("chat "):
        assert attr_dict(chat)["gen_ai.request.temperature"] == 0.37


def test_steps_through_litellm(tmp_path):
    run = PROXY.test_steps(tmp_path, None)
    PROXY.check_proxy_records(run)
    # The proxy counts every call, including any the harness does not count itself.
    assert run.report["proxy_usage"]["model_calls"] >= run.result["counts"]["model_calls"]
    # Agents SDK: max_turns is exact. No extra call at the limit, no hidden client retry.
    assert run.report["proxy_usage"]["model_calls"] == run.result["counts"]["model_calls"] == 3


def test_malformed_tool_call_through_litellm(tmp_path):
    """Agents SDK: the masked error text survives LiteLLM unchanged, and nothing is retried."""
    run = PROXY.test_malformed_tool_call(tmp_path, None)
    PROXY.check_proxy_records(run)
    assert run.report["proxy_usage"]["model_calls"] == run.result["counts"]["model_calls"] == 3
    second = PROXY.agent_requests(run)[1]["body"]["messages"]
    (tool,) = [m for m in second if m.get("role") == "tool"]
    assert tool["content"] == "An error occurred while running the tool. Please try again."


def test_no_harness_retries_through_litellm(tmp_path):
    """R10.11 with D16: one harness request for the 429, LiteLLM's retries behind it."""
    PROXY.test_no_harness_retries(tmp_path, None)


@pytest.mark.parametrize("script", ["finance-429-twice", "finance-503-twice"])
def test_litellm_retry_recovers(tmp_path, script):
    PROXY.test_proxy_retry_recovers(tmp_path, script)


def test_litellm_retries_run_out(tmp_path):
    PROXY.test_proxy_retries_run_out(tmp_path)


def test_litellm_does_not_retry_a_400(tmp_path):
    PROXY.test_proxy_no_retry_on_400(tmp_path)


def test_conversation_through_litellm(tmp_path):
    run = PROXY.test_conversation(tmp_path, None)
    PROXY.check_proxy_records(run)
    sim_chats = [s for s in run.spans_named("chat ") if attr_dict(s)["evals.role"] == "sim"]
    sim_turns = {s["spanId"] for s in run.spans_named("client_sim.turn")}
    assert len(sim_chats) == 3 and all(s["parentSpanId"] in sim_turns for s in sim_chats)


def test_prompt_change_is_the_only_difference_in_the_first_request(tmp_path):
    """The invariance diff on real stored requests: prompt v1 vs v2, nothing else changed."""
    import hashlib

    from evals_adapter.gate import FakeServer  # noqa: F401 - proxy mode needs no local fake
    from evals_adapter.invariance import diff_trials

    trials = {}
    for version, text in (("v1", "Be kind."), ("v2", "Be kind, and ask before you calculate.")):
        d = tmp_path / version
        spec = PROXY.spec(d / "trial", "finance-emi", None)
        spec["system_prompt"] = {
            "id": "finance-advisor",
            "version": version,
            "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "text": text,
        }
        run = PROXY.run(d, None, spec)
        assert run.result["end_state"] == "answered", run.explain()
        trials[version] = run.trial_dir
    diffs = diff_trials(trials["v1"], trials["v2"], "system_prompt")
    assert diffs, "the prompt change did not reach the request"
    assert [d.path for d in diffs if not d.on_axis] == [], [d.path for d in diffs]
    assert any("ask before you calculate" in line for d in diffs for line in d.lines) or any(
        "ask before you calculate" in str(d.b) for d in diffs
    )
