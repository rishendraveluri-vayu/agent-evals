"""The gate through LiteLLM: the runner makes the trial's keys, LiteLLM routes fake/* to the
compose fake, and the model calls in the trace come from LiteLLM's records (R10.9).

Needs the compose stack up and EVALS_PROXY_URL=http://127.0.0.1:4000 plus LITELLM_MASTER_KEY.
Only fake/* models, so nothing is spent.
"""

import hashlib

import pytest
from evals_adapter.gate import proxy_gate
from evals_adapter.invariance import diff_trials
from evals_adapter.trace import attr_dict
from langgraph_adapter.adapter import IMPLEMENTED
from test_gate import GATE

PROXY = proxy_gate(GATE)
pytestmark = [
    pytest.mark.skipif(not IMPLEMENTED, reason="adapter not implemented yet"),
    pytest.mark.skipif(PROXY is None, reason="EVALS_PROXY_URL or LITELLM_MASTER_KEY unset"),
]


def test_answer_through_litellm(tmp_path):
    run = PROXY.test_answer(tmp_path, None)
    PROXY.check_proxy_records(run)
    # No hidden calls: LiteLLM saw exactly the calls LangGraph made.
    assert run.report["proxy_usage"]["model_calls"] == 2 == run.result["counts"]["model_calls"]


def test_settings_through_litellm(tmp_path):
    run = PROXY.test_settings(tmp_path, None)
    PROXY.check_proxy_records(run)
    for chat in run.spans_named("chat "):
        assert attr_dict(chat)["gen_ai.request.temperature"] == 0.37
        # LangChain sends the cap as max_completion_tokens; LiteLLM's record still shows it.
        assert attr_dict(chat)["gen_ai.request.max_tokens"] == 777


def test_steps_through_litellm(tmp_path):
    run = PROXY.test_steps(tmp_path, None)
    PROXY.check_proxy_records(run)
    # The error-mode limit stops before the next call: no extra call at the limit.
    assert run.report["proxy_usage"]["model_calls"] == 3 == run.result["counts"]["model_calls"]


def test_malformed_call_ends_the_run_with_no_hidden_call(tmp_path):
    run = PROXY.test_malformed_tool_call(tmp_path, None)
    PROXY.check_proxy_records(run)
    assert run.report["proxy_usage"]["model_calls"] == 1


def test_conversation_through_litellm(tmp_path):
    run = PROXY.test_conversation(tmp_path, None)
    PROXY.check_proxy_records(run)
    sim_chats = [s for s in run.spans_named("chat ") if attr_dict(s)["evals.role"] == "sim"]
    sim_turns = {s["spanId"] for s in run.spans_named("client_sim.turn")}
    assert len(sim_chats) == 3 and all(s["parentSpanId"] in sim_turns for s in sim_chats)


def test_prompt_change_is_the_only_difference_in_the_first_request(tmp_path):
    """The invariance diff on real stored requests: prompt v1 vs v2, nothing else changed."""
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
