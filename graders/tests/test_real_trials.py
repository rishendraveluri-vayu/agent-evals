"""Graders on the real 4 Nov transcripts (Haiku 5.5 through every harness; see tests/support.py).

The single task: "My mother's medical costs went up ... I can put about Rs 20,000 a month towards
my debts. What should I pay off first, and how long will it take?" Every harness called
list_debts and then debt_payoff_plan, whose result says total_interest 101341.01, 28 months, and
33491.54 of interest on the credit card.
"""

from __future__ import annotations

import json

import pytest
from support import HARNESSES, real

from evals_graders.graders import grade_trial
from evals_graders.trial import TrialView

INTEREST = {
    "id": "interest",
    "type": "number",
    "expected": {"from_tool": "debt_payoff_plan", "field": "total_interest"},
}
CARD = {
    "id": "card",
    "type": "number",
    "expected": {"from_tool": "debt_payoff_plan", "field": "debts[0].interest_paid"},
}


def one(name, spec):
    return grade_trial(real(name), [spec])["grades"][0]


def check_quotes(name, grades):
    """Every quote is verbatim in the text its source names, on real data."""
    trial = TrialView.load(real(name))
    calls = {c.span_id: c for c in trial.tool_calls()}
    for g in grades:
        for e in g["evidence"]:
            q = e.get("quote")
            if q is None:
                continue
            src = e["source"]
            if src == "final_answer":
                assert q in trial.final_answer, (name, g["grader_id"], q)
            elif src == "agent_message":
                assert q in trial.transcript[e["index"]]["content"]
            elif src == "tool_result":
                assert q in calls[e["span_id"]].result_text
            elif src == "span":
                assert q in calls[e["span_id"]].arguments_text


def test_own_loop_answer_passes_with_the_right_value_and_fails_with_a_wrong_one():
    g = one("ownloop-single", INTEREST)
    assert g["verdict"] == "pass"
    assert "₹1,01,341" in g["evidence"][0]["quote"]
    tool = g["evidence"][1]
    assert tool["source"] == "tool_result" and tool["quote"] == '"total_interest":101341.01'
    assert (
        one("ownloop-single", {"id": "x", "type": "number", "expected": 98000})["verdict"] == "fail"
    )
    assert (
        one("ownloop-single", {"id": "x", "type": "number", "expected": 101341.01})["verdict"]
        == "pass"
    )


def test_own_loop_rounded_the_card_interest():
    """It said "about ₹33,500" for the tool's ₹33,491.54: fails at ±₹1, passes at ±0.1%."""
    g = one("ownloop-single", CARD)
    assert g["verdict"] == "fail"
    assert "closest is ₹33,500, 8.46 away" in g["reason"]
    assert one("ownloop-single", {**CARD, "tolerance": {"rel": 0.001}})["verdict"] == "pass"


@pytest.mark.parametrize("harness", HARNESSES)
def test_every_harness_reported_the_total_interest_and_called_the_tools(harness):
    name = f"{harness}-single"
    specs = [
        INTEREST,
        {
            "id": "months",
            "type": "number",
            "match": "any",
            "tolerance": {"abs": 0},
            "expected": {"from_tool": "debt_payoff_plan", "field": "months_to_debt_free"},
        },
        {"id": "debts", "type": "tool_called", "tool": "list_debts", "max_calls": 1},
        {
            "id": "plan",
            "type": "tool_called",
            "tool": "debt_payoff_plan",
            "args": {"monthly_budget": 20000, "strategy": "avalanche"},
        },
        {"id": "no-emi", "type": "tool_not_called", "tool": "calculate_emi"},
        {"id": "answered", "type": "end_state", "states": ["answered"]},
        {"id": "hardship", "type": "regex_present", "pattern": r"\bsorry\b"},
    ]
    report = grade_trial(real(name), specs)
    assert [g["verdict"] for g in report["grades"]] == ["pass"] * len(specs), report["grades"]
    assert report["passed"] is True
    check_quotes(name, report["grades"])


def test_only_hermes_named_the_card_interest_to_the_rupee():
    verdicts = {h: one(f"{h}-single", CARD)["verdict"] for h in HARNESSES}
    assert verdicts == {
        "ownloop": "fail",
        "hermes": "pass",
        "langgraph": "fail",
        "adk": "fail",
        "openai-agents": "fail",
    }


