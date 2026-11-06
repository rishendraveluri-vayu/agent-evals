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
    percentages,
    run_checks,
    source_numbers,
    source_rates,
    summary,
    tool_name,
    written_counts,
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


def test_a_count_after_a_dash_is_not_the_end_of_a_range():
    """Destructive review G9 (6 Nov): "₹5.96 lakh – 46 months sooner" read 46 as ₹46 lakh, an
    unsupported figure in a correct answer."""
    assert texts("- Interest saved: ₹5.96 lakh – 46 months sooner") == ["₹5.96 lakh"]
    assert texts("₹18,332.50 - 24 EMIs left") == ["₹18,332.50"]
    assert texts("₹9,000 to 12 more months") == ["₹9,000"]
    # A real range still is one.
    assert texts("₹8,000–9,000 a month") == ["₹8,000", "9,000"]
    assert values("₹2–3 lakh, ₹4 lakh - 5 lakh") == [
        Decimal(200000),
        Decimal(300000),
        Decimal(400000),
        Decimal(500000),
    ]


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


def test_a_figure_with_under_three_significant_digits_is_never_cut_to_match():
    """Destructive review G8 (6 Nov): "about ₹5 lakh" for ₹5,95,511.77 was supported by cutting
    5.955 lakh to 5; and "₹1 lakh" by anything from 1.00 to 1.99 lakh. They match by rounding
    only now: ₹5 lakh is 4.50 to 5.49 lakh."""

    def first(reply: str, result: str) -> dict:
        spans = [turn_span("a" * 16, 0), span("prepayment_impact", "a" * 16, result)]
        return checks_for([reply], spans)["amounts"][0]

    assert first("About ₹5 lakh.", '{"interest_saved":595511.77}')["supported_by"] is None
    assert first("Keep ₹1 lakh aside.", '{"buffer":160000}')["supported_by"] is None
    assert first("₹45 for the fee.", '{"fee":45.80}')["supported_by"] is None  # rounds to 46
    rounded = first("About ₹5 lakh.", '{"spare":460000}')  # 4.6 lakh rounds to 5
    assert (rounded["supported_by"], rounded["match"]["how"]) == ("tool", "rounded")
    # Three significant digits or more still match by cutting.
    out = checks_for(
        ["About ₹5.95 lakh, or ₹8,997 a month."],
        [turn_span("a" * 16, 0), span("p", "a" * 16, '{"a":595511.77,"emi":8997.86}')],
    )
    assert [r["match"]["how"] for r in out["amounts"]] == ["truncated", "truncated"]
    assert checks.significant_digits(Decimal("4.41")) == 3
    assert checks.significant_digits(Decimal("5")) == 1
    assert checks.significant_digits(Decimal("500")) == 3


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


def test_a_correct_calculation_without_a_tool_is_derived_in_prose():
    """The 4 Nov Hermes conversation: ₹8,000 from the client, ₹6,880 from the tools, and the
    agent's own ₹8,000 − ₹6,880 = ₹1,120 and ₹3,930 − ₹1,120 = ₹2,810. Changed by D61: before,
    both were unsupported (no tool computed them); now the checker recomputes them, so they are
    verified as derived in prose, the second from the first. The same reply with a wrong
    difference is unsupported."""
    spans = [
        turn_span("a" * 16, 0),
        span("list_transactions", "a" * 16, '{"net":3929.85,"m":6880}'),
    ]
    user = ("Where do I start?", "My mother's bills are about ₹8,000 a month now.")
    out = checks_for(
        ["Left over: ₹3,930.", "₹8,000 − ₹6,880 = ₹1,120, so ₹2,810 is spare."], spans, user=user
    )
    rows = by_text(out)
    assert (rows["₹3,930"]["supported_by"], rows["₹3,930"]["verified_by"]) == ("tool", "source")
    assert rows["₹8,000"]["supported_by"] == "user"
    assert rows["₹8,000"]["match"]["where"] == "client_sim:2"
    assert rows["₹6,880"]["supported_by"] == "tool"
    assert rows["₹1,120"] == {
        "turn": 1,
        "text": "₹1,120",
        "value": 1120,
        "supported_by": "derived",
        "match": None,
        "verified_by": "derived_in_prose",
        "derivation": {
            "op": "subtract",
            "operands": [
                {"value": 8000, "where": "answer:1"},
                {"value": 6880, "where": "answer:1"},
            ],
            "value": 1120,
            "how": "exact",
        },
        "rejected": None,
    }
    assert rows["₹2,810"]["derivation"]["operands"] == [
        {"value": 3930, "where": "answer:0"},
        {"value": 1120, "where": "answer:1"},
    ]
    assert (out["unsupported"], out["derived_in_prose"]) == (0, 2)

    wrong = checks_for(
        ["Left over: ₹3,930.", "₹8,000 − ₹6,880 = ₹1,210, so ₹2,720 is spare."], spans, user=user
    )
    assert [r["text"] for r in wrong["amounts"] if r["supported_by"] is None] == [
        "₹1,210",
        "₹2,720",
    ]
    assert (wrong["unsupported"], wrong["derived_in_prose"]) == (2, 0)


