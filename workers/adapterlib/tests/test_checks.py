"""Platform checks (checks.json): number provenance and required tool calls.

Unit tests on the extraction and the matching, the runner writing and listing checks.json, and
a regression test on the real 4 Nov transcripts (Claude Haiku 5.5, five harnesses), which runs
when their folder is on disk (EVALS_REAL_RUNS_DIR, or the repo's runs/)."""

from __future__ import annotations

import json
import os
from decimal import Decimal
from pathlib import Path

import pytest
from support import REPO, errors, make_spec
from test_trial import run

from evals_adapter.checks import (
    check_trial,
    money_amounts,
    run_checks,
    source_numbers,
    tool_name,
)
from evals_adapter.spec import TrialPaths


def texts(reply: str) -> list[str]:
    return [a.text for a in money_amounts(reply)]


def values(reply: str) -> list[Decimal]:
    return [a.value for a in money_amounts(reply)]


# ---- extraction --------------------------------------------------------------------------------


def test_money_amounts_in_every_form_the_agents_wrote():
    reply = (
        "Total debt: about ₹4,41,050 across three loans. Minimums are ₹18,332.50 (Rs 18,332.50, "
        "INR 18332.5). You'd pay about ₹1.23 lakh in interest on the ₹4.41 lakh you owe, "
        "**₹1,01,341** overall, and Rs. 2 crore is out of reach. 5,000 rupees a month helps."
    )
    assert texts(reply) == [
        "₹4,41,050",
        "₹18,332.50",
        "Rs 18,332.50",
        "INR 18332.5",
        "₹1.23 lakh",
        "₹4.41 lakh",
        "₹1,01,341",
        "Rs. 2 crore",
        "5,000 rupees",
    ]
    assert values(reply) == [
        Decimal("441050"),
        Decimal("18332.50"),
        Decimal("18332.50"),
        Decimal("18332.5"),
        Decimal("123000.00"),
        Decimal("441000.00"),
        Decimal("101341"),
        Decimal("20000000"),
        Decimal("5000"),
    ]


def test_unmarked_lakh_crore_and_indian_grouping_are_money_but_other_numbers_are_not():
    reply = (
        "On a 10 lakh loan at 9% for 240 months (20 years, from 2026), 84,250 × 42% ÷ 12 is the "
        "monthly interest; 3,10,000 is the personal loan and 1.2 crore the house."
    )
    assert texts(reply) == ["10 lakh", "3,10,000", "1.2 crore"]


def test_ranges_short_units_and_negatives():
    assert texts("Between ₹8,000–9,000, or ₹4,200 to ₹4,500.") == [
        "₹8,000",
        "9,000",
        "₹4,200",
        "₹4,500",
    ]
    assert values("₹2–3 lakh") == [Decimal("200000"), Decimal("300000")]
    assert values("₹92k, ₹1.5L and ₹20 thousand") == [
        Decimal("92000"),
        Decimal("150000.0"),
        Decimal("20000"),
    ]
    assert values("a refund of -₹1,299") == [Decimal("1299")]
    # A bare number after a marked amount is a range only when the gap is a dash or "to".
    assert texts("₹4,212.50 - 5% of the balance") == ["₹4,212.50"]
    assert texts("₹500 last month, 12 l of milk") == ["₹500"]


def test_source_numbers_scale_words_split_json_lists_and_skip_dates_and_ids():
    text = (
        '{"total_balance":441050.00,"total_balance_words":"4.41 lakh","ids":[1,2,3],'
        '"date":"2026-10-25","id":"t001","months":[12,24]}'
    )
    assert source_numbers(text) == [
        Decimal("441050.00"),
        Decimal("441000.00"),
        Decimal("1"),
        Decimal("2"),
        Decimal("3"),
        Decimal("12"),
        Decimal("24"),
    ]
    # Hermes's escaped JSON and ADK's envelope hold the same numbers.
    assert Decimal("8997.26") in source_numbers('{"result": "{\\"emi\\":8997.26}"}')


def test_tool_names_lose_the_harness_prefix():
    assert tool_name("mcp__finance__calculate_emi") == "calculate_emi"
    assert tool_name("calculate_emi") == "calculate_emi"


