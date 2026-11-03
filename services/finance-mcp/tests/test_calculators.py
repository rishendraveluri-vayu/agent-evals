"""Calculator values against an independent reference.

The reference below uses exact rational arithmetic (fractions.Fraction) and shares no code with
the server, so a bug in the Decimal implementation cannot hide in both. Where a value is widely
published (the ₹10 lakh / 9% / 20-year EMI) it is also pinned as a literal.
"""

import math
from decimal import Decimal
from fractions import Fraction as F

import pytest
from finance_mcp import calculators as calc
from finance_mcp.money import FinanceInputError

# --- independent reference ----------------------------------------------------------------------


def paise(x: F) -> F:
    """Round half-up (away from zero) to 0.01."""
    cents = abs(x) * 100
    whole = math.floor(cents + F(1, 2))
    return F(whole if x >= 0 else -whole, 100)


def D(x: F) -> Decimal:
    """An exact 2-decimal Fraction as a Decimal with two places."""
    cents = x * 100
    assert cents.denominator == 1, x
    return Decimal(cents.numerator).scaleb(-2)


def ref_emi(p: F, pct: F, n: int) -> F:
    if pct == 0:
        return paise(p / n)
    r = pct / 1200
    growth = (1 + r) ** n
    return paise(p * r * growth / (growth - 1))


def ref_schedule(p: F, pct: F, n: int, emi: F) -> list[tuple[F, F, F, F]]:
    """(opening, interest, payment, closing) per month; last month pays everything due."""
    rows, balance = [], p
    for month in range(1, n + 1):
        interest = paise(balance * pct / 1200)
        payment = balance + interest if month == n else emi
        closing = balance + interest - payment
        rows.append((balance, interest, payment, closing))
        balance = closing
    return rows


def ref_fixed_payment_months(p: F, pct: F, payment: F, cap: int) -> tuple[int, F, F]:
    balance, total_interest = p, F(0)
    for month in range(1, cap + 1):
        interest = paise(balance * pct / 1200)
        total_interest += interest
        due = balance + interest
        if due <= payment or month == cap:
            return month, due, total_interest
        balance = due - payment
    raise AssertionError


# --- 1. EMI -------------------------------------------------------------------------------------


def test_emi_ten_lakh_at_nine_percent_for_twenty_years() -> None:
    result = calc.calculate_emi(1000000, 9, 240)
    emi = ref_emi(F(1000000), F(9), 240)
    rows = ref_schedule(F(1000000), F(9), 240, emi)
    assert D(emi) == Decimal("8997.26")  # the widely published figure
    assert result["emi"] == Decimal("8997.26")
    assert result["emi_formatted"] == "₹8,997.26"
    assert result["final_payment"] == D(rows[-1][2])
    assert result["total_interest"] == D(sum(r[1] for r in rows)) == Decimal("1159342.12")
    assert result["total_payable"] == D(sum(r[2] for r in rows)) == Decimal("2159342.12")
    assert result["total_interest_words"] == "11.59 lakh"
    assert result["tenure_months"] == 240


def test_emi_fractional_rate_matches_reference() -> None:
    result = calc.calculate_emi(2500000, 8.35, 180)
    emi = ref_emi(F(2500000), F("8.35"), 180)
    rows = ref_schedule(F(2500000), F("8.35"), 180, emi)
    assert result["emi"] == D(emi)
    assert result["total_interest"] == D(sum(r[1] for r in rows))


def test_zero_rate_loan_splits_principal_and_closes_exactly() -> None:
    result = calc.calculate_emi(100000, 0, 3)
    assert result["emi"] == Decimal("33333.33")
    assert result["final_payment"] == Decimal("33333.34")
    assert result["total_interest"] == Decimal("0.00")
    assert result["total_payable"] == Decimal("100000.00")


def test_one_month_loan() -> None:
    result = calc.calculate_emi(10000, 12, 1)
    assert result["emi"] == Decimal("10100.00")
    assert result["final_payment"] == Decimal("10100.00")
    assert result["total_interest"] == Decimal("100.00")


# --- 2. amortisation ----------------------------------------------------------------------------