T = "a" * 16
DEBTS = '{"emi_total":14120.00,"card_plan":9000.00}'


def test_a_sum_from_the_add_tool_is_tool_and_the_same_sum_in_prose_is_derived_in_prose():
    """The 4 Nov Hermes failure was a sum written in prose (Rs 23,120 = Rs 14,120 + Rs 9,000).
    With `add` (D54) the sum is verified as `tool`, under either name a harness gives it. Changed
    by D61: without the add call it was unsupported; now the checker recomputes it from the two
    figures the reply wrote, so it is verified as `derived_in_prose` and counted in
    `derived_in_prose`, the measure of figures written without a tool."""
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
            "verified_by": "tool",
            "derivation": None,
            "rejected": None,
        }
        assert (out["unsupported"], out["derived_in_prose"]) == (0, 0)
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
    total = by_text(out)["Rs 23,120"]
    assert (total["supported_by"], total["verified_by"]) == ("derived", "derived_in_prose")
    assert total["derivation"] == {
        "op": "add",
        "operands": [
            {"value": 9000, "where": "answer:0"},
            {"value": 14120, "where": "answer:0"},
        ],
        "value": 23120,
        "how": "exact",
    }
    assert (out["unsupported"], out["derived_in_prose"]) == (0, 1)
    assert out["arithmetic"] == []
    # A wrong sum in the same words is unsupported: 14,120 + 9,000 is not 23,210.
    wrong = checks_for([reply.replace("23,120", "23,210")], sources)
    assert [r["text"] for r in wrong["amounts"] if r["supported_by"] is None] == ["Rs 23,210"]
    assert (wrong["unsupported"], wrong["derived_in_prose"]) == (1, 0)


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


