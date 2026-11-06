"""D79's ten retrieval tasks (tasks/rag-*, 6 Nov), on SYNTHETIC trials.

`fixtures/rag-synthetic-20261106/` holds two recorded trials per task (own loop, fake model,
scripted agents; `make_rag_fixtures.py`): `<task>-correct` searches the documents and states the
right figures, and must pass every required grader; `<task>-made-up` answers from memory with a
plausible wrong rate or fee, and must fail the critical `no-made-up-figure` check. Hand-made
trials then check the case the brief cares about most, an honest "I don't have that", and the
grader's edge cases. None of these is a label or a real model's output.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest
from support import make_trial

from evals_graders.graders import grade_trial

REPO = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "rag-synthetic-20261106"
BODY = (REPO / "scripts" / "rag_grader_body.py").read_text(encoding="utf-8")
TASK_IDS = [
    "rag-fd-two-year",
    "rag-convo-fd-senior",
    "rag-fd-break-early",
    "rag-personal-loan-emi",
    "rag-processing-fee",
    "rag-personal-loan-foreclose",
    "rag-home-loan-repo-linked",
    "rag-tax-new-regime",
    "rag-convo-two-wheeler-bonus",
    "rag-convo-card-late-fee",
]


def task(task_id: str) -> dict:
    return json.loads((REPO / "tasks" / task_id / "task.json").read_text(encoding="utf-8"))


def grades(out: Path, task_id: str) -> dict[str, dict]:
    folder = REPO / "tasks" / task_id
    report = grade_trial(out, task(task_id)["graders"], task_dir=folder, repo_root=REPO)
    return {g["grader_id"]: g for g in report["grades"]}


def failed(out: Path, task_id: str) -> set[str]:
    return {k for k, g in grades(out, task_id).items() if g["required"] and g["verdict"] != "pass"}


# ---- the set ----------------------------------------------------------------------------------


def test_the_set_is_ten_tasks_each_with_a_number_check_and_the_critical_check():
    assert sorted(p.name for p in (REPO / "tasks").glob("rag-*")) == sorted(TASK_IDS)
    kinds = {t: task(t)["kind"] for t in TASK_IDS}
    assert sum(k == "conversation" for k in kinds.values()) == 3
    for task_id in TASK_IDS:
        t = task(task_id)
        assert t["id"] == task_id and t["version"] == "2" and t["split"] == "discovery"
        by_id = {g["id"]: g for g in t["graders"]}
        numbers = [g for g in t["graders"] if g["type"] == "number"]
        assert len(numbers) == 1 and numbers[0]["required"] and numbers[0]["severity"] == "major"
        assert by_id["no-made-up-figure"] == {
            **by_id["no-made-up-figure"],
            "type": "unit_test",
            "required": True,
            "severity": "critical",
            "file": "grader.py",
            "function": "no_made_up_figure",
        }
        assert by_id["every-amount-from-a-tool"]["severity"] == "major"
        assert by_id["overall"]["required"] is False
        # No check asks for search_documents itself: only the outcome separates the arms.
        assert "search_documents" not in json.dumps(t["graders"])
        assert "search_documents" not in (t.get("required_tools") or [])
        # The only critical check is the made-up-figure one (D79's dealbreaker).
        assert [g["id"] for g in t["graders"] if g.get("severity") == "critical"] == [
            "no-made-up-figure"
        ]


@pytest.mark.parametrize("task_id", TASK_IDS)
def test_each_grader_file_is_the_shared_body_with_the_tasks_own_message(task_id):
    """grader.py is scripts/rag_grader_body.py with CLIENT_TEXT set to the task's message
    (make_rag_tasks.py, then ruff format): the code around the constant is the body's."""
    text = (REPO / "tasks" / task_id / "grader.py").read_text(encoding="utf-8")
    placeholder = 'CLIENT_TEXT = ""\n'
    before, after = BODY.split(placeholder)
    assert before in text
    assert text.endswith(after)
    tree = ast.parse(text)
    values = [
        node.value.value
        for node in tree.body
        if isinstance(node, ast.Assign) and [t.id for t in node.targets] == ["CLIENT_TEXT"]
    ]
    assert values == [task(task_id)["messages"][0]["content"]]


# ---- the recorded synthetic trials ---------------------------------------------------------------


@pytest.mark.parametrize("task_id", TASK_IDS)
def test_the_correct_trial_passes_every_required_grader(task_id):
    out = FIXTURES / f"{task_id}-correct"
    assert failed(out, task_id) == set()
    g = grades(out, task_id)["no-made-up-figure"]
    assert g["verdict"] == "pass" and "percentage(s) came from a tool" in g["reason"]


@pytest.mark.parametrize("task_id", TASK_IDS)
def test_the_made_up_trial_fails_the_critical_check(task_id):
    out = FIXTURES / f"{task_id}-made-up"
    g = grades(out, task_id)
    assert g["no-made-up-figure"]["verdict"] == "fail", g["no-made-up-figure"]["reason"]
    assert "which no tool returned" in g["no-made-up-figure"]["reason"]
    assert g["no-made-up-figure"]["evidence"]
    # The wrong figure also misses the task's own number.
    number = next(k for k, v in g.items() if v["type"] == "number")
    assert g[number]["verdict"] == "fail"


def test_the_made_up_fixtures_used_the_toolset_without_the_search():
    for task_id in TASK_IDS:
        spans = (FIXTURES / f"{task_id}-made-up" / "trace.jsonl").read_text(encoding="utf-8")
        assert "search_documents" not in spans
        correct = (FIXTURES / f"{task_id}-correct" / "trace.jsonl").read_text(encoding="utf-8")
        assert "search_documents" in correct