def test_schedule_yearly_closes_at_exactly_zero_and_sums_to_principal() -> None:
    result = calc.amortization_schedule(1000000, 9, 240)
    rows = result["rows"]
    assert result["granularity"] == "yearly"
    assert len(rows) == result["total_periods"] == result["rows_returned"] == 20
    assert result["next_start_period"] is None
    assert rows[-1]["closing_balance"] == Decimal("0.00")
    assert rows[-1]["closing_balance_formatted"] == "₹0.00"
    assert sum(r["principal_paid"] for r in rows) == Decimal("1000000.00")
    assert sum(r["interest_paid"] for r in rows) == result["total_interest"]
    for previous, row in zip(rows, rows[1:], strict=False):
        assert row["opening_balance"] == previous["closing_balance"]
    assert (rows[0]["year"], rows[0]["first_month"], rows[0]["last_month"]) == (1, 1, 12)


def test_schedule_says_when_the_final_payment_is_adjusted() -> None:
    result = calc.amortization_schedule(1000000, 9, 240)
    assert result["final_payment_adjusted"] is True
    assert result["final_payment"] == Decimal("8996.98")
    assert result["note"] == (
        "The final payment is ₹8,996.98, adjusted from the EMI of ₹8,997.26 so the balance "
        "closes at exactly ₹0.00."
    )


def test_schedule_partial_last_year_and_monthly_rows_match_reference() -> None:
    yearly = calc.amortization_schedule(500000, 8.5, 30)
    assert [(r["first_month"], r["last_month"]) for r in yearly["rows"]] == [
        (1, 12),
        (13, 24),
        (25, 30),
    ]
    monthly = calc.amortization_schedule(500000, 8.5, 30, granularity="monthly")
    emi = ref_emi(F(500000), F("8.5"), 30)
    ref = ref_schedule(F(500000), F("8.5"), 30, emi)
    assert len(monthly["rows"]) == 30
    for row, (opening, interest, payment, closing) in zip(monthly["rows"], ref, strict=True):
        assert row["opening_balance"] == D(opening)
        assert row["interest_paid"] == D(interest)
        assert row["principal_paid"] == D(payment - interest)
        assert row["closing_balance"] == D(closing)
    assert monthly["rows"][-1]["closing_balance"] == Decimal("0.00")


def test_monthly_schedule_pages_at_sixty_rows() -> None:
    first = calc.amortization_schedule(1000000, 9, 240, granularity="monthly")
    assert first["rows_returned"] == 60
    assert first["next_start_period"] == 61
    assert first["rows"][-1]["month"] == 60
    last = calc.amortization_schedule(1000000, 9, 240, granularity="monthly", start_period=181)
    assert [r["month"] for r in last["rows"]] == list(range(181, 241))
    assert last["next_start_period"] is None
    assert last["rows"][-1]["closing_balance"] == Decimal("0.00")


def test_zero_rate_schedule_closes_exactly() -> None:
    result = calc.amortization_schedule(100000, 0, 3, granularity="monthly")
    assert [r["principal_paid"] for r in result["rows"]] == [
        Decimal("33333.33"),
        Decimal("33333.33"),
        Decimal("33333.34"),
    ]
    assert result["rows"][-1]["closing_balance"] == Decimal("0.00")


# --- 3. prepayment ------------------------------------------------------------------------------


def test_prepayment_reduce_emi() -> None:
    result = calc.prepayment_impact(1000000, 9, 240, 200000, mode="reduce_emi")
    old = ref_schedule(F(1000000), F(9), 240, ref_emi(F(1000000), F(9), 240))
    new_emi = ref_emi(F(800000), F(9), 240)
    new = ref_schedule(F(800000), F(9), 240, new_emi)
    old_interest, new_interest = sum(r[1] for r in old), sum(r[1] for r in new)
    assert result["current_emi"] == Decimal("8997.26")
    assert result["new_emi"] == D(new_emi) == Decimal("7197.81")
    assert result["new_tenure_months"] == 240
    assert result["months_saved"] == 0
    assert result["current_total_interest"] == D(old_interest)
    assert result["new_total_interest"] == D(new_interest)
    assert result["interest_saved"] == D(old_interest - new_interest)
    assert result["emi_reduction"] == Decimal("1799.45")