# ---- matching ----------------------------------------------------------------------------------


def span(name, turn_id, result, is_error=False, start=1):
    attrs = [
        {"key": "gen_ai.tool.name", "value": {"stringValue": name}},
        {"key": "evals.tool.result", "value": {"stringValue": result}},
        {"key": "evals.tool.is_error", "value": {"boolValue": is_error}},
    ]
    return {
        "name": f"execute_tool {name}",
        "spanId": f"{start:016x}",
        "parentSpanId": turn_id,
        "startTimeUnixNano": str(start),
        "attributes": attrs,
    }


def turn_span(span_id, index):
    return {
        "name": "agent.turn",
        "spanId": span_id,
        "startTimeUnixNano": "0",
        "attributes": [{"key": "evals.turn.index", "value": {"intValue": str(index)}}],
    }


def checks_for(replies, spans=(), user=("What is my EMI?",), files=None, required=None):
    transcript = []
    users = list(user)
    for i, reply in enumerate(replies):
        if i < len(users):
            source = "task" if i == 0 else "client_sim"
            transcript.append({"role": "user", "content": users[i], "source": source})
        transcript.append({"role": "assistant", "content": reply, "source": "agent"})
    spec = make_spec()
    if required is not None:
        spec["task"]["required_tools"] = required
    result = {"trial_id": "t_checks", "conversation": {"transcript": transcript}}
    out = run_checks(spec, result, list(spans), files or {})
    assert errors("checks", out) == []
    return out


EMI = '{"emi":8997.26,"total_interest":1159342.12,"total_interest_words":"11.59 lakh"}'


def by_text(out):
    return {row["text"]: row for row in out["amounts"]}


def test_rounding_to_the_precision_shown_matches_a_tool_number():
    spans = [turn_span("a" * 16, 0), span("calculate_emi", "a" * 16, EMI)]
    out = checks_for(
        ["About ₹8,997 a month, ₹8,997.26 exactly, ₹11.59 lakh in interest, about ₹11.6 lakh."],
        spans,
    )
    rows = by_text(out)
    assert rows["₹8,997"]["match"] == {
        "value": 8997.26,
        "where": "tool:calculate_emi",
        "how": "rounded",
        "precision": 1,
    }
    assert rows["₹8,997.26"]["match"]["how"] == "exact"
    assert rows["₹11.59 lakh"]["supported_by"] == "tool"
    assert rows["₹11.6 lakh"]["match"]["precision"] == 10000
    assert out["unsupported"] == 0


def test_one_point_two_three_lakh_matches_123456_and_truncation_counts():
    spans = [turn_span("a" * 16, 0), span("debt_payoff_plan", "a" * 16, '{"x":123456,"s":1667.50}')]
    out = checks_for(["₹1.23 lakh of interest and ₹1,667 to spare."], spans)
    rows = by_text(out)
    assert rows["₹1.23 lakh"]["match"]["how"] == "rounded"
    assert rows["₹1,667"]["match"] == {
        "value": 1667.5,
        "where": "tool:debt_payoff_plan",
        "how": "truncated",
        "precision": 1,
    }


def test_trailing_zeros_round_only_within_one_percent():
    spans = [
        turn_span("a" * 16, 0),
        span("debt_payoff_plan", "a" * 16, '{"a":49483.43,"b":31330.07}'),
    ]
    out = checks_for(["About ₹49,500 on the card, and roughly ₹31,000 spare."], spans)
    rows = by_text(out)
    assert rows["₹49,500"]["match"]["precision"] == 100
    assert rows["₹31,000"]["supported_by"] is None  # 31,330 rounds to it, but is 1.1% away
    assert out["unsupported"] == 1


