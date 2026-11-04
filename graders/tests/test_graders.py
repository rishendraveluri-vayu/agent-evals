"""Every grader type against a known pass and a known fail, on synthetic trial folders."""

from __future__ import annotations

import json

import pytest
from support import EMI_ARGS, EMI_RESULT, make_trial

from evals_graders import FRAMEWORK_VERSION
from evals_graders.canonical import grader_version, spec_sha256
from evals_graders.graders import args_match, grade_trial, outcome


def grade(out, *specs, task_dir=None):
    return grade_trial(out, list(specs), task_dir=task_dir)


def one(out, spec, task_dir=None):
    return grade(out, spec, task_dir=task_dir)["grades"][0]


def assert_quotes_verbatim(out, g):
    """Every quote is a substring of the text its source names."""
    result = json.loads((out / "result.json").read_text())
    texts = {"final_answer": result["final_answer"] or ""}
    for item in g["evidence"]:
        if "quote" not in item:
            continue
        if item["source"] == "final_answer":
            assert item["quote"] in texts["final_answer"], item
        elif item["source"] == "agent_message":
            assert (
                item["quote"] in result["conversation"]["transcript"][item["index"]]["content"]
            ), item


EMI_ANSWER = (
    "I'm sorry to hear that. Your EMI is ₹8,997 a month,"
    " and over 20 years you pay about ₹11.59 lakh in interest."
)


# ---- number ----


def test_number_literal_pass_and_fail(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER)
    g = one(out, {"id": "emi", "type": "number", "expected": 8997.26})
    assert g["verdict"] == "pass" and g["score"] == 1.0
    assert g["evidence"][0]["source"] == "final_answer"
    assert "₹8,997" in g["evidence"][0]["quote"]
    assert_quotes_verbatim(out, g)

    g = one(out, {"id": "emi", "type": "number", "expected": 9500})
    assert g["verdict"] == "fail" and g["score"] == 0.0
    assert "closest is ₹8,997" in g["reason"]


def test_number_from_tool_pass_and_wrong_value_fails(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER, [("calculate_emi", EMI_ARGS, EMI_RESULT)])
    g = one(
        out,
        {"id": "emi", "type": "number", "expected": {"from_tool": "calculate_emi", "field": "emi"}},
    )
    assert g["verdict"] == "pass"
    tool_ev = [e for e in g["evidence"] if e["source"] == "tool_result"][0]
    assert tool_ev["quote"] == '"emi": 8997.26' and tool_ev["span_id"] == "0000000000000001"

    # lakh is read as a number: ₹11.59 lakh = 11,59,000, within 0.1% of the tool's 11,59,342.40
    g = one(
        out,
        {
            "id": "int",
            "type": "number",
            "expected": {"from_tool": "calculate_emi", "field": "total_interest"},
            "tolerance": {"rel": 0.001},
        },
    )
    assert g["verdict"] == "pass"
    g = one(
        out,
        {
            "id": "int",
            "type": "number",
            "expected": {"from_tool": "calculate_emi", "field": "total_interest"},
        },
    )
    assert g["verdict"] == "fail"  # ±₹1 is too tight for a rounded lakh figure

    wrong = make_trial(
        tmp_path / "wrong", "Your EMI is ₹9,200 a month.", [("calculate_emi", EMI_ARGS, EMI_RESULT)]
    )
    g = one(
        wrong,
        {"id": "emi", "type": "number", "expected": {"from_tool": "calculate_emi", "field": "emi"}},
    )
    assert g["verdict"] == "fail" and "₹9,200" in g["reason"]


def test_number_from_tool_fails_when_the_tool_was_never_called(tmp_path):
    """Review note 21: an EMI the agent worked out itself has no tool value behind it."""
    out = make_trial(tmp_path, "Your EMI is ₹8,997 a month.")
    g = one(
        out,
        {"id": "emi", "type": "number", "expected": {"from_tool": "calculate_emi", "field": "emi"}},
    )
    assert g["verdict"] == "fail"
    assert "calculate_emi was never called" in g["reason"]


