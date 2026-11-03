"""The gate through LiteLLM: the runner makes the trial's keys, LiteLLM routes fake/* to the
compose fake, and the model calls in the trace come from LiteLLM's records (R10.9).

Needs the compose stack up and EVALS_PROXY_URL=http://127.0.0.1:4000 plus LITELLM_MASTER_KEY.
"""

import pytest
from evals_adapter.gate import proxy_gate
from evals_adapter.trace import attr_dict
from test_gate import GATE

PROXY = proxy_gate(GATE)
pytestmark = pytest.mark.skipif(PROXY is None, reason="EVALS_PROXY_URL or LITELLM_MASTER_KEY unset")


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


def test_conversation_through_litellm(tmp_path):
    run = PROXY.test_conversation(tmp_path, None)
    PROXY.check_proxy_records(run)
    sim_chats = [s for s in run.spans_named("chat ") if attr_dict(s)["evals.role"] == "sim"]
    sim_turns = {s["spanId"] for s in run.spans_named("client_sim.turn")}
    assert len(sim_chats) == 3 and all(s["parentSpanId"] in sim_turns for s in sim_chats)