def test_prepayment_reduce_tenure() -> None:
    result = calc.prepayment_impact(1000000, 9, 240, 200000, mode="reduce_tenure")
    emi = ref_emi(F(1000000), F(9), 240)
    old_interest = sum(r[1] for r in ref_schedule(F(1000000), F(9), 240, emi))
    months, final, new_interest = ref_fixed_payment_months(F(800000), F(9), emi, 240)
    assert result["new_emi"] == result["current_emi"] == D(emi)
    assert result["new_tenure_months"] == months
    assert result["months_saved"] == 240 - months
    assert result["new_final_payment"] == D(final)
    assert result["new_final_payment"] <= result["new_emi"]
    assert result["interest_saved"] == D(old_interest - new_interest)
    assert months < 240


def test_reduce_tenure_saves_more_interest_than_reduce_emi() -> None:
    tenure = calc.prepayment_impact(1000000, 9, 240, 200000, mode="reduce_tenure")
    emi = calc.prepayment_impact(1000000, 9, 240, 200000, mode="reduce_emi")
    assert tenure["interest_saved"] > emi["interest_saved"]


def test_prepayment_must_be_less_than_outstanding() -> None:
    with pytest.raises(FinanceInputError, match="less than outstanding_principal"):
        calc.prepayment_impact(100000, 9, 12, 100000)


# --- 4. debt payoff -----------------------------------------------------------------------------

THREE_DEBTS = [
    {"name": "Credit card", "balance": 50000, "annual_rate_pct": 36, "minimum_payment": 2500},
    {"name": "Personal loan", "balance": 200000, "annual_rate_pct": 14, "minimum_payment": 6000},
    {"name": "Loan from uncle", "balance": 15000, "annual_rate_pct": 0, "minimum_payment": 1000},
]


def test_two_month_avalanche_by_hand() -> None:
    # Month 1: A accrues 10.00 -> 1010.00; minimums A 100 -> 910.00, B 50 -> 450.00; surplus 850
    # goes to A (12% beats 0%) -> 60.00. Month 2: A accrues 0.60 -> 60.60 and its minimum clears
    # it; B pays 50 -> 400.00; surplus 889.40 clears B. Interest 10.60, paid 1510.60.
    debts = [
        {"name": "A", "balance": 1000, "annual_rate_pct": 12, "minimum_payment": 100},
        {"name": "B", "balance": 500, "annual_rate_pct": 0, "minimum_payment": 50},
    ]
    result = calc.debt_payoff_plan(debts, 1000, "avalanche")
    assert result["months_to_debt_free"] == 2
    assert result["payoff_order"] == ["A", "B"]
    assert result["total_interest"] == Decimal("10.60")
    assert result["total_paid"] == Decimal("1510.60")
    assert [d["cleared_in_month"] for d in result["debts"]] == [2, 2]


def test_two_month_snowball_by_hand() -> None:
    # Month 1: A -> 1010.00; minimums A -> 910.00, B -> 450.00; surplus 850 clears B (smallest)
    # and 400 more goes to A -> 510.00. Month 2: A accrues 5.10 -> 515.10, cleared.
    debts = [
        {"name": "A", "balance": 1000, "annual_rate_pct": 12, "minimum_payment": 100},
        {"name": "B", "balance": 500, "annual_rate_pct": 0, "minimum_payment": 50},
    ]
    result = calc.debt_payoff_plan(debts, 1000, "snowball")
    assert result["priority_order"] == ["B", "A"]
    assert result["payoff_order"] == ["B", "A"]
    assert [d["cleared_in_month"] for d in result["debts"]] == [1, 2]
    assert result["total_interest"] == Decimal("15.10")
    assert result["total_paid"] == Decimal("1515.10")