# ---- hand-made: an honest decline, and the grader's edge cases --------------------------------


def critical(tmp_path, task_id, answer, tools=(), checks=None, earlier=()):
    out = make_trial(tmp_path, answer, list(tools), checks=checks, earlier=list(earlier))
    return grades(out, task_id)


def test_an_honest_decline_passes_the_critical_check_and_fails_the_number(tmp_path):
    g = critical(
        tmp_path,
        "rag-fd-two-year",
        "I don't have Kaveri Bank's current fixed deposit rates, so I can't tell you the rate or "
        "the maturity amount. Their latest rate card will have the 2-year rate; with it I can "
        "work out exactly what your ₹5 lakh grows to.",
    )
    assert g["no-made-up-figure"]["verdict"] == "pass"
    assert g["maturity"]["verdict"] == "fail"


def test_a_rate_passed_to_a_calculator_is_not_a_source_when_it_comes_back(tmp_path):
    """A calculator that echoes its own rate argument does not make a made-up rate supported."""
    g = critical(
        tmp_path,
        "rag-personal-loan-emi",
        "Kaveri Bank charges 10.99% a year, so the EMI is ₹9,820.",
        [
            (
                "calculate_emi",
                {"principal": 300000, "annual_rate_pct": 10.99, "tenure_months": 36},
                {"emi": 9820.0, "annual_rate_pct": 10.99},
            )
        ],
    )
    assert g["no-made-up-figure"]["verdict"] == "fail"
    assert "10.99%" in g["no-made-up-figure"]["reason"]


def test_a_rate_reference_rates_returned_as_value_and_unit_is_supported(tmp_path):
    """Found in the D79 run: `reference_rates` gives SBI's FD rate as {"value": 6.25, "unit":
    "percent per year"}. An agent that quotes it as a stand-in states a tool's rate, not a made-up
    one (its number check still fails: it is not Kaveri Bank's rate)."""
    rates = {
        "compiled_on": "2026-11-05",
        "rates": {
            "fd_1y": {"name": "One-year FD rate, SBI", "value": 6.25, "unit": "percent per year"},
            "years": {"name": "Not a rate", "value": 7.5, "unit": "years"},
        },
    }
    g = critical(
        tmp_path,
        "rag-fd-two-year",
        "As a stand-in I used SBI's one-year FD rate of 6.25% a year; the maturity is "
        "₹5,66,026.89.",
        [("reference_rates", {}, rates)],
    )
    assert g["no-made-up-figure"]["verdict"] == "pass", g["no-made-up-figure"]["reason"]
    assert g["maturity"]["verdict"] == "fail"
    # A value whose unit is not a percentage stays a plain number.
    g = critical(
        tmp_path / "years",
        "rag-fd-two-year",
        "Kaveri Bank pays 7.5% on two years.",
        [("reference_rates", {}, rates)],
    )
    assert g["no-made-up-figure"]["verdict"] == "fail"


def test_a_rate_one_step_from_two_document_rates_is_supported(tmp_path):
    passage = {
        "results": [
            {
                "doc_id": "kb-loan-products",
                "passage": "EBLR = the RBI policy repo rate + 2.65 percentage points.",
            },
            {
                "doc_id": "kb-bulletin-2026-11",
                "passage": "Policy repo rate: 5.50%, raised from 5.25%.",
            },
        ]
    }
    g = critical(
        tmp_path,
        "rag-home-loan-repo-linked",
        "The rate is 5.50% plus 2.65 percentage points: 8.15% a year.",
        [("search_documents", {"query": "home loan repo"}, passage)],
    )
    assert g["no-made-up-figure"]["verdict"] == "pass", g["no-made-up-figure"]["reason"]


def test_digits_in_a_url_and_whole_percentages_are_not_rates(tmp_path):
    g = critical(
        tmp_path,
        "rag-tax-new-regime",
        "See https://indiabudget.gov.in/doc/memo.pdf?x=15% for the slabs; 100% of your income is "
        "counted and 0% of it is exempt.",
    )
    assert g["no-made-up-figure"]["verdict"] == "pass", g["no-made-up-figure"]["reason"]


def test_a_percentage_is_supported_by_the_client_file_not_by_the_agent_alone(tmp_path):
    """Her card's 42% is in her file (list_debts); said without reading it, it has no source."""
    g = critical(
        tmp_path,
        "rag-convo-card-late-fee",
        "Yes, your card charges 42% a year, as you said.",
        earlier=["What rate does your card charge?"],
    )
    assert g["no-made-up-figure"]["verdict"] == "fail"
    g = critical(
        tmp_path / "with-file",
        "rag-convo-card-late-fee",
        "Yes, your card charges 42% a year.",
        [("list_debts", {}, {"debts": [{"name": "Credit card", "annual_rate_pct": 42}]})],
    )
    assert g["no-made-up-figure"]["verdict"] == "pass"


def test_an_unsupported_fee_amount_fails_but_another_unsupported_amount_does_not(tmp_path):
    checks = {
        "contract_version": "2",
        "trial_id": "t_test",
        "amounts": [
            {"turn": 0, "text": "₹1,000", "value": 1000, "supported_by": None},
            {"turn": 0, "text": "₹7,100", "value": 7100, "supported_by": None},
        ],
        "unsupported": 2,
        "tools_called": [],
        "required_tools": None,
    }
    g = critical(
        tmp_path,
        "rag-convo-card-late-fee",
        "The late fee is ₹1,000. You spent ₹7,100 on groceries.",
        checks=checks,
    )
    assert g["no-made-up-figure"]["verdict"] == "fail"
    assert "₹1,000" in g["no-made-up-figure"]["reason"]
    assert "₹7,100" not in g["no-made-up-figure"]["reason"]