def test_a_tools_error_message_is_not_a_source():
    """Destructive review G11 (6 Nov): an error that echoes the call's arguments sourced the
    figure the agent made up. The amount says what it matched and why that does not count."""
    error = (
        '{"error": "Error executing tool get_client_profile: unknown argument(s) ₹50,000;'
        ' it takes no arguments"}'
    )
    spans = [
        turn_span(T, 0),
        span("get_client_profile", T, error, True, 1, {"₹50,000": True}),
        span("subtract", T, '{"difference":40000}', start=2, args={"a": 50000, "b": 10000}),
    ]
    out = checks_for(["Clearing the card first saves you about ₹50,000 more."], spans)
    (row,) = out["amounts"]
    assert row["supported_by"] is None
    assert row["rejected"]["where"] == "tool:get_client_profile"
    assert row["rejected"]["reason"] == "get_client_profile returned an error"
    assert out["arithmetic"][0]["inputs"][0]["supported_by"] is None  # nor an input's source
    # The same text as a successful result is a source.
    ok = [turn_span(T, 0), span("get_client_profile", T, '{"note": "₹50,000"}', start=1)]
    assert checks_for(["About ₹50,000 more."], ok)["amounts"][0]["supported_by"] == "tool"


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
    """percent_of a sourced balance at its sourced rate counts, and so does percent_of the
    balance at 100 percent (a unit fact), whose result repeats the balance, which has a source
    (the identity guard looks only at inputs with no source).

    Changed by D61: the rate converted to a fraction first, divide(42, 100), no longer counts,
    because every call needs a sourced amount (100 or more) and 42 and 100 are a rate and a unit
    fact; so the multiply that used its 0.42 does not count either. The year's interest is still
    verified, as the checker recomputes it from the balance and the client file's rate, but as
    derived in prose rather than by a tool."""
    files = {"client.json": '{"debts":[{"balance":84250.00,"annual_rate_pct":42}]}'}
    reply = "A year's interest is about Rs 35,385 on the Rs 84,250 balance."
    spans = [
        turn_span(T, 0),
        span("percent_of", T, '{"amount":35385.00}', start=1, args={"value": 84250, "percent": 42}),
        span(
            "percent_of", T, '{"amount":84250.00}', start=2, args={"value": 84250, "percent": 100}
        ),
    ]
    out = checks_for([reply], spans, files=files)
    assert [(c["tool"], c["supported"]) for c in out["arithmetic"]] == [
        ("percent_of", True),
        ("percent_of", True),
    ]
    assert [i["supported_by"] for i in out["arithmetic"][1]["inputs"]] == ["client", "unit"]
    # Rs 84,250 is in the client file and in the second call's result: a tool match wins a tie.
    assert [r["verified_by"] for r in out["amounts"]] == ["tool", "tool"]

    via_fraction = [
        turn_span(T, 0),
        span("divide", T, '{"quotient":0.42}', start=1, args={"a": 42, "b": 100}),
        span("multiply", T, '{"product":35385.00}', start=2, args={"values": [84250, 0.42]}),
    ]
    out = checks_for([reply], via_fraction, files=files)
    assert [(c["tool"], c["reason"]) for c in out["arithmetic"]] == [
        ("divide", "divide was given no sourced amount (a sourced number of 100 or more)"),
        (
            "multiply",
            "multiply's input 0.42 (divide's result, itself unsupported) is not supported",
        ),
    ]
    interest = by_text(out)["Rs 35,385"]
    assert interest["verified_by"] == "derived_in_prose"
    assert interest["derivation"]["op"] == "percent_of"
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
        (
            "round",
            {"value": 365},
            '{"rounded":365.00}',
            "round's input 365 has no source (round needs a source for every input)",
        ),
        (
            "add",
            {"values": [100, 0]},
            '{"sum":100.00}',
            "add's input 100 has no source (add needs a source for every input)",
        ),
        (
            "multiply",
            {"values": [12, 1]},
            '{"product":12.00}',
            "multiply was given no sourced amount (a sourced number of 100 or more)",
        ),
        (
            "divide",
            {"a": 1e5, "b": 1},
            '{"quotient":100000.00}',
            "divide was given no sourced amount (a sourced number of 100 or more)",
        ),
    ],
)
def test_a_unit_fact_never_becomes_a_figure_by_itself(tool, args, result, reason):
    """round(365), add([100, 0]), multiply([12, 1]) and divide(1,00,000, 1) would make "Rs 365"
    or "Rs 100" supported from nothing (0 and 1 are in a tool result here, so every input is
    sourced or a unit fact). Changed by D61: D58's identity guard refused them; now D61's
    operand rule refuses them first (a sum or a rounding needs a source for every input, and
    every call needs a sourced amount), so the reasons say that instead."""
    spans = [
        turn_span(T, 0),
        span("list_debts", T, '{"count":1,"overdue":0}', start=1),
        span(tool, T, result, start=2, args=args),
    ]
    out = checks_for(["About Rs 100 a month."], spans)
    (record,) = out["arithmetic"]
    assert record["supported"] is False
    assert record["reason"] == reason
    assert {i["supported_by"] for i in record["inputs"]} <= {"unit", "free", "tool"}
    rejected = out["amounts"][0]["rejected"]
    assert rejected is None or rejected["reason"] == record["reason"]


def test_the_identity_guard_refuses_a_result_that_repeats_an_unsourced_input():
    """D58's guard, kept by D61, decides when the operand rule passes: percent_of the client's
    Rs 100 at 12 percent (a free factor) is 12.00, which only repeats the 12."""
    call = span("percent_of", T, '{"amount":12.00}', args={"value": 100, "percent": 12})
    out = checks_for(["That is Rs 12."], [turn_span(T, 0), call], user=("I save Rs 100 a week.",))
    (record,) = out["arithmetic"]
    assert [i["supported_by"] for i in record["inputs"]] == ["user", "unit"]
    assert record["reason"] == (
        "percent_of's result 12.00 only repeats its input 12, which has no source"
    )
    assert out["amounts"][0]["supported_by"] is None