def test_avalanche_and_snowball_order_three_debts_differently() -> None:
    avalanche = calc.debt_payoff_plan(THREE_DEBTS, 15000, "avalanche")
    snowball = calc.debt_payoff_plan(THREE_DEBTS, 15000, "snowball")
    assert avalanche["priority_order"] == ["Credit card", "Personal loan", "Loan from uncle"]
    assert snowball["priority_order"] == ["Loan from uncle", "Credit card", "Personal loan"]
    assert avalanche["payoff_order"][0] == "Credit card"
    assert snowball["payoff_order"][0] == "Loan from uncle"
    assert avalanche["debt_free"] and snowball["debt_free"]
    assert avalanche["total_interest"] < snowball["total_interest"]
    for plan in (avalanche, snowball):
        assert plan["total_paid"] == Decimal(265000) + plan["total_interest"]
        assert all(d["remaining_balance"] == Decimal("0.00") for d in plan["debts"])
        assert plan["total_minimum_payments"] == Decimal("9500.00")
        assert plan["surplus_over_minimums"] == Decimal("5500.00")


def test_budget_below_minimums_is_an_error() -> None:
    with pytest.raises(FinanceInputError, match=r"below the sum of minimum payments ₹9,500.00"):
        calc.debt_payoff_plan(THREE_DEBTS, 9499.99)


def test_budget_equal_to_minimums_is_allowed() -> None:
    assert calc.debt_payoff_plan(THREE_DEBTS, 9500)["debt_free"] is True


def test_plan_that_never_clears_stops_at_600_months() -> None:
    debts = [{"name": "Card", "balance": 100000, "annual_rate_pct": 36, "minimum_payment": 2000}]
    result = calc.debt_payoff_plan(debts, 2000)
    assert result["debt_free"] is False
    assert result["months_to_debt_free"] is None
    assert result["months_simulated"] == 600
    assert result["payoff_order"] == []
    assert result["debts"][0]["cleared_in_month"] is None
    assert result["debts"][0]["remaining_balance"] > Decimal(100000)


def test_ties_keep_input_order() -> None:
    debts = [
        {"name": "X", "balance": 1000, "annual_rate_pct": 10, "minimum_payment": 10},
        {"name": "Y", "balance": 1000, "annual_rate_pct": 10, "minimum_payment": 10},
    ]
    assert calc.debt_payoff_plan(debts, 100, "avalanche")["priority_order"] == ["X", "Y"]
    assert calc.debt_payoff_plan(debts, 100, "snowball")["priority_order"] == ["X", "Y"]


# --- 5. SIP -------------------------------------------------------------------------------------


def ref_sip(monthly: F, pct: F, years: int, step: F) -> tuple[F, F]:
    growth, value, invested = 1 + pct / 1200, F(0), F(0)
    for year in range(years):
        contribution = paise(monthly * (1 + step / 100) ** year)
        for _ in range(12):
            value = (value + contribution) * growth
            invested += contribution
    return paise(value), invested


def test_sip_without_step_up_is_the_annuity_due_formula() -> None:
    result = calc.sip_future_value(10000, 12, 10)
    i = F(1, 100)
    closed_form = paise(10000 * ((1 + i) ** 120 - 1) / i * (1 + i))
    assert result["corpus"] == D(closed_form) == Decimal("2323390.76")
    assert result["total_invested"] == Decimal("1200000.00")
    assert result["gains"] == Decimal("1123390.76")
    assert result["corpus_words"] == "23.23 lakh"
    assert result["months"] == 120


def test_sip_with_step_up() -> None:
    result = calc.sip_future_value(10000, 12, 10, annual_step_up_pct=10)
    corpus, invested = ref_sip(F(10000), F(12), 10, F(10))
    assert result["corpus"] == D(corpus)
    assert result["total_invested"] == D(invested)
    assert result["final_monthly_investment"] == Decimal("23579.48")  # 10000 * 1.1^9
    assert result["corpus"] > calc.sip_future_value(10000, 12, 10)["corpus"]


def test_sip_zero_return_is_just_the_contributions() -> None:
    result = calc.sip_future_value(5000, 0, 2)
    assert result["corpus"] == result["total_invested"] == Decimal("120000.00")
    assert result["gains"] == Decimal("0.00")


# --- 6. FD --------------------------------------------------------------------------------------


def test_fd_quarterly_default() -> None:
    result = calc.fd_maturity(100000, 7, 5)
    expected = paise(100000 * (1 + F(7, 400)) ** 20)
    assert result["compounding"] == "quarterly"
    assert result["full_periods"] == 20
    assert result["part_period"] == Decimal(0)
    assert result["maturity_amount"] == D(expected) == Decimal("141477.82")
    assert result["interest_earned"] == Decimal("41477.82")