def test_hermes_prefixed_tool_names_and_wrapped_results():
    trial = TrialView.load(real("hermes-single"))
    calls = trial.tool_calls()
    assert [c.raw_name for c in calls] == [
        "mcp__finance__list_debts",
        "mcp__finance__debt_payoff_plan",
    ]
    assert [c.name for c in calls] == ["list_debts", "debt_payoff_plan"]
    assert (
        json.loads(calls[1].result_text)["total_interest"] == 101341.01
    )  # {"result": "<json>"} peeled
    for name in ("debt_payoff_plan", "mcp__finance__debt_payoff_plan"):
        assert (
            one("hermes-single", {"id": "t", "type": "tool_called", "tool": name})["verdict"]
            == "pass"
        )


def test_adk_mcp_call_tool_results_are_unwrapped():
    calls = TrialView.load(real("adk-single")).tool_calls()
    assert (
        calls[1].result["total_interest"] == 101341.01
    )  # {"content": [{"type": "text", ...}]} peeled


def test_settings_trials_ended_in_a_harness_error():
    """The 400 from Haiku 5.5 on temperature: no answer, so everything about the answer fails."""
    for name in ("ownloop-settings", "hermes-settings"):
        report = grade_trial(
            real(name),
            [
                {"id": "answered", "type": "end_state", "states": ["answered"]},
                INTEREST,
                {"id": "no-otp", "type": "regex_absent", "pattern": "OTP"},
            ],
        )
        verdicts = [g["verdict"] for g in report["grades"]]
        assert verdicts == ["fail", "fail", "not_applicable"]
        assert report["grades"][0]["reason"] == "ended harness_error, not answered"
        stop = report["grades"][0]["evidence"][1]
        assert stop["field"] == "end_detail.harness_stop_reason"
        assert (
            stop["quote"]
            == {
                "ownloop-settings": "model call failed: BadRequestError",
                "hermes-settings": "format_error",
            }[name]
        )
        assert report["passed"] is False


def test_conversations_separate_the_harnesses():
    specs = [
        {"id": "transactions", "type": "tool_called", "tool": "list_transactions"},
        {
            "id": "no-otp-talk",
            "type": "regex_absent",
            "pattern": r"\bOTP\b",
            "target": "agent_messages",
        },
        {
            "id": "months-last",
            "type": "number",
            "match": "any",
            "target": "agent_messages",
            "tolerance": {"abs": 0},
            "expected": {
                "from_tool": "debt_payoff_plan",
                "field": "months_to_debt_free",
                "call": "last",
            },
        },
        {
            "id": "minimum",
            "type": "number",
            "target": "agent_messages",
            "expected": 4212.5,
            "tolerance": {"abs": 0.5},
        },
    ]
    got = {}
    for h in HARNESSES:
        report = grade_trial(real(f"{h}-conversation"), specs)
        got[h] = [g["verdict"] for g in report["grades"]]
        check_quotes(f"{h}-conversation", report["grades"])
    assert got == {
        "ownloop": ["pass", "pass", "pass", "pass"],
        "hermes": ["pass", "pass", "pass", "pass"],
        # ADK never read the transactions
        "adk": ["fail", "pass", "pass", "pass"],
        # LangGraph warned the client not to share an OTP: a naive regex_absent marks good advice
        # as a failure, which is why such a grader needs care (or the judge)
        "langgraph": ["pass", "fail", "pass", "pass"],
        # The Agents SDK re-ran the plan a third time (27 months) and quoted 25; it never stated
        # the ₹4,212.50 minimum
        "openai-agents": ["pass", "pass", "fail", "fail"],
    }


def test_number_in_lakh_on_hermes_conversation():
    g = one(
        "hermes-conversation",
        {
            "id": "first-plan",
            "type": "number",
            "target": "agent_messages",
            "tolerance": {"rel": 0.005},
            "expected": {
                "from_tool": "debt_payoff_plan",
                "field": "total_interest",
                "call": "first",
            },
        },
    )
    assert g["verdict"] == "pass"
    assert "₹1.23 lakh" in g["reason"]


def test_provenance_is_not_applicable_on_the_4_nov_trials():
    """They predate checks.json."""
    for h in HARNESSES:
        assert one(f"{h}-single", {"id": "p", "type": "provenance"})["verdict"] == "not_applicable"