def test_rounding_to_a_unit_fact_is_not_a_unit_fact():
    """round(30.4) is 30, a unit fact, but 30.4 is not one and has no source: D56's missing
    input decides it, and the result does not count."""
    call = span("round", T, '{"rounded":30}', args={"value": 30.4, "places": 0})
    out = checks_for(["About Rs 30 a day."], [turn_span(T, 0), call])
    assert out["arithmetic"][0]["reason"] == "round's input 30.4 is not supported"
    assert out["amounts"][0]["supported_by"] is None


def test_a_made_up_figure_stays_unsupported_whatever_the_unit_list_says(monkeypatch):
    """With 0, 1 and even the made-up 12,345 on the list, add([x, 0]), multiply([x, 1]) and
    round(x) still do not make x a supported figure. An honest product of a sourced figure and a
    listed constant still counts. Changed by D61: the operand rule refuses them before D58's
    identity guard would (no source for a sum's or a rounding's input, no sourced amount)."""
    monkeypatch.setattr(
        checks, "UNIT_FACTS", checks.UNIT_FACTS | {Decimal(0), Decimal(1), Decimal(12345)}
    )
    for tool, args, result, reason in [
        (
            "add",
            {"values": [12345, 0]},
            '{"sum":12345.00}',
            "add's inputs 12,345 and 0 have no source (add needs a source for every input)",
        ),
        (
            "multiply",
            {"values": [12345, 1]},
            '{"product":12345.00}',
            "multiply was given no sourced amount (a sourced number of 100 or more)",
        ),
        (
            "round",
            {"value": 12345.4, "places": 0},
            '{"rounded":12345}',
            "round's input 12,345.4 is not supported",
        ),
        (
            "round",
            {"value": 12345},
            '{"rounded":12345.00}',
            "round's input 12,345 has no source (round needs a source for every input)",
        ),
    ]:
        out = checks_for(
            ["Rs 12,345 a month."], [turn_span(T, 0), span(tool, T, result, args=args)]
        )
        (record,) = out["arithmetic"]
        assert record["reason"] == reason
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
def test_a_figure_from_a_reference_rate_is_supported_and_an_unstated_made_up_rate_is_not(name):
    """D58: reference_rates is a finance tool, so its values are sources like any tool result. A
    year's interest at its FD rate on the client's own amount is supported; the same sum at a
    rate the agent picked (7.4%) and does not state is not.

    Changed by D61: a percentage the answer states ("at 7.4%") is a free factor, a disclosed
    assumption, so the same call counts when the reply says the rate; D58 refused it."""
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
    out = checks_for(["That is about Rs 14,800 a year."], [*spans[:2], made_up], user=user)
    assert out["amounts"][0]["rejected"]["reason"] == "percent_of's input 7.4 is not supported"
    assert out["unsupported"] == 1
    stated = checks_for(
        ["At 7.4% that is about Rs 14,800 a year."], [*spans[:2], made_up], user=user
    )
    (record,) = stated["arithmetic"]
    assert [i["supported_by"] for i in record["inputs"]] == ["user", "free"]
    assert stated["amounts"][0]["verified_by"] == "tool"
    assert stated["unsupported"] == 0


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


def test_the_finance_servers_reference_rates_support_exactly_their_values():
    """The real data file (services/finance-mcp, served without `evidence`): every number the
    check reads from the tool's result is one of the rates, in order, so its names, dates and
    URLs support nothing else."""
    path = REPO / "services/finance-mcp/src/finance_mcp/reference_rates.json"
    data = json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal)
    data.pop("approval", None)  # not served either
    for rate in data["rates"].values():
        rate.pop("evidence")
    served = json.dumps(data, ensure_ascii=False, default=str)
    assert source_numbers(served) == [rate["value"] for rate in data["rates"].values()]


# ---- D61: verify, don't trace ---------------------------------------------------------------


def test_twelve_lakh_in_a_year_is_a_lakh_a_month():
    """Rishi's example for D61: the client's ₹12 lakh over a year is about ₹1 lakh a month, the
    client's figure divided by 12 (months in a year). Neither the ₹1 lakh nor a 12 is in any
    source, and the reply need not repeat the ₹12 lakh."""
    out = checks_for(
        ["To have it in a year, put aside about ₹1 lakh a month."],
        [turn_span(T, 0)],
        user=("I want to buy a ₹12 lakh car in a year.",),
    )
    (row,) = out["amounts"]
    assert (row["supported_by"], row["verified_by"]) == ("derived", "derived_in_prose")
    assert row["derivation"] == {
        "op": "divide",
        "operands": [
            {"value": 1200000, "where": "task:0"},
            {"value": 12, "where": "unit fact"},
        ],
        "value": 100000,
        "how": "exact",
    }
    assert (out["unsupported"], out["derived_in_prose"]) == (0, 1)


