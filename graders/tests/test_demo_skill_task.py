"""The skills demo task (tasks/demo-skill-card-transfer, 5 Nov), on hand-made trial folders.

Its offer terms live only in the seeded skill configs/skills/balance-transfer-playbook.md, so an
answer that follows the playbook with the tools passes, and one that has to ask for the terms
fails. Not one of the experiment's 21 tasks (test_task_graders.py checks those).
"""

from __future__ import annotations

import json
from pathlib import Path

from support import make_trial

from evals_graders.graders import grade_trial

REPO = Path(__file__).resolve().parents[2]
FOLDER = REPO / "tasks" / "demo-skill-card-transfer"
SKILL = REPO / "configs" / "skills" / "balance-transfer-playbook.md"
DEBTS = {"debts": [{"name": "Credit card", "balance": 84250.0, "annual_rate_pct": 42}]}
TRANSFER = {"principal": 84250, "annual_rate_pct": 15, "tenure_months": 24}


def failed(out: Path) -> set[str]:
    graders = json.loads((FOLDER / "task.json").read_text(encoding="utf-8"))["graders"]
    report = grade_trial(out, graders, task_dir=FOLDER, repo_root=REPO)
    return {g["grader_id"] for g in report["grades"] if g["required"] and g["verdict"] != "pass"}


def checks(unsupported: int = 0) -> dict:
    amounts = [{"turn": 0, "text": "₹1", "value": 1, "supported_by": None}] * unsupported
    return {
        "contract_version": "2",
        "trial_id": "t_test",
        "amounts": amounts,
        "unsupported": unsupported,
        "tools_called": ["list_debts", "calculate_emi", "percent_of"],
        "required_tools": None,
    }


def test_an_answer_that_follows_the_playbook_passes(tmp_path):
    out = make_trial(
        tmp_path,
        "The transfer's EMI is ₹4,085.00 for 24 months, plus a ₹842.50 processing fee upfront. "
        "Its interest is ₹13,790.05, against ₹41,665.59 on your card over the same 24 months.",
        [
            ("list_debts", {}, DEBTS),
            ("calculate_emi", TRANSFER, {"emi": 4085.00, "total_interest": 13790.05}),
            ("percent_of", {"value": 84250, "percent": 1}, {"amount": 842.50}),
        ],
        checks=checks(),
    )
    assert failed(out) == set()


def test_an_answer_without_the_terms_fails(tmp_path):
    out = make_trial(
        tmp_path,
        "I don't have the terms of that offer. Could you share its rate, tenure and fees?",
        [("list_debts", {}, DEBTS)],
        checks=checks(),
    )
    assert failed(out) == {"transfer-emi-from-a-tool", "transfer-emi", "processing-fee"}


def test_the_skill_holds_the_terms_the_graders_expect():
    text = SKILL.read_text(encoding="utf-8")
    assert text.startswith("---\nname: balance-transfer-playbook\ndescription: ")
    assert "15% a year" in text and "24" in text and "1% of the amount transferred" in text