def test_number_call_choice_and_nested_fields(tmp_path):
    first = {"debts": [{"name": "Card", "interest_paid": 100.0}], "months": 10}
    last = {"debts": [{"name": "Card", "interest_paid": 250.0}], "months": 12}
    out = make_trial(
        tmp_path,
        "Card interest comes to ₹250.",
        [("debt_payoff_plan", {}, first), ("debt_payoff_plan", {}, last)],
    )
    base = {
        "id": "x",
        "type": "number",
        "expected": {"from_tool": "debt_payoff_plan", "field": "debts[0].interest_paid"},
    }
    assert one(out, base)["verdict"] == "pass"  # any call
    assert one(out, {**base, "expected": {**base["expected"], "call": "last"}})["verdict"] == "pass"
    assert (
        one(out, {**base, "expected": {**base["expected"], "call": "first"}})["verdict"] == "fail"
    )
    dotted = {
        **base,
        "expected": {
            "from_tool": "debt_payoff_plan",
            "field": "debts.0.interest_paid",
            "call": "last",
        },
    }
    assert one(out, dotted)["verdict"] == "pass"


def test_number_any_match_reads_plain_numbers(tmp_path):
    out = make_trial(
        tmp_path,
        "You will be debt-free in 28 months.",
        [("debt_payoff_plan", {}, {"months_to_debt_free": 28})],
    )
    spec = {
        "id": "m",
        "type": "number",
        "expected": {"from_tool": "debt_payoff_plan", "field": "months_to_debt_free"},
    }
    assert one(out, spec)["verdict"] == "fail"  # 28 is not a rupee amount
    assert one(out, {**spec, "match": "any"})["verdict"] == "pass"


def test_number_with_no_final_answer_fails(tmp_path):
    out = make_trial(tmp_path, None, end_state="step_limit")
    assert one(out, {"id": "emi", "type": "number", "expected": 8997})["verdict"] == "fail"


def test_number_over_agent_messages_finds_an_earlier_reply(tmp_path):
    out = make_trial(tmp_path, "Shall I set up a reminder?", earlier=["Your EMI is ₹8,997."])
    assert one(out, {"id": "e", "type": "number", "expected": 8997})["verdict"] == "fail"
    g = one(out, {"id": "e", "type": "number", "expected": 8997, "target": "agent_messages"})
    assert g["verdict"] == "pass"
    assert g["evidence"][0] == {
        "source": "agent_message",
        "index": 1,
        "quote": "Your EMI is ₹8,997.",
    }


# ---- tool_called / tool_not_called ----


def test_tool_called_with_args_and_counts(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER, [("calculate_emi", EMI_ARGS, EMI_RESULT)])
    g = one(
        out,
        {
            "id": "t",
            "type": "tool_called",
            "tool": "calculate_emi",
            "args": {"principal": 1000000, "annual_rate_pct": 9.0},
        },
    )
    assert g["verdict"] == "pass"
    assert g["evidence"][0]["span_id"] == "0000000000000001"
    assert json.loads(g["evidence"][0]["quote"]) == EMI_ARGS

    g = one(
        out,
        {
            "id": "t",
            "type": "tool_called",
            "tool": "calculate_emi",
            "args": {"annual_rate_pct": 8.5},
        },
    )
    assert g["verdict"] == "fail" and "1 time(s), but 0 matched" in g["reason"]
    g = one(out, {"id": "t", "type": "tool_called", "tool": "debt_payoff_plan"})
    assert g["verdict"] == "fail" and "tools called: calculate_emi" in g["reason"]