def test_fd_other_compounding() -> None:
    monthly = calc.fd_maturity(100000, 7, 5, "monthly")
    yearly = calc.fd_maturity(100000, 7, 5, "annually")
    assert monthly["maturity_amount"] == D(paise(100000 * (1 + F(7, 1200)) ** 60))
    assert (
        yearly["maturity_amount"] == D(paise(100000 * (1 + F(7, 100)) ** 5)) == Decimal("140255.17")
    )
    assert monthly["maturity_amount"] > calc.fd_maturity(100000, 7, 5)["maturity_amount"]


def test_fd_part_period_earns_simple_interest() -> None:
    eighteen_months = calc.fd_maturity(100000, 7, 1.5)
    assert eighteen_months["full_periods"] == 6
    assert eighteen_months["maturity_amount"] == D(paise(100000 * (1 + F(7, 400)) ** 6))
    broken = calc.fd_maturity(100000, 7, 1.1)  # 4.4 quarters: 4 compound, 0.4 simple
    assert (broken["full_periods"], broken["part_period"]) == (4, Decimal("0.4"))
    expected = paise(100000 * (1 + F(7, 400)) ** 4 * (1 + F(4, 10) * F(7, 400)))
    assert broken["maturity_amount"] == D(expected)


# --- 7. inflation -------------------------------------------------------------------------------


def test_inflation_future_cost_and_present_value() -> None:
    future = calc.inflation_adjusted_value(100000, 6, 10)
    present = calc.inflation_adjusted_value(100000, 6, 10, "present_value")
    factor = F(106, 100) ** 10
    assert future["adjusted_value"] == D(paise(100000 * factor)) == Decimal("179084.77")
    assert present["adjusted_value"] == D(paise(100000 / factor)) == Decimal("55839.48")
    assert (
        future["cumulative_inflation_pct"]
        == present["cumulative_inflation_pct"]
        == Decimal("79.08")
    )
    assert future["adjusted_value_words"] == "1.79 lakh"


# --- 8. FOIR affordability ----------------------------------------------------------------------


def ref_max_loan(emi: F, pct: F, n: int) -> F:
    if pct == 0:
        return emi * n
    r = pct / 1200
    growth = (1 + r) ** n
    return paise(emi * (growth - 1) / (r * growth))


def test_affordability_within_limit() -> None:
    result = calc.loan_affordability(100000, 20000, 9, 240)
    assert result["foir_limit_emi"] == Decimal("50000.00")
    assert result["current_foir_pct"] == Decimal("20.00")
    assert result["max_new_emi"] == Decimal("30000.00")
    assert result["eligible"] is True
    assert result["max_loan_amount"] == D(ref_max_loan(F(30000), F(9), 240))
    # The loan it reports really does cost that EMI.
    assert calc.calculate_emi(result["max_loan_amount"], 9, 240)["emi"] == Decimal("30000.00")


def test_affordability_existing_emis_at_or_over_the_limit_give_zero() -> None:
    for existing in (50000, 65000):
        result = calc.loan_affordability(100000, existing, 9, 240)
        assert result["max_new_emi"] == Decimal("0.00")
        assert result["max_loan_amount"] == Decimal("0.00")
        assert result["eligible"] is False
    assert calc.loan_affordability(100000, 65000, 9, 240)["current_foir_pct"] == Decimal("65.00")


def test_affordability_zero_rate_and_custom_foir() -> None:
    result = calc.loan_affordability(80000, 0, 0, 60, max_foir_pct=40)
    assert result["max_new_emi"] == Decimal("32000.00")
    assert result["max_loan_amount"] == Decimal("1920000.00")
    full = calc.loan_affordability(80000, 10000, 10, 12, max_foir_pct=100)
    assert full["max_new_emi"] == Decimal("70000.00")


def test_affordability_rounds_the_limit_to_paise() -> None:
    result = calc.loan_affordability(33333.33, 0, 12, 12, max_foir_pct=33.333)
    assert result["foir_limit_emi"] == Decimal("11111.00")  # 11110.999889 rounded half-up


