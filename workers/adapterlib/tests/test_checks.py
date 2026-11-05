"""Platform checks (checks.json): number provenance and required tool calls.

Unit tests on the extraction and the matching, the runner writing and listing checks.json, and
a regression test on the real 4 Nov transcripts (Claude Haiku 5.5, five harnesses), which runs
when their folder is on disk (EVALS_REAL_RUNS_DIR, or the repo's runs/)."""

from __future__ import annotations

import json
import os
import re
from decimal import Decimal
from pathlib import Path

import pytest
from support import REPO, errors, make_spec
from test_trial import run

from evals_adapter import checks
from evals_adapter.checks import (
    ARITHMETIC_TOOLS,
    NOT_FIGURES,
    UNIT_FACTS,
    check_trial,
    is_unit_fact,
    money_amounts,
    run_checks,
    source_numbers,
    summary,
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


def span(name, turn_id, result, is_error=False, start=1, args=None):
    attrs = [
        {"key": "gen_ai.tool.name", "value": {"stringValue": name}},
        {"key": "evals.tool.result", "value": {"stringValue": result}},
        {"key": "evals.tool.is_error", "value": {"boolValue": is_error}},
    ]
    if args is not None:
        text = args if isinstance(args, str) else json.dumps(args)
        attrs.append({"key": "evals.tool.arguments", "value": {"stringValue": text}})
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
        "call": 0,
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
        "call": 0,
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


T = "a" * 16
DEBTS = '{"emi_total":14120.00,"card_plan":9000.00}'


def test_a_sum_from_the_add_tool_is_supported_and_the_same_sum_without_it_is_not():
    """D54 and D56: the 4 Nov Hermes failure was a sum written in prose (Rs 23,120 = Rs 14,120 +
    Rs 9,000); the fix is the arithmetic tool `add`. The same answer is fully supported when
    `add` returned the sum of two figures from a tool result, under either name a harness gives
    it, and has one unsupported amount when it did not."""
    reply = "Your EMIs are Rs 14,120 and the card plan Rs 9,000, so Rs 23,120 a month in all."
    sources = [turn_span(T, 0), span("list_debts", T, DEBTS, start=1)]
    for name in ("add", "mcp__finance__add"):
        add = span(name, T, '{"sum":23120.00}', start=2, args={"values": [14120, 9000]})
        out = checks_for([reply], [*sources, add])
        assert by_text(out)["Rs 23,120"] == {
            "turn": 0,
            "text": "Rs 23,120",
            "value": 23120,
            "supported_by": "tool",
            "match": {
                "value": 23120,
                "where": "tool:add",
                "how": "exact",
                "precision": 1,
                "call": 1,
            },
            "rejected": None,
        }
        assert out["unsupported"] == 0
        assert out["tools_called"] == ["list_debts", "add"]
        from_debts = {"where": "tool:list_debts", "how": "exact", "precision": 1, "call": 0}
        assert out["arithmetic"] == [
            {
                "call": 1,
                "tool": "add",
                "turn": 0,
                "supported": True,
                "inputs": [
                    {
                        "arg": "values[0]",
                        "value": 14120,
                        "supported_by": "tool",
                        "match": {"value": 14120, **from_debts},
                    },
                    {
                        "arg": "values[1]",
                        "value": 9000,
                        "supported_by": "tool",
                        "match": {"value": 9000, **from_debts},
                    },
                ],
                "reason": None,
            }
        ]
    out = checks_for([reply], sources)
    assert [r["text"] for r in out["amounts"] if r["supported_by"] is None] == ["Rs 23,120"]
    assert out["unsupported"] == 1
    assert out["arithmetic"] == []


def test_a_number_passed_into_a_tool_is_not_a_source():
    """A tool's arguments are what the agent wrote, so a sum the agent worked out and passed in
    is still unsupported, and since D56 so is the arithmetic result made from it."""
    call = span("percent_of", T, '{"amount":4116.00}', args='{"value":23120,"percent":17.8}')
    out = checks_for(["Rs 23,120 a month, of which Rs 4,116 is interest."], [turn_span(T, 0), call])
    rows = by_text(out)
    assert rows["Rs 23,120"]["supported_by"] is None
    assert rows["Rs 23,120"]["rejected"] is None  # no tool returned it
    assert rows["Rs 4,116"]["supported_by"] is None
    assert rows["Rs 4,116"]["rejected"] == {
        "value": 4116,
        "where": "tool:percent_of",
        "how": "exact",
        "precision": 1,
        "call": 0,
        "reason": "percent_of's inputs 23,120 and 17.8 are not supported",
    }
    assert out["unsupported"] == 2


# ---- D56: arithmetic results count only when their inputs are supported --------------------


def test_the_arithmetic_tools_are_the_finance_servers_and_the_apis():
    """The seven names the check treats as arithmetic are the finance server's (its manifest
    snapshot) and the API catalogue's ARITHMETIC_TOOLS, and round's `places` is a real argument."""
    manifest = json.loads(
        (REPO / "services/finance-mcp/tests/snapshots/tools_manifest.json").read_text()
    )
    schemas = {t["name"]: t["inputSchema"]["properties"] for t in manifest}
    assert ARITHMETIC_TOOLS.issubset(schemas)
    catalogue = (REPO / "apps/api/src/catalogue/catalogue-files.ts").read_text()
    listed = re.search(r"export const ARITHMETIC_TOOLS = \[([^\]]*)\]", catalogue)
    assert listed and set(re.findall(r"'(\w+)'", listed.group(1))) == ARITHMETIC_TOOLS
    for tool, args in NOT_FIGURES.items():
        assert args.issubset(schemas[tool])


@pytest.mark.parametrize("name", ["round", "mcp__finance__round"])
def test_rounding_a_made_up_figure_does_not_make_it_supported(name):
    call = span(name, T, '{"rounded":23120}', args={"value": 23120, "places": 0})
    out = checks_for(["About Rs 23,120 a month."], [turn_span(T, 0), call])
    (row,) = out["amounts"]
    assert (row["supported_by"], row["match"]) == (None, None)
    assert row["rejected"] == {
        "value": 23120,
        "where": "tool:round",
        "how": "exact",
        "precision": 1,
        "call": 0,
        "reason": "round's input 23,120 is not supported",
    }
    assert out["unsupported"] == 1
    (record,) = out["arithmetic"]
    assert (record["tool"], record["supported"]) == ("round", False)
    # round's places says how to round, not a figure, so it needs no source (A40).
    assert record["inputs"] == [
        {"arg": "value", "value": 23120, "supported_by": None, "match": None}
    ]
    assert "tool:round matched, but round's input 23,120 is not supported" in summary(out)


@pytest.mark.parametrize(
    ("tool", "args", "result"),
    [
        ("add", {"values": [12345, 0]}, '{"sum":12345.00}'),
        ("multiply", {"values": [12345, 1]}, '{"product":12345.00}'),
    ],
)
def test_adding_zero_or_multiplying_by_one_does_not_make_a_made_up_figure_supported(
    tool, args, result
):
    """0 and 1 are in a tool result here, so only the made-up 12,345 is unsupported."""
    spans = [
        turn_span(T, 0),
        span("list_debts", T, '{"count":1,"overdue":0}', start=1),
        span(tool, T, result, start=2, args=args),
    ]
    out = checks_for(["You can save Rs 12,345 a month."], spans)
    (row,) = out["amounts"]
    assert row["supported_by"] is None
    assert row["rejected"]["reason"] == f"{tool}'s input 12,345 is not supported"
    (record,) = out["arithmetic"]
    assert [(i["arg"], i["supported_by"]) for i in record["inputs"]] == [
        ("values[0]", None),
        ("values[1]", "tool"),
    ]


def test_a_chain_of_arithmetic_on_sourced_figures_is_supported_in_call_order():
    """add, then subtract on add's result, then round on subtract's: every input is a tool
    figure or the result of an accepted call before it. With the subtracted figure made up, the
    chain breaks there, and round's result goes with it."""
    debts = '{"emi_total":14120.00,"card_plan":9000.00,"interest":4116.50}'

    def chain(debts_result):
        return [
            turn_span(T, 0),
            span("list_debts", T, debts_result, start=1),
            span("add", T, '{"sum":23120.00}', start=2, args={"values": [14120, 9000]}),
            span("subtract", T, '{"difference":19003.50}', start=3, args={"a": 23120, "b": 4116.5}),
            span(
                "mcp__finance__round",
                T,
                '{"rounded":19004}',
                start=4,
                args={"value": 19003.5, "places": 0},
            ),
        ]

    reply = "Rs 23,120 in all; Rs 19,003.50 without the interest, so about Rs 19,004."
    out = checks_for([reply], chain(debts))
    assert out["unsupported"] == 0
    assert [(r["text"], r["match"]["where"], r["match"]["call"]) for r in out["amounts"]] == [
        ("Rs 23,120", "tool:add", 1),
        ("Rs 19,003.50", "tool:subtract", 2),
        ("Rs 19,004", "tool:round", 3),
    ]
    assert [(c["tool"], c["supported"]) for c in out["arithmetic"]] == [
        ("add", True),
        ("subtract", True),
        ("round", True),
    ]
    subtract, rounded = out["arithmetic"][1:]
    assert [(i["match"]["where"], i["match"]["call"]) for i in subtract["inputs"]] == [
        ("tool:add", 1),
        ("tool:list_debts", 0),
    ]
    assert rounded["inputs"][0]["match"]["where"] == "tool:subtract"

    out = checks_for([reply], chain(DEBTS))  # no interest figure: 4,116.5 is made up
    assert [(c["tool"], c["reason"]) for c in out["arithmetic"]] == [
        ("add", None),
        ("subtract", "subtract's input 4,116.5 is not supported"),
        (
            "round",
            "round's input 19,003.5 (subtract's result, itself unsupported) is not supported",
        ),
    ]
    rows = by_text(out)
    assert rows["Rs 23,120"]["supported_by"] == "tool"
    assert rows["Rs 19,003.50"]["rejected"]["where"] == "tool:subtract"
    assert rows["Rs 19,004"]["rejected"]["where"] == "tool:round"
    assert out["unsupported"] == 2


def test_a_figure_from_the_clients_message_is_a_supported_input():
    spans = [
        turn_span(T, 0),
        span("list_debts", T, '{"total_minimum_payments":18332.50}', start=1),
        span("subtract", T, '{"difference":1667.50}', start=2, args={"a": 20000, "b": 18332.5}),
    ]
    out = checks_for(
        ["After the minimums, Rs 1,667.50 of your Rs 20,000 is left."],
        spans,
        user=("I can put about Rs 20,000 a month towards my debts.",),
    )
    assert by_text(out)["Rs 1,667.50"]["match"]["where"] == "tool:subtract"
    assert out["unsupported"] == 0
    (record,) = out["arithmetic"]
    assert record["inputs"][0] == {
        "arg": "a",
        "value": 20000,
        "supported_by": "user",
        "match": {"value": 20000, "where": "task:0", "how": "exact", "precision": 1},
    }


def test_a_message_supports_an_input_only_from_its_turn_on():
    """The simulated client says Rs 20,000 in its second message (turn 1): a subtract in turn 0
    could not have read it, one in turn 1 could. A call with no turn parent may use any message,
    as its result counts for any reply."""
    users = ("Where do I start?", "I pay Rs 18,332.50 and can spare Rs 20,000.")
    replies = ["What can you spare each month?", "Rs 1,667.50 is left over."]
    for parent, supported in (("a" * 16, False), ("b" * 16, True), (None, True)):
        spans = [
            turn_span("a" * 16, 0),
            turn_span("b" * 16, 1),
            span("subtract", parent, '{"difference":1667.50}', args={"a": 20000, "b": 18332.5}),
        ]
        out = checks_for(replies, spans, user=users)
        (record,) = out["arithmetic"]
        assert record["supported"] is supported, parent
        assert (out["amounts"][-1]["supported_by"] == "tool") is supported


def test_a_figure_from_the_client_file_is_a_supported_input():
    files = {"client.json": '{"debts":[{"balance":84250.00,"annual_rate_pct":42}]}'}
    call = span("percent_of", T, '{"amount":35385.00}', args={"value": 84250, "percent": 42})
    out = checks_for(
        ["A year's interest on the card is about Rs 35,385."], [turn_span(T, 0), call], files=files
    )
    assert out["amounts"][0]["match"]["where"] == "tool:percent_of"
    assert [i["supported_by"] for i in out["arithmetic"][0]["inputs"]] == ["client", "client"]


def test_a_tool_result_after_the_call_does_not_support_its_inputs():
    spans = [
        turn_span(T, 0),
        span("add", T, '{"sum":23120.00}', start=1, args={"values": [14120, 9000]}),
        span("list_debts", T, DEBTS, start=2),
    ]
    out = checks_for(["Rs 23,120 a month in all."], spans)
    assert out["arithmetic"][0]["reason"] == "add's inputs 14,120 and 9,000 are not supported"
    assert out["unsupported"] == 1


def test_inputs_are_matched_by_the_amounts_rule_at_the_precision_written():
    """As an amount in a reply: 8997 is 8,997.26 rounded and 18332 is 18,332.50 cut; 31000 does
    not match 31,330.07 (trailing zeros count as rounding only within 1%)."""
    figures = span("list_debts", T, '{"emi":8997.26,"minimums":18332.50,"spare":31330.07}', start=1)
    add = span("add", T, '{"sum":27329.00}', start=2, args={"values": [8997, 18332]})
    out = checks_for(["Rs 27,329 a month."], [turn_span(T, 0), figures, add])
    assert [i["match"]["how"] for i in out["arithmetic"][0]["inputs"]] == ["rounded", "truncated"]
    assert out["unsupported"] == 0
    loose = span("subtract", T, '{"difference":3000.00}', start=2, args={"a": 31000, "b": 28000})
    out = checks_for(["Rs 3,000 to spare."], [turn_span(T, 0), figures, loose])
    assert out["arithmetic"][0]["reason"] == "subtract's inputs 31,000 and 28,000 are not supported"


def test_an_arithmetic_result_needs_readable_arguments_given_numbers_and_no_error():
    debts = span("list_debts", T, DEBTS, start=1)
    values = {"values": [14120, 9000]}
    cases = {
        "add returned an error": span("add", T, '{"sum":23120.00}', True, 2, values),
        "add's arguments are not in the trace": span("add", T, '{"sum":23120.00}', start=2),
        "add's arguments could not be read": span(
            "add",
            T,
            '{"sum":23120.00}',
            start=2,
            args='{"values": [14120, 90...[truncated 9 chars]',
        ),
        "add was given no numbers": span(
            "add", T, '{"sum":23120.00}', start=2, args={"values": []}
        ),
    }
    for reason, add in cases.items():
        out = checks_for(["Rs 23,120 a month in all."], [turn_span(T, 0), debts, add])
        assert out["arithmetic"][0]["reason"] == reason
        assert out["amounts"][0]["rejected"]["reason"] == reason


def test_a_finance_tools_result_counts_whatever_it_was_given():
    """D56 changes only the arithmetic tools: calculate_emi's result is a source even when its
    principal was made up (docs/known-limits.md, Platform checks)."""
    call = span(
        "calculate_emi",
        T,
        '{"emi":9852.70}',
        args={"principal": 777777, "annual_rate_pct": 9, "tenure_months": 120},
    )
    out = checks_for(["Rs 9,852.70 a month."], [turn_span(T, 0), call])
    assert out["amounts"][0]["supported_by"] == "tool"
    assert out["arithmetic"] == []


# ---- D58: unit facts, the identity guard, and reference_rates as a source ----------------------


def test_the_unit_facts_are_the_d58_list_and_never_zero_or_one():
    assert sorted(UNIT_FACTS) == [
        Decimal(n) for n in (7, 12, 28, 29, 30, 31, 52, 100, 365, 366, 100_000, 10_000_000)
    ]
    assert Decimal(0) not in UNIT_FACTS and Decimal(1) not in UNIT_FACTS
    # By value, sign ignored, as the amounts' rule ignores signs; nothing else is one.
    assert all(is_unit_fact(Decimal(t)) for t in ("12", "12.0", "12.00", "-12", "1E+5"))
    assert not any(is_unit_fact(Decimal(t)) for t in ("0", "1", "-1", "12.5", "11", "1000", "NaN"))


def test_a_year_of_emis_from_multiply_by_12_is_supported():
    """D58's first case: 12 months in a year needs no source, so twelve sourced EMIs are a
    supported figure. Under D56 alone this was unsupported unless 12 appeared somewhere."""
    spans = [
        turn_span(T, 0),
        span("calculate_emi", T, EMI, start=1),
        span("multiply", T, '{"product":107967.12}', start=2, args={"values": [8997.26, 12]}),
    ]
    out = checks_for(["Rs 8,997.26 a month, so Rs 1,07,967.12 a year."], spans)
    assert out["unsupported"] == 0
    assert by_text(out)["Rs 1,07,967.12"]["match"]["where"] == "tool:multiply"
    (record,) = out["arithmetic"]
    assert record["supported"] is True and record["reason"] is None
    assert record["inputs"] == [
        {
            "arg": "values[0]",
            "value": 8997.26,
            "supported_by": "tool",
            "match": {
                "value": 8997.26,
                "where": "tool:calculate_emi",
                "how": "exact",
                "precision": 0.01,
                "call": 0,
            },
        },
        {"arg": "values[1]", "value": 12, "supported_by": "unit", "match": None},
    ]
    assert summary(out).startswith("t_checks: 0 unsupported")


def test_percentages_through_100_are_supported():
    """A rate from the client file over 100 is a fraction, and a fraction times 100 a percent;
    percent_of a sourced value at 100 percent repeats the value, which has a source, so it
    counts too (the identity guard looks only at inputs with no source)."""
    files = {"client.json": '{"debts":[{"balance":84250.00,"annual_rate_pct":42}]}'}
    spans = [
        turn_span(T, 0),
        span("divide", T, '{"quotient":0.42}', start=1, args={"a": 42, "b": 100}),
        span("multiply", T, '{"product":35385.00}', start=2, args={"values": [84250, 0.42]}),
        span("multiply", T, '{"product":42.00}', start=3, args={"values": [0.42, 100]}),
        span(
            "percent_of", T, '{"amount":84250.00}', start=4, args={"value": 84250, "percent": 100}
        ),
    ]
    out = checks_for(
        ["A year's interest is about Rs 35,385 on the Rs 84,250 balance."], spans, files=files
    )
    assert [(c["tool"], c["supported"]) for c in out["arithmetic"]] == [
        ("divide", True),
        ("multiply", True),
        ("multiply", True),
        ("percent_of", True),
    ]
    assert [i["supported_by"] for i in out["arithmetic"][0]["inputs"]] == ["client", "unit"]
    assert [i["supported_by"] for i in out["arithmetic"][2]["inputs"]] == ["tool", "unit"]
    assert out["unsupported"] == 0


def test_a_days_share_of_a_years_interest_divides_by_365():
    spans = [
        turn_span(T, 0),
        span("fd_maturity", T, '{"maturity_amount":107185.90,"interest_earned":7185.90}', start=1),
        span("divide", T, '{"quotient":19.69}', start=2, args={"a": 7185.9, "b": 365}),
    ]
    out = checks_for(["Rs 7,185.90 of interest, about Rs 19.69 a day."], spans)
    (record,) = out["arithmetic"]
    assert [i["supported_by"] for i in record["inputs"]] == ["tool", "unit"]
    assert record["supported"] is True
    assert out["unsupported"] == 0


def test_a_unit_fact_is_not_a_source_for_an_amount_in_a_reply():
    """Unit facts are arithmetic inputs only: "Rs 100" or "Rs 1,00,000" written in a reply still
    needs a source."""
    out = checks_for(["Put aside Rs 100 a day, Rs 1,00,000 by next year."], [turn_span(T, 0)])
    assert [r["supported_by"] for r in out["amounts"]] == [None, None]


@pytest.mark.parametrize(
    ("tool", "args", "result"),
    [
        ("add", {"values": [12345, 0]}, '{"sum":12345.00}'),
        ("multiply", {"values": [12345, 1]}, '{"product":12345.00}'),
        ("divide", {"a": 12345, "b": 1}, '{"quotient":12345.00}'),
        ("round", {"value": 12345, "places": 0}, '{"rounded":12345}'),
    ],
)
def test_identities_on_a_made_up_figure_stay_unsupported(tool, args, result):
    """D58 keeps D56's verdict on a made-up x passed through an identity (0 and 1 are in a tool
    result here, so only x lacks a source)."""
    spans = [
        turn_span(T, 0),
        span("list_debts", T, '{"count":1,"overdue":0}', start=1),
        span(tool, T, result, start=2, args=args),
    ]
    out = checks_for(["You can save Rs 12,345 a month."], spans)
    assert out["amounts"][0]["supported_by"] is None
    assert out["amounts"][0]["rejected"]["reason"] == f"{tool}'s input 12,345 is not supported"


@pytest.mark.parametrize(
    ("tool", "args", "result", "reason"),
    [
        ("round", {"value": 365}, '{"rounded":365.00}', "365.00 only repeats its input 365"),
        ("add", {"values": [100, 0]}, '{"sum":100.00}', "100.00 only repeats its input 100"),
        ("multiply", {"values": [12, 1]}, '{"product":12.00}', "12.00 only repeats its input 12"),
        (
            "divide",
            {"a": 1e5, "b": 1},
            '{"quotient":100000.00}',
            "1,00,000.00 only repeats its input 1,00,000.0",
        ),
    ],
)
def test_the_identity_guard_keeps_a_unit_fact_from_becoming_a_figure(tool, args, result, reason):
    """A result that only repeats an input with no source never counts: without the guard,
    round(365) or add([100, 0]) would make "Rs 365" or "Rs 100" supported from nothing (0 and 1
    are in a tool result here, so every input is supported or a unit fact)."""
    spans = [
        turn_span(T, 0),
        span("list_debts", T, '{"count":1,"overdue":0}', start=1),
        span(tool, T, result, start=2, args=args),
    ]
    out = checks_for(["About Rs 100 a month."], spans)
    (record,) = out["arithmetic"]
    assert record["supported"] is False
    assert record["reason"] == f"{tool}'s result {reason}, which has no source"
    assert {i["supported_by"] for i in record["inputs"]} <= {"unit", "tool"}
    rejected = out["amounts"][0]["rejected"]
    assert rejected is None or rejected["reason"] == record["reason"]


def test_rounding_to_a_unit_fact_is_not_a_unit_fact():
    """round(30.4) is 30, a unit fact, but 30.4 is not one and has no source: D56's missing
    input decides it, and the result does not count."""
    call = span("round", T, '{"rounded":30}', args={"value": 30.4, "places": 0})
    out = checks_for(["About Rs 30 a day."], [turn_span(T, 0), call])
    assert out["arithmetic"][0]["reason"] == "round's input 30.4 is not supported"
    assert out["amounts"][0]["supported_by"] is None


def test_the_identity_guard_holds_whatever_the_unit_list_says(monkeypatch):
    """With 0, 1 and even the made-up 12,345 on the list, add([x, 0]), multiply([x, 1]) and
    round(x) still do not make x a supported figure: their result repeats an input with no
    source. An honest product of a sourced figure and a listed constant still counts."""
    monkeypatch.setattr(
        checks, "UNIT_FACTS", checks.UNIT_FACTS | {Decimal(0), Decimal(1), Decimal(12345)}
    )
    for tool, args, result in [
        ("add", {"values": [12345, 0]}, '{"sum":12345.00}'),
        ("multiply", {"values": [12345, 1]}, '{"product":12345.00}'),
        ("round", {"value": 12345.4, "places": 0}, '{"rounded":12345}'),
        ("round", {"value": 12345}, '{"rounded":12345.00}'),
    ]:
        out = checks_for(
            ["Rs 12,345 a month."], [turn_span(T, 0), span(tool, T, result, args=args)]
        )
        (record,) = out["arithmetic"]
        if args.get("value") == 12345.4:  # 12,345.4 is not on the list: D56's missing input
            assert record["reason"] == "round's input 12,345.4 is not supported"
        else:
            assert "only repeats its input 12,345, which has no source" in record["reason"]
        assert out["amounts"][0]["supported_by"] is None, tool
    spans = [
        turn_span(T, 0),
        span("calculate_emi", T, EMI, start=1),
        span("multiply", T, '{"product":107967.12}', start=2, args={"values": [8997.26, 12, 1]}),
    ]
    out = checks_for(["Rs 1,07,967.12 a year."], spans)
    assert out["arithmetic"][0]["supported"] is True


RATES = (
    '{"compiled_on":"2026-11-05","rates":{"fd_1y":{"name":"One-year fixed deposit, State Bank'
    ' of India","value":6.25,"unit":"percent per year","as_of":"2026-10-15","source":'
    '{"organisation":"State Bank of India","url":"https://sbi.co.in/web/interest-rates"}}}}'
)


@pytest.mark.parametrize("name", ["reference_rates", "mcp__finance__reference_rates"])
def test_a_figure_from_a_reference_rate_is_supported_and_a_made_up_rate_is_not(name):
    """D58: reference_rates is a finance tool, so its values are sources like any tool result. A
    year's interest at its FD rate on the client's own amount is supported; the same sum at a
    rate the agent picked (7.4%) is not."""
    user = ("I have Rs 2,00,000 to put in an FD.",)
    spans = [
        turn_span(T, 0),
        span(name, T, RATES, start=1, args={}),
        span("percent_of", T, '{"amount":12500.00}', start=2, args={"value": 2e5, "percent": 6.25}),
    ]
    out = checks_for(["At 6.25% that is about Rs 12,500 a year."], spans, user=user)
    assert out["unsupported"] == 0
    (record,) = out["arithmetic"]
    assert [(i["supported_by"], (i["match"] or {}).get("where")) for i in record["inputs"]] == [
        ("user", "task:0"),
        ("tool", "tool:reference_rates"),
    ]
    made_up = span(
        "percent_of", T, '{"amount":14800.00}', start=2, args={"value": 2e5, "percent": 7.4}
    )
    out = checks_for(
        ["At 7.4% that is about Rs 14,800 a year."], [spans[0], spans[1], made_up], user=user
    )
    assert out["amounts"][0]["rejected"]["reason"] == "percent_of's input 7.4 is not supported"
    assert out["unsupported"] == 1


def test_the_dates_in_reference_rates_are_not_sources():
    """Its as-of dates are skipped like any date, so they support nothing: only the rate is a
    number in it."""
    assert source_numbers(RATES) == [Decimal("6.25")]


def test_the_digits_of_a_url_are_not_sources():
    """A source's URL (an RBI press release id, a PDF name with %20 and a year) holds no
    amounts, in a JSON string or in prose; the text after it still counts."""
    rbi = '{"url":"https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=63742","v":5.50}'
    assert source_numbers(rbi) == [Decimal("5.50")]
    pdf = "See http://x.gov.in/1791801549227-Press%20Release,%202026.pdf for Rs 4,200."
    assert source_numbers(pdf) == [Decimal(4200)]
    assert source_numbers("prid=63742 at 20%") == [Decimal(63742), Decimal(20)]  # not a URL


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
                "call": 0,
            },
            "rejected": None,
        }
    ]
    assert checks["arithmetic"] == []
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