def test_a_calculation_without_a_tool_is_unsupported():
    """The 4 Nov Hermes conversation: ₹8,000 from the client, ₹6,880 from the tools, and the
    agent's own ₹8,000 − ₹6,880 = ₹1,120 and ₹3,930 − ₹1,120 = ₹2,810."""
    spans = [
        turn_span("a" * 16, 0),
        span("list_transactions", "a" * 16, '{"net":3929.85,"m":6880}'),
    ]
    out = checks_for(
        ["Left over: ₹3,930.", "₹8,000 − ₹6,880 = ₹1,120, so ₹2,810 is spare."],
        spans,
        user=("Where do I start?", "My mother's bills are about ₹8,000 a month now."),
    )
    rows = by_text(out)
    assert rows["₹3,930"]["supported_by"] == "tool"
    assert rows["₹8,000"]["supported_by"] == "user"
    assert rows["₹8,000"]["match"]["where"] == "client_sim:2"
    assert rows["₹6,880"]["supported_by"] == "tool"
    assert [r["text"] for r in out["amounts"] if r["supported_by"] is None] == ["₹1,120", "₹2,810"]
    assert out["unsupported"] == 2


def test_the_client_file_and_the_user_message_support_amounts():
    files = {
        "client.json": '{"profile":{"monthly_net_income":92500},"debts":[{"balance":84250.00}]}'
    }
    out = checks_for(
        ["Your take-home is ₹92,500, the card is ₹84,250 and you can spare Rs 20,000."],
        user=("I can put about Rs 20,000 a month towards my debts.",),
        files=files,
    )
    rows = by_text(out)
    assert rows["₹92,500"]["supported_by"] == "client"
    assert rows["₹92,500"]["match"]["where"] == "client:client.json"
    assert rows["₹84,250"]["supported_by"] == "client"
    assert rows["Rs 20,000"]["supported_by"] == "user"
    assert rows["Rs 20,000"]["match"]["where"] == "task:0"


def test_a_tool_result_from_a_later_turn_does_not_support_an_earlier_reply():
    spans = [
        turn_span("a" * 16, 0),
        turn_span("b" * 16, 1),
        span("calculate_emi", "b" * 16, EMI, start=5),
    ]
    out = checks_for(
        ["Roughly ₹8,997 a month.", "The tool says ₹8,997.26."],
        spans,
        user=("EMI?", "Are you sure?"),
    )
    first, second = out["amounts"]
    assert (first["turn"], first["supported_by"]) == (0, None)
    assert (second["turn"], second["supported_by"]) == (1, "tool")


def test_an_exact_match_beats_a_rounded_one_and_tool_beats_user():
    spans = [turn_span("a" * 16, 0), span("debt_payoff_plan", "a" * 16, '{"budget":20000.00}')]
    out = checks_for(["₹20,000 a month."], spans, user=("I have Rs 20,000.",))
    assert out["amounts"][0]["supported_by"] == "tool"


# ---- required tools ----------------------------------------------------------------------------


def test_required_tools_called_missing_and_errors_with_hermes_names():
    spans = [
        turn_span("a" * 16, 0),
        span("mcp__finance__list_debts", "a" * 16, "{}", start=1),
        span("mcp__finance__calculate_emi", "a" * 16, "Error: bad", is_error=True, start=2),
    ]
    out = checks_for(["Done."], spans, required=["calculate_emi", "list_debts", "debt_payoff_plan"])
    assert out["tools_called"] == ["list_debts", "calculate_emi"]
    assert out["required_tools"] == {
        "required": ["calculate_emi", "list_debts", "debt_payoff_plan"],
        "called": ["calculate_emi", "list_debts"],
        "missing": ["debt_payoff_plan"],
        "only_errors": ["calculate_emi"],
    }


def test_no_required_tools_means_null():
    assert checks_for(["Done."])["required_tools"] is None


def test_a_spec_with_required_tools_validates():
    spec = make_spec(**{"task.required_tools": ["calculate_emi"]})
    assert errors("spec", spec) == []
    spec["task"]["required_tools"] = ["calculate_emi", "calculate_emi"]
    assert errors("spec", spec) != []


# ---- the runner writes and lists checks.json ---------------------------------------------------