# --- validation ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("fn", "args", "message"),
    [
        (calc.calculate_emi, (-5, 9, 12), "principal must be at least ₹1.00"),
        (calc.calculate_emi, (0, 9, 12), "principal must be at least ₹1.00"),
        (calc.calculate_emi, (10**13, 9, 12), "principal must be at most"),
        (calc.calculate_emi, (100000, 9, 0), "tenure_months must be between 1 and 600"),
        (calc.calculate_emi, (100000, 9, 601), "tenure_months must be between 1 and 600"),
        (calc.calculate_emi, (100000, 9, 12.5), "tenure_months must be a whole number"),
        (calc.calculate_emi, (100000, 9, True), "tenure_months must be a whole number"),
        (calc.calculate_emi, (100000, -1, 12), "annual_rate_pct must be between 0 and 100"),
        (calc.calculate_emi, (100000, 100.01, 12), "annual_rate_pct must be between 0 and 100"),
        (calc.calculate_emi, ("100000", 9, 12), "principal must be a number"),
        (calc.calculate_emi, (float("nan"), 9, 12), "principal must be a finite number"),
        (calc.amortization_schedule, (100000, 9, 12, "weekly"), "granularity must be one of"),
        (
            calc.amortization_schedule,
            (100000, 9, 24, "yearly", 3),
            "start_period must be between 1 and 2",
        ),
        (calc.prepayment_impact, (100000, 9, 12, 1000, "both"), "mode must be one of"),
        (calc.debt_payoff_plan, ([], 1000), "debts must be a list of 1 to 20"),
        (calc.debt_payoff_plan, (THREE_DEBTS, 20000, "random"), "strategy must be one of"),
        (
            calc.debt_payoff_plan,
            ([{"name": "A", "balance": 1, "annual_rate_pct": 1, "minimum_payment": 1}] * 2, 10),
            "debt names must be unique",
        ),
        (
            calc.debt_payoff_plan,
            (
                [{"name": "A", "balance": 100, "annual_rate_pct": 1, "minimum_payment": 1, "x": 1}],
                10,
            ),
            "debts[0] has unknown field(s): x",
        ),
        (
            calc.debt_payoff_plan,
            ([{"name": "A", "balance": -1, "annual_rate_pct": 1, "minimum_payment": 1}], 10),
            "debts[0].balance must be at least",
        ),
        (calc.sip_future_value, (1000, 12, 0), "years must be between 1 and 50"),
        (calc.sip_future_value, (1000, 12, 5, 101), "annual_step_up_pct must be between 0 and 100"),
        (calc.fd_maturity, (100000, 7, 0), "years must be between 0.01 and 50"),
        (calc.fd_maturity, (100000, 7, 1, "daily"), "compounding must be one of"),
        (calc.inflation_adjusted_value, (1000, 6, 10, "past"), "direction must be one of"),
        (
            calc.loan_affordability,
            (100000, -1, 9, 12),
            "existing_monthly_emis must be at least ₹0.00",
        ),
        (calc.loan_affordability, (100000, 0, 9, 12, 0), "max_foir_pct must be between 1 and 100"),
    ],
)
def test_bad_inputs_are_rejected_with_a_short_message(fn, args, message) -> None:
    with pytest.raises(FinanceInputError) as caught:
        fn(*args)
    assert message in str(caught.value)
    assert len(str(caught.value)) < 200


@pytest.mark.parametrize(
    "args",
    [
        (10, 0, 600),  # EMI rounds to ₹0.02 and would clear the loan in month 500
        (1, 0, 600),  # EMI rounds to ₹0.00
        (100000, 100, 600),  # rounding compounds at 100% a year for 50 years
    ],
)
def test_loans_that_cannot_be_scheduled_in_paise_are_rejected(args) -> None:
    with pytest.raises(FinanceInputError, match="cannot be scheduled in whole paise"):
        calc.calculate_emi(*args)


def test_realistic_extremes_still_schedule() -> None:
    assert calc.calculate_emi(50000, 42, 36)["total_interest"] > 0  # credit-card rate
    assert calc.calculate_emi(5000000, 8.5, 360)["final_payment"] > 0  # 30-year home loan