def test_three_months_of_expenses_is_the_monthly_figure_times_a_written_count():
    """ "3 months of expenses": the client file's monthly expenses times the 3 the reply writes
    before "months". Without the count in the reply there is nothing to multiply by."""
    files = {"client.json": '{"profile":{"monthly_expenses":40000}}'}
    reply = "Keep 3 months of expenses, ₹1,20,000, as an emergency fund."
    out = checks_for([reply], [turn_span(T, 0)], files=files)
    (row,) = out["amounts"]
    assert row["verified_by"] == "derived_in_prose"
    assert row["derivation"]["op"] == "multiply"
    assert row["derivation"]["operands"] == [
        {"value": 40000, "where": "client:client.json"},
        {"value": 3, "where": "answer:0"},
    ]
    vague = checks_for(["Keep ₹1,20,000 as an emergency fund."], [turn_span(T, 0)], files=files)
    assert vague["unsupported"] == 1


def test_multiply_100_by_12_alone_is_not_a_figure():
    """D61 closes the hole D58 left: both inputs are free factors, so the call has no sourced
    amount and its 1,200 does not count, and the checker cannot derive ₹1,200 from anything the
    agent had either."""
    call = span("multiply", T, '{"product":1200.00}', args={"values": [100, 12]})
    out = checks_for(["Save Rs 1,200 a year."], [turn_span(T, 0), call])
    (record,) = out["arithmetic"]
    assert [i["supported_by"] for i in record["inputs"]] == ["unit", "unit"]
    assert record["reason"] == (
        "multiply was given no sourced amount (a sourced number of 100 or more)"
    )
    (row,) = out["amounts"]
    assert (row["supported_by"], row["verified_by"]) == (None, None)
    assert row["rejected"]["where"] == "tool:multiply"


def test_a_run_of_figures_in_the_reply_adds_up_to_its_total():
    """A sum of several: three figures from the tools, written one after another, and their
    total next to them; repeated in a later reply, the total is still derived (a repeat)."""
    txns = '{"diwali":9650.00,"school":18500.00,"dining":2605.00}'
    spans = [turn_span(T, 0), span("list_transactions", T, txns, start=1)]
    replies = [
        "Diwali ₹9,650, school fees ₹18,500 and dining ₹2,605: ₹30,755 in all.",
        "Those three came to ₹30,755.",
    ]
    out = checks_for(replies, spans, user=("Where did it go?", "And in total?"))
    first, second = [r for r in out["amounts"] if r["text"] == "₹30,755"]
    assert first["derivation"]["op"] == "sum"
    assert [o["value"] for o in first["derivation"]["operands"]] == [9650, 18500, 2605]
    assert second["derivation"]["op"] == "repeat"
    assert (out["unsupported"], out["derived_in_prose"]) == (0, 2)


def test_a_round_estimate_or_an_example_is_not_derived():
    """The search stays narrow so that choices and estimates are not "verified" by chance:
    "about ₹40,200" for a saving of 40,211.63 matches only at trailing-zeros rounding, which a
    derivation may not use (DERIVE_COARSE), and "such as ₹3,000 a month" is not a derivation of
    anything. Both stay unsupported, as before D61."""
    plans = '{"interest_minimums":123171.63,"interest_extra":82960.00}'
    spans = [turn_span(T, 0), span("debt_payoff_plan", T, plans, start=1)]
    reply = (
        "Interest falls to about ₹82,960, saving about ₹40,200. Pay a fixed extra amount, such"
        " as ₹3,000 a month."
    )
    out = checks_for([reply], spans)
    assert [r["text"] for r in out["amounts"] if r["supported_by"] is None] == [
        "₹40,200",
        "₹3,000",
    ]
    exact = checks_for([reply.replace("about ₹40,200", "₹40,211.63")], spans)
    assert by_text(exact)["₹40,211.63"]["verified_by"] == "derived_in_prose"