def test_tool_called_max_calls_catches_a_loop(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER, [("calculate_emi", EMI_ARGS, EMI_RESULT)] * 4)
    assert (
        one(out, {"id": "t", "type": "tool_called", "tool": "calculate_emi", "max_calls": 4})[
            "verdict"
        ]
        == "pass"
    )
    g = one(out, {"id": "t", "type": "tool_called", "tool": "calculate_emi", "max_calls": 3})
    assert g["verdict"] == "fail" and "4 times, more than the 3 allowed" in g["reason"]
    assert (
        one(out, {"id": "t", "type": "tool_called", "tool": "calculate_emi", "min_calls": 5})[
            "verdict"
        ]
        == "fail"
    )


def test_tool_called_successful_ignores_errored_calls(tmp_path):
    out = make_trial(
        tmp_path,
        "x",
        [("calculate_emi", {"principal": -1}, {"error": "principal must be positive"}, True)],
    )
    assert (
        one(out, {"id": "t", "type": "tool_called", "tool": "calculate_emi"})["verdict"] == "pass"
    )
    assert (
        one(out, {"id": "t", "type": "tool_called", "tool": "calculate_emi", "successful": True})[
            "verdict"
        ]
        == "fail"
    )


def test_hermes_prefixed_names_match_either_way(tmp_path):
    out = make_trial(
        tmp_path,
        EMI_ANSWER,
        [("mcp__finance__calculate_emi", EMI_ARGS, {"result": json.dumps(EMI_RESULT)})],
    )
    for name in ("calculate_emi", "mcp__finance__calculate_emi"):
        assert one(out, {"id": "t", "type": "tool_called", "tool": name})["verdict"] == "pass"
    # and the wrapped result is unwrapped for from_tool
    g = one(
        out,
        {"id": "n", "type": "number", "expected": {"from_tool": "calculate_emi", "field": "emi"}},
    )
    assert g["verdict"] == "pass"
    assert any(e.get("quote") == '"emi": 8997.26' for e in g["evidence"])
    g = one(out, {"id": "t", "type": "tool_not_called", "tool": "calculate_emi"})
    assert g["verdict"] == "fail"


def test_tool_not_called_pass_and_args_scoped(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER, [("calculate_emi", EMI_ARGS, EMI_RESULT)])
    assert (
        one(out, {"id": "t", "type": "tool_not_called", "tool": "loan_affordability"})["verdict"]
        == "pass"
    )
    assert (
        one(
            out,
            {
                "id": "t",
                "type": "tool_not_called",
                "tool": "calculate_emi",
                "args": {"tenure_months": 120},
            },
        )["verdict"]
        == "pass"
    )
    assert (
        one(
            out,
            {
                "id": "t",
                "type": "tool_not_called",
                "tool": "calculate_emi",
                "args": {"tenure_months": 240},
            },
        )["verdict"]
        == "fail"
    )


def test_args_match_rules():
    tol = {"abs": 1e-6}
    assert args_match({"a": 1}, {"a": 1.0, "b": 2}, tol)
    assert args_match({"a": 20000}, {"a": "20,000"}, tol)  # a number sent as a string
    assert args_match({"s": "Avalanche"}, {"s": " avalanche "}, tol)
    assert not args_match({"a": 1}, {"b": 1}, tol)
    assert args_match({"d": [{"x": 1}, {"x": 2}]}, {"d": [{"x": 1, "y": 0}, {"x": 2}]}, tol)
    assert not args_match({"d": [{"x": 1}]}, {"d": [{"x": 1}, {"x": 2}]}, tol)
    assert not args_match({"flag": True}, {"flag": 1}, tol)
    assert args_match({"r": 9}, {"r": 9.004}, {"abs": 0.01})


# ---- regex ----