def test_the_runner_writes_checks_json_after_every_trial(tmp_path):
    spec = make_spec(**{"task.required_tools": ["calculate_emi", "list_debts"]})
    report, _, _ = run(tmp_path, spec)
    assert errors("runner-report", report) == []
    checks = json.loads((tmp_path / "trial" / "out" / "checks.json").read_text())
    assert errors("checks", checks) == []
    # The scripted reply "Your EMI is Rs 8,997.26." against the scripted tool result 8997.26.
    assert checks["amounts"] == [
        {
            "turn": 0,
            "text": "Rs 8,997.26",
            "value": 8997.26,
            "supported_by": "tool",
            "match": {
                "value": 8997.26,
                "where": "tool:calculate_emi",
                "how": "exact",
                "precision": 0.01,
            },
        }
    ]
    assert report["checks"] == {
        "path": "checks.json",
        "valid": True,
        "errors": [],
        "unsupported_amounts": 0,
        "missing_tools": ["list_debts"],
    }
    assert "checks.json" in {f["path"] for f in report["files"]}


def test_checks_run_even_when_the_adapter_crashed(tmp_path):
    spec = make_spec(**{"harness_options.crash_before_lib": 7})
    report, _, _ = run(tmp_path, spec)
    assert report["label"] == "infra:adapter_crash"
    assert report["checks"]["valid"] is True
    assert report["checks"]["unsupported_amounts"] == 0
    checks = json.loads((tmp_path / "trial" / "out" / "checks.json").read_text())
    assert checks["amounts"] == [] and checks["tools_called"] == []


# ---- the real 4 Nov transcripts ----------------------------------------------------------------

REAL = Path(os.environ.get("EVALS_REAL_RUNS_DIR", REPO / "runs")) / "20261104T083111Z-real"
REAL_TRIALS = sorted(REAL.glob("*/claude-haiku-5-5/*/trial")) if REAL.exists() else []

# What the check finds on them (read-only; nothing is written into those folders). The
# single-prompt answers are fully backed by tool results; every unsupported amount is in a
# conversation, and is arithmetic done in the reply (sums of transactions, differences between
# two plans, a month's interest by hand) or an illustrative figure the agent picked.
EXPECTED_UNSUPPORTED = {
    "adk/claude-haiku-5-5/conversation": [],
    "adk/claude-haiku-5-5/single": [],
    "hermes/claude-haiku-5-5/conversation": [
        "₹13,579",
        "₹6,880",
        "₹40,200",
        "₹27,300",
        "₹1,120",
        "₹2,810",
        "₹2,810",
        "₹2,000",
    ],
    "hermes/claude-haiku-5-5/single": [],
    "langgraph/claude-haiku-5-5/conversation": [
        "₹30,000",
        "₹3,000",
        "₹5,000",
        "₹8,086.25",
        "₹6,880",
        "₹12,280",
        "₹2,949",
    ],
    "langgraph/claude-haiku-5-5/single": [],
    "openai-agents/claude-haiku-5-5/conversation": [
        "₹40,650",
        "₹39,300",
        "₹2,605",
        "₹30,750",
        "₹31,000",
        "₹25,100",
        "₹40,650",
        "₹6,880",
        "₹39,300",
        "₹40,781.65",
        "₹33,900",
        "₹32,000",
        "₹13,800",
        "₹1,100",
    ],
    "openai-agents/claude-haiku-5-5/single": [],
    "ownloop/claude-haiku-5-5/conversation": ["₹38,500", "₹2,950", "₹1,260", "₹8,140", "₹4,500"],
    "ownloop/claude-haiku-5-5/single": [],
}


@pytest.mark.skipif(not REAL_TRIALS, reason=f"no real 4 Nov trials at {REAL}")
def test_on_the_real_4_nov_transcripts():
    found, total = {}, 0
    for trial in REAL_TRIALS:
        checks = check_trial(TrialPaths(trial))
        assert errors("checks", checks) == [], trial
        key = str(trial.parent.relative_to(REAL))
        if key.endswith("/settings"):
            assert checks["amounts"] == []  # each settings trial got a 400 and never replied
            continue
        found[key] = [r["text"] for r in checks["amounts"] if r["supported_by"] is None]
        total += len(checks["amounts"])
    assert found == EXPECTED_UNSUPPORTED
    assert total == 230
    assert sum(len(v) for v in found.values()) == 34