def test_free_factors_written_counts_percentages_and_source_rates():
    assert percentages("at 7.4% a year, or 12 per cent; 9 %") == {
        Decimal("7.4"),
        Decimal("12"),
        Decimal("9"),
    }
    assert written_counts("3 months, 24 EMIs, two people, 2 Oct, month 14, ₹40 days") == {
        Decimal(3),
        Decimal(24),
        Decimal(2),
    }
    assert source_rates(
        '{"annual_rate_pct":42,"returned_count":16,"r":{"value":6.25,"unit":"percent per year"},'
        '"note":"FOIR 50%"}'
    ) == [Decimal(50), Decimal(42), Decimal("6.25")]
    assert checks.is_free_factor(Decimal(60), set()) and not checks.is_free_factor(
        Decimal(61), set()
    )
    assert checks.is_free_factor(Decimal("7.4"), {Decimal("7.4")})
    assert not checks.is_free_factor(Decimal("7.4"), set())


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
            "verified_by": "source",
            "derivation": None,
            "rejected": None,
        }
    ]
    assert checks["arithmetic"] == []
    assert checks["derived_in_prose"] == 0
    assert report["checks"] == {
        "path": "checks.json",
        "valid": True,
        "errors": [],
        "unsupported_amounts": 0,
        "amounts": 1,
        "derived_in_prose": 0,
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
# single-prompt answers are fully backed by tool results; every other amount is in a
# conversation. Before D61, 34 amounts were unsupported: arithmetic done in the reply (sums of
# transactions, differences between two plans, a month's interest by hand) or a figure the agent
# picked. Changed by D61: 15 of them are now verified as derived in prose (below), and 19 stay
# unsupported. Read by hand (A44): 11 of the 15 are the reply's real arithmetic (₹8,000 −
# ₹6,880 = ₹1,120, "₹6,880 (pharmacy ₹4,380 and a specialist visit ₹2,500)"), and 4 match by
# coincidence: LangGraph's ₹3,000 and ₹5,000 ("such as ₹3,000 or ₹5,000 a month") and ₹30,000,
# and the Agents SDK's ₹31,000. The 19 are two-step arithmetic (42% of ₹84,250, over 12), sums of
# figures the reply does not show, rounded estimates ("about ₹40,200" for 40,211.63: a
# derivation must match at the precision written, DERIVE_COARSE) and choices ("about ₹2,000 on
# the card").
EXPECTED_UNSUPPORTED = {
    "adk/claude-haiku-5-5/conversation": [],
    "adk/claude-haiku-5-5/single": [],
    "hermes/claude-haiku-5-5/conversation": ["₹40,200", "₹27,300", "₹2,000"],
    "hermes/claude-haiku-5-5/single": [],
    "langgraph/claude-haiku-5-5/conversation": ["₹12,280", "₹2,949"],
    "langgraph/claude-haiku-5-5/single": [],
    "openai-agents/claude-haiku-5-5/conversation": [
        "₹39,300",
        "₹2,605",
        "₹30,750",
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
EXPECTED_DERIVED = {
    "hermes/claude-haiku-5-5/conversation": ["₹13,579", "₹6,880", "₹1,120", "₹2,810", "₹2,810"],
    "langgraph/claude-haiku-5-5/conversation": [
        "₹30,000",
        "₹3,000",
        "₹5,000",
        "₹8,086.25",
        "₹6,880",
    ],
    "openai-agents/claude-haiku-5-5/conversation": [
        "₹40,650",
        "₹31,000",
        "₹25,100",
        "₹40,650",
        "₹6,880",
    ],
}


@pytest.mark.skipif(not REAL_TRIALS, reason=f"no real 4 Nov trials at {REAL}")
def test_on_the_real_4_nov_transcripts():
    found, derived, total = {}, {}, 0
    for trial in REAL_TRIALS:
        checks = check_trial(TrialPaths(trial))
        assert errors("checks", checks) == [], trial
        key = str(trial.parent.relative_to(REAL))
        if key.endswith("/settings"):
            assert checks["amounts"] == []  # each settings trial got a 400 and never replied
            continue
        found[key] = [r["text"] for r in checks["amounts"] if r["supported_by"] is None]
        mine = [r["text"] for r in checks["amounts"] if r["verified_by"] == "derived_in_prose"]
        if mine:
            derived[key] = mine
        assert checks["derived_in_prose"] == len(mine)
        total += len(checks["amounts"])
    assert found == EXPECTED_UNSUPPORTED
    assert derived == EXPECTED_DERIVED
    assert total == 230
    assert sum(len(v) for v in found.values()) == 19
    assert sum(len(v) for v in derived.values()) == 15