def test_regex_present_and_absent(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER)
    g = one(out, {"id": "r", "type": "regex_present", "pattern": r"\bsorry\b"})
    assert g["verdict"] == "pass"
    assert_quotes_verbatim(out, g)
    assert (
        one(
            out,
            {"id": "r", "type": "regex_present", "pattern": r"\bSORRY\b", "case_sensitive": True},
        )["verdict"]
        == "fail"
    )
    assert (
        one(out, {"id": "r", "type": "regex_present", "pattern": "condolences"})["verdict"]
        == "fail"
    )

    assert one(out, {"id": "r", "type": "regex_absent", "pattern": r"\bOTP\b"})["verdict"] == "pass"
    g = one(out, {"id": "r", "type": "regex_absent", "pattern": "emi"})
    assert g["verdict"] == "fail" and g["evidence"][0]["source"] == "final_answer"
    assert_quotes_verbatim(out, g)


def test_regex_targets(tmp_path):
    out = make_trial(
        tmp_path,
        "Here is your plan.",
        [("calculate_emi", {"principal": 1000000, "note": "PAN ABCDE1234F"}, EMI_RESULT)],
        earlier=["Please share your PAN."],
    )
    spec = {"id": "r", "type": "regex_absent", "pattern": "PAN"}
    assert one(out, spec)["verdict"] == "pass"  # not in the final answer
    g = one(out, {**spec, "target": "agent_messages"})
    assert g["verdict"] == "fail" and g["evidence"][0]["source"] == "agent_message"
    g = one(out, {**spec, "target": "all_agent_text"})
    assert g["verdict"] == "fail"
    assert {e["source"] for e in g["evidence"]} == {"agent_message", "span"}


def test_regex_with_no_answer(tmp_path):
    out = make_trial(tmp_path, None, end_state="timeout")
    assert one(out, {"id": "r", "type": "regex_present", "pattern": "x"})["verdict"] == "fail"
    g = one(out, {"id": "r", "type": "regex_absent", "pattern": "x"})
    assert g["verdict"] == "not_applicable" and g["score"] is None


# ---- end_state ----


def test_end_state(tmp_path):
    out = make_trial(tmp_path, "done")
    g = one(out, {"id": "e", "type": "end_state", "states": ["answered"]})
    assert g["verdict"] == "pass" and g["evidence"][0] == {
        "source": "result",
        "field": "end_state",
        "quote": "answered",
    }
    late = make_trial(tmp_path / "late", None, end_state="step_limit")
    g = one(late, {"id": "e", "type": "end_state", "states": ["answered"]})
    assert g["verdict"] == "fail" and g["reason"] == "ended step_limit, not answered"
    assert (
        one(late, {"id": "e", "type": "end_state", "states": ["answered", "step_limit"]})["verdict"]
        == "pass"
    )


def test_end_state_falls_back_to_the_runner_report(tmp_path):
    out = make_trial(tmp_path, None, write_result=False)
    (out / "runner-report.json").write_text(json.dumps({"end_state": "harness_error"}))
    assert (
        one(out, {"id": "e", "type": "end_state", "states": ["harness_error"]})["verdict"] == "pass"
    )
    bare = make_trial(tmp_path / "bare", None, write_result=False)
    assert one(bare, {"id": "e", "type": "end_state", "states": ["answered"]})["verdict"] == "error"


# ---- provenance ----


def test_provenance_not_applicable_without_checks(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER)
    g = one(out, {"id": "p", "type": "provenance"})
    assert g["verdict"] == "not_applicable" and g["score"] is None


@pytest.mark.parametrize(
    "checks",
    [
        {
            "number_provenance": {
                "total": 2,
                "unsupported": [{"text": "₹11.59 lakh", "value": 1159000}],
            }
        },
        {"checks": [{"id": "number_provenance", "unsupported": ["₹11.59 lakh"]}]},
    ],
)
def test_provenance_counts_unsupported_amounts(tmp_path, checks):
    out = make_trial(tmp_path, EMI_ANSWER, checks=checks)
    g = one(out, {"id": "p", "type": "provenance"})
    assert g["verdict"] == "fail"
    assert g["evidence"] == [{"source": "checks", "quote": "₹11.59 lakh"}]
    assert one(out, {"id": "p", "type": "provenance", "max_unsupported": 1})["verdict"] == "pass"


