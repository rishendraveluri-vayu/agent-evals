"""The draft tasks' own graders (tasks/draft-*/), on hand-made trial folders (SP4, DRAFT for Rishi).

draft-mba-loan-missing-info's grader.py on the two real 4 Nov answers that failed the old
check for a literal "?", and on answers that should pass or fail it. No model is called.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from support import make_trial

from evals_graders.graders import grade_trial

TASKS = Path(__file__).resolve().parents[2] / "tasks"


def task(task_id: str) -> tuple[list[dict], Path]:
    folder = TASKS / task_id
    return json.loads((folder / "task.json").read_text(encoding="utf-8"))["graders"], folder


def checks(required: list[str] | None = None, called=(), unsupported: int = 0) -> dict:
    """A checks.json in contract v2's shape."""
    req = None
    if required is not None:
        req = {
            "required": required,
            "called": [t for t in required if t in called],
            "missing": [t for t in required if t not in called],
            "only_errors": [],
        }
    amounts = [{"turn": 0, "text": "₹1", "value": 1, "supported_by": None}] * unsupported
    return {
        "contract_version": "2",
        "trial_id": "t_test",
        "amounts": amounts,
        "unsupported": unsupported,
        "tools_called": list(called),
        "required_tools": req,
    }


def run(task_id: str, out: Path, only: str | None = None) -> dict:
    graders, folder = task(task_id)
    if only:
        graders = [g for g in graders if g["id"] == only]
    report = grade_trial(out, graders, task_dir=folder)
    report["by_id"] = {g["grader_id"]: g for g in report["grades"]}
    return report


def verdict(task_id: str, out: Path, grader_id: str) -> str:
    return run(task_id, out, grader_id)["by_id"][grader_id]["verdict"]


def failed(report: dict) -> set[str]:
    return {g["grader_id"] for g in report["grades"] if g["required"] and g["verdict"] != "pass"}


# ---- draft-mba-loan-missing-info: asks for the missing facts in any form ---------------------

MBA = "draft-mba-loan-missing-info"
ASKS = "asks-for-missing-facts"

# The two 4 Nov label-batch answers (experiment e_0mw273dpt486807c2722a92dc, Haiku 5.5), verbatim:
# both failed the old /\?/ check although both ask for four missing facts.
HERMES_MBA = (
    "I don't have a client profile on file, so I can't check your income, existing debts or "
    "savings yet. A ₹15 lakh MBA loan can be a sound investment or a heavy burden, depending on "
    "the numbers.\n"
    "\n"
    "To give you a real answer, I need:\n"
    "\n"
    "1. **Interest rate and tenure** offered (or the loan term you're considering)\n"
    "2. **Course fees and total cost**, including living expenses, and whether the loan covers "
    "all of it\n"
    "3. **Expected salary after the MBA**, and your take-home pay today\n"
    "4. **Other EMIs or debts** you already pay each month\n"
    "\n"
    "With the rate and tenure, I can work out the monthly EMI and total interest, and check "
    "whether the EMI is affordable against your income."
)
OWNLOOP_MBA = (
    "I can help you think this through, but I don't have your profile on file, so I don't yet "
    "know your income, existing EMIs or the loan terms. An MBA can be a good investment, but it "
    "depends on the cost and what it does for your earnings.\n"
    "\n"
    "To run the numbers, could you share:\n"
    "\n"
    "1. **Loan terms:** the interest rate offered and the tenure (for example, 5 or 7 years).\n"
    "2. **Monthly take-home income**, and any EMIs you already pay.\n"
    "3. **Total course cost** and any expected fees, or a scholarship or sponsorship that "
    "reduces the loan.\n"
    "4. **Expected salary after the MBA**, or the range you're targeting.\n"
    "\n"
    "With these I can calculate your EMI, total interest, how much you can afford under the "
    "usual FOIR limit, and whether the expected salary covers the repayments comfortably."
)


@pytest.mark.parametrize(
    "answer",
    [
        HERMES_MBA,
        OWNLOOP_MBA,
        "What rate and tenure has the bank offered, and what salary do you expect after the MBA?",
        "Before I can say, please share the loan's rate of interest and your expected salary.",
    ],
    ids=["hermes-4nov", "ownloop-4nov", "one-question", "please-share"],
)
def test_mba_asks_for_missing_facts_in_any_form(tmp_path, answer):
    grade = run(MBA, make_trial(tmp_path, answer), ASKS)["by_id"][ASKS]
    assert grade["verdict"] == "pass", grade["reason"]
    for ev in grade["evidence"]:
        assert ev["quote"] in answer


@pytest.mark.parametrize(
    "answer",
    [
        "An MBA from a good school usually pays off. Take the loan from a public sector bank.",
        "Assuming 10% for 7 years, the EMI would be ₹24,901 and your salary should cover it. "
        "Let me know if you'd like more help.",
        "What interest rate is the bank offering?",
        "I can't see your income, the interest rate or the tenure. MBAs vary a lot. "
        "Is that what you wanted to hear?",
    ],
    ids=["no-request", "invents-then-let-me-know", "one-fact-only", "facts-outside-the-request"],
)
def test_mba_fails_without_a_request_for_the_facts(tmp_path, answer):
    assert verdict(MBA, make_trial(tmp_path, answer), ASKS) == "fail"


def test_mba_no_answer_fails(tmp_path):
    assert verdict(MBA, make_trial(tmp_path, None, end_state="step_limit"), ASKS) == "fail"
