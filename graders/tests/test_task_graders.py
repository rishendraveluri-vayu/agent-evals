"""The draft tasks' own graders (tasks/draft-*/), on hand-made trial folders (SP4, DRAFT for Rishi).

Each new task's grader list runs as a grading run would run it: on a trial that does the task
well (every required grader passes) and on one that shows the failure the task is built to expose
(wrong tool, made-up arguments, gave up early, a loop or the step limit). The grader.py files are
also checked on the edge cases their docstrings name. No model is called.
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


# ---- draft-first-year-interest: the tempting wrong tool --------------------------------------

SCHEDULE = {
    "granularity": "yearly",
    "emi": 26511.32,
    "total_interest": 3362717.65,
    "rows": [
        {
            "year": 1,
            "first_month": 1,
            "last_month": 12,
            "opening_balance": 3000000.00,
            "principal_paid": 57922.22,
            "interest_paid": 260213.62,
            "closing_balance": 2942077.78,
        }
    ],
}
SCHEDULE_ARGS = {"principal": 3000000, "annual_rate_pct": 8.75, "tenure_months": 240}


def test_first_year_interest_right_tool(tmp_path):
    out = make_trial(
        tmp_path,
        "Your EMI is ₹26,511.32. In the first year about ₹2,60,214 goes to interest and only "
        "₹57,922 reduces the loan.",
        [("amortization_schedule", SCHEDULE_ARGS, SCHEDULE)],
        checks=checks(called=["amortization_schedule"]),
    )
    report = run("draft-first-year-interest", out)
    assert report["outcome"] == "pass", report["outcome_reason"]


def test_first_year_interest_wrong_tool_and_shortcut(tmp_path):
    out = make_trial(
        tmp_path,
        "Your EMI is ₹26,511.32. In year one roughly ₹2,62,500 is interest (8.75% of ₹30 lakh) "
        "and about ₹55,636 is principal.",
        [("calculate_emi", SCHEDULE_ARGS, {"emi": 26511.32, "total_interest": 3362717.65})],
        checks=checks(called=["calculate_emi"], unsupported=2),
    )
    assert failed(run("draft-first-year-interest", out)) == {
        "used-schedule",
        "first-year-interest",
        "first-year-principal",
        "every-amount-from-a-tool",
    }


# ---- draft-prepay-personal-loan: arguments from the client's file ----------------------------

PREPAY = {"mode": "reduce_tenure", "interest_saved": 42874.99, "months_saved": 13}
FILE_ARGS = {
    "outstanding_principal": 310000,
    "annual_rate_pct": 14.5,
    "remaining_months": 36,
    "prepayment_amount": 100000,
}


def test_prepay_personal_loan_terms_from_the_file(tmp_path):
    out = make_trial(
        tmp_path,
        "Prepaying ₹1 lakh would save about ₹42,875 in interest and end the loan 13 months "
        "sooner. But your credit card charges 42%, so clear its ₹84,250 first.",
        [("list_debts", {}, {"count": 3}), ("prepayment_impact", FILE_ARGS, PREPAY)],
        checks=checks(["list_debts"], ["list_debts", "prepayment_impact"]),
    )
    report = run("draft-prepay-personal-loan", out)
    assert report["outcome"] == "pass", report["outcome_reason"]


def test_prepay_personal_loan_made_up_terms(tmp_path):
    made_up = {**FILE_ARGS, "outstanding_principal": 300000, "annual_rate_pct": 12}
    out = make_trial(
        tmp_path,
        "Prepaying ₹1 lakh would save about ₹31,200 in interest.",
        [("prepayment_impact", made_up, {**PREPAY, "interest_saved": 31200.4})],
        checks=checks(["list_debts"], ["prepayment_impact"]),
    )
    assert failed(run("draft-prepay-personal-loan", out)) == {
        "read-the-file",
        "loan-terms-from-file",
        "interest-saved",
        "mentions-card",
    }


# ---- draft-college-cost-stepup: three chained answers, easy to abandon ------------------------

COST_ARGS = {"amount": 1500000, "annual_inflation_pct": 10, "years": 13, "direction": "future_cost"}
SIP_ARGS = {"monthly_investment": 12000, "expected_annual_return_pct": 12, "years": 13}


def test_college_cost_all_three_steps(tmp_path):
    out = make_trial(
        tmp_path,
        "The degree will cost about ₹51.78 lakh in 13 years. A ₹12,000 SIP at 12% grows to "
        "₹45.11 lakh, which falls short. With a 5% step-up each year it reaches ₹56.75 lakh, "
        "which is enough. 12% is not guaranteed.",
        [
            ("inflation_adjusted_value", COST_ARGS, {"adjusted_value": 5178406.82}),
            ("sip_future_value", SIP_ARGS, {"corpus": 4511173.74}),
            ("sip_future_value", {**SIP_ARGS, "annual_step_up_pct": 5}, {"corpus": 5675167.91}),
        ],
        checks=checks(called=["inflation_adjusted_value", "sip_future_value"]),
    )
    report = run("draft-college-cost-stepup", out)
    assert report["outcome"] == "pass", report["outcome_reason"]


def test_college_cost_gave_up_after_the_first_step(tmp_path):
    out = make_trial(
        tmp_path,
        "The degree will cost about ₹51.78 lakh in 13 years. A SIP with a step-up could help; "
        "tell me if you want me to check.",
        [("inflation_adjusted_value", COST_ARGS, {"adjusted_value": 5178406.82})],
        checks=checks(called=["inflation_adjusted_value"]),
    )
    assert failed(run("draft-college-cost-stepup", out)) == {
        "stepup-tool",
        "sip-corpus",
        "stepup-corpus",
    }


# ---- draft-spending-review: many calls, loops and the step limit ------------------------------

SPENDING = "draft-spending-review"


def test_spending_review_one_call_per_category_is_not_a_loop(tmp_path):
    tools = [
        ("list_transactions", {"category": "groceries"}, {"total_debits": 8086.25}),
        ("list_transactions", {"category": "dining"}, {"total_debits": 2605.00}),
        ("list_debts", {}, {"total_minimum_payments": 18332.50}),
        ("debt_payoff_plan", {"debts": [], "monthly_budget": 18332.5}, {"months_to_debt_free": 31}),
        ("debt_payoff_plan", {"debts": [], "monthly_budget": 23332.5}, {"months_to_debt_free": 23}),
    ]
    out = make_trial(
        tmp_path,
        "Groceries were ₹8,086.25 and dining ₹2,605. Trim dining and skip one-off shopping. "
        "With ₹23,332.50 a month you are debt-free in 23 months instead of 31.",
        tools,
        checks=checks(
            ["list_transactions", "list_debts"],
            ["list_transactions", "list_debts", "debt_payoff_plan"],
        ),
    )
    report = run(SPENDING, out)
    assert report["outcome"] == "pass", report["outcome_reason"]


def test_spending_review_loop_to_the_step_limit(tmp_path):
    tools = [("list_transactions", {"limit": 50}, {"total_debits": 89869.15})] * 2
    tools += [("list_transactions", {"limit": 50, "category": "rent"}, {"total_debits": 22000})]
    out = make_trial(
        tmp_path,
        None,
        tools,
        end_state="step_limit",
        checks=checks(["list_transactions", "list_debts"], ["list_transactions"]),
    )
    report = run(SPENDING, out)
    expected = {"no-repeated-calls", "ends-answered", "read-the-file", "payoff-with-extra"}
    assert expected <= failed(report)
    assert "list_transactions x2" in report["by_id"]["no-repeated-calls"]["reason"]


def test_spending_review_key_order_does_not_hide_a_repeat(tmp_path):
    tools = [
        ("list_transactions", {"category": "dining", "limit": 10}, {}),
        ("list_transactions", {"limit": 10, "category": "dining"}, {}),
    ]
    out = make_trial(tmp_path, "Dining was ₹2,605.", tools)
    assert verdict(SPENDING, out, "no-repeated-calls") == "fail"


# ---- draft-convo-job-loss: figures from the file, the person before the numbers ---------------

JOB = "draft-convo-job-loss"


def test_job_loss_care_first_and_the_runway_figures(tmp_path):
    out = make_trial(
        tmp_path,
        "Until you hear, keep the ₹60,000 as cash and do not prepay anything.",
        [
            ("get_client_profile", {}, {"profile": {"emergency_fund": 60000}}),
            ("list_debts", {}, {"total_minimum_payments": 18332.50}),
        ],
        earlier=[
            "That is a stressful week, and it makes sense to plan now. "
            "Your EMIs and card minimum come to ₹18,332.50 a month."
        ],
        checks=checks(["get_client_profile", "list_debts"], ["get_client_profile", "list_debts"]),
    )
    report = run(JOB, out)
    assert report["outcome"] == "pass", report["outcome_reason"]


def test_job_loss_parts_of_the_debt_payments_count(tmp_path):
    out = make_trial(
        tmp_path,
        "I'm sorry, that is a lot. Your fund is Rs 60,000; "
        "EMIs ₹14,120 and the card ₹4,212.50 a month.",
    )
    assert verdict(JOB, out, "runway-figures") == "pass"


def test_job_loss_numbers_first_and_no_fund(tmp_path):
    out = make_trial(
        tmp_path,
        "Your debts cost ₹18,332.50 a month. Cut spending now.",
        [("list_debts", {}, {"total_minimum_payments": 18332.50})],
        checks=checks(["get_client_profile", "list_debts"], ["list_debts"]),
    )
    assert failed(run(JOB, out)) == {"read-the-file", "runway-figures", "care-first"}


# ---- draft-convo-phone-loan: a monthly extra needs the payoff plan ----------------------------

PHONE = "draft-convo-phone-loan"
LOAN = {
    "name": "Personal loan",
    "balance": 111637.62,
    "annual_rate_pct": 18,
    "minimum_payment": 7488.62,
}


def test_phone_loan_cost_from_the_file_and_the_payoff_plan(tmp_path):
    out = make_trial(
        tmp_path,
        "With ₹3,000 a month more, the loan is done in 12 months and you pay ₹10,917 in interest.",
        [
            ("list_debts", {}, {"debts": [LOAN | {"remaining_months": 17}]}),
            (
                "calculate_emi",
                {"principal": 111637.62, "annual_rate_pct": 18, "tenure_months": 17},
                {"total_interest": 15668.79},
            ),
            (
                "debt_payoff_plan",
                {"debts": [LOAN], "monthly_budget": 10488.62},
                {"months_to_debt_free": 12, "total_interest": 10917.46},
            ),
        ],
        earlier=["No lecture from me. The loan will still cost you about ₹15,669 in interest."],
        checks=checks(["list_debts"], ["list_debts", "calculate_emi", "debt_payoff_plan"]),
    )
    report = run(PHONE, out)
    assert report["outcome"] == "pass", report["outcome_reason"]


def test_phone_loan_one_time_prepayment_is_the_wrong_tool(tmp_path):
    one_off = {
        "outstanding_principal": 111637.62,
        "annual_rate_pct": 18,
        "remaining_months": 17,
        "prepayment_amount": 3000,
    }
    out = make_trial(
        tmp_path,
        "Paying ₹3,000 extra saves you ₹864 in interest.",
        [
            ("list_debts", {}, {"debts": [LOAN | {"remaining_months": 17}]}),
            ("prepayment_impact", one_off, {"interest_saved": 864.04, "months_saved": 0}),
        ],
        checks=checks(["list_debts"], ["list_debts", "prepayment_impact"]),
    )
    assert failed(run(PHONE, out)) == {
        "remaining-interest",
        "extra-payment-plan",
        "months-with-extra",
    }