def test_provenance_errors_on_a_checks_file_it_cannot_read(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER, checks="not json")
    assert one(out, {"id": "p", "type": "provenance"})["verdict"] == "error"
    other = make_trial(tmp_path / "o", EMI_ANSWER, checks={"something_else": {}})
    assert one(other, {"id": "p", "type": "provenance"})["verdict"] == "error"
    counted = make_trial(
        tmp_path / "c", EMI_ANSWER, checks={"number_provenance": {"unsupported_count": 0}}
    )
    assert one(counted, {"id": "p", "type": "provenance"})["verdict"] == "pass"


# ---- judge (reserved) ----


def test_judge_is_reserved(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER)
    g = one(
        out,
        {
            "id": "j",
            "type": "judge",
            "rubric": {"id": "advice", "version": "v1"},
            "criteria": ["acknowledges", {"id": "plain", "text": "No jargon"}],
        },
    )
    assert g["verdict"] == "not_implemented" and g["score"] is None
    bad = one(out, {"id": "j", "type": "judge", "criteria": []})
    assert bad["verdict"] == "error" and "rubric" in bad["reason"]


# ---- specs, versions, the task outcome ----


def test_invalid_specs_are_error_grades_and_the_rest_still_run(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER)
    report = grade(
        out,
        {"id": "a", "type": "number"},  # no expected
        {"id": "b", "type": "regex_present", "pattern": "("},  # bad regex
        {"id": "c", "type": "nonsense"},
        {"id": "d", "type": "end_state", "states": ["answered"], "typo_field": 1},
        {"id": "e", "type": "end_state", "states": ["answered"]},
        {"id": "e", "type": "end_state", "states": ["answered"]},
    )
    verdicts = [(g["grader_id"], g["verdict"]) for g in report["grades"]]
    assert verdicts == [
        ("a", "error"),
        ("b", "error"),
        ("c", "error"),
        ("d", "error"),
        ("e", "pass"),
        ("e", "error"),
    ]
    assert "more than one grader" in report["grades"][5]["reason"]
    assert report["passed"] is None and report["outcome"] == "incomplete"


def test_versions_change_with_the_spec_and_the_framework(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER)
    spec = {"id": "e", "type": "end_state", "states": ["answered"]}
    g = one(out, spec)
    assert g["spec_sha256"] == spec_sha256(spec)
    assert g["grader_version"] == grader_version(spec_sha256(spec), FRAMEWORK_VERSION)
    assert (
        one(out, {**spec, "states": ["answered", "step_limit"]})["grader_version"]
        != g["grader_version"]
    )
    assert grader_version(g["spec_sha256"], "9.9.9") != g["grader_version"]
    # key order does not change the version
    assert (
        one(out, {"states": ["answered"], "type": "end_state", "id": "e"})["grader_version"]
        == g["grader_version"]
    )


def test_outcome_rules():
    def g(verdict, required=True):
        return {"grader_id": verdict + str(required), "verdict": verdict, "required": required}

    assert outcome([g("pass"), g("fail", False)]) == (
        True,
        "pass",
        "all 1 required grader(s) passed",
    )
    assert outcome([g("pass"), g("fail")])[:2] == (False, "fail")
    assert outcome([g("pass"), g("error")])[:2] == (None, "incomplete")
    assert outcome([g("fail"), g("error")])[:2] == (False, "fail")
    assert outcome([g("not_applicable")])[:2] == (None, "incomplete")
    assert outcome([g("pass", False)])[:2] == (None, "incomplete")
    assert outcome([])[:2] == (None, "incomplete")


def test_required_defaults_to_true(tmp_path):
    out = make_trial(tmp_path, EMI_ANSWER)
    report = grade(
        out,
        {"id": "a", "type": "end_state", "states": ["answered"]},
        {"id": "b", "type": "regex_present", "pattern": "zzz", "required": False},
    )
    assert [g["required"] for g in report["grades"]] == [True, False]
    assert report["passed"] is True
