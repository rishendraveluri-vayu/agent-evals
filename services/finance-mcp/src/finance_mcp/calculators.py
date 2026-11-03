"""The eight calculators. Pure functions: JSON numbers in, an ordered dict of Decimals and strings
out. No clock, no randomness, no I/O.

Shared conventions (the README repeats them for task authors):

- Money inputs are rounded half-up to paise on entry. Rates are used exactly as given.
- The monthly loan rate is annual_rate_pct / 12 / 100. A month's interest is
  round2(balance * annual_rate_pct / 1200): the product is exact and the one division is exact
  whenever the true value sits on a half-paisa boundary, so this rounding matches exact
  rational arithmetic.
- Loan schedules pay the paise-rounded EMI every month except the last, which pays whatever
  balance and interest remain, so every loan closes at exactly 0.00.
"""

from dataclasses import dataclass
from decimal import ROUND_FLOOR, Decimal

from finance_mcp.money import (
    ZERO,
    FinanceInputError,
    format_inr,
    in_context,
    money,
    round2,
    round_pct,
    to_decimal,
)

MAX_AMOUNT = Decimal(10**12)
MAX_RATE_PCT = Decimal(100)
MAX_TENURE_MONTHS = 600
MAX_SIP_YEARS = 50
MIN_FD_YEARS = Decimal("0.01")
MAX_FD_YEARS = Decimal(50)
MAX_INFLATION_YEARS = 100
MAX_DEBTS = 20
MAX_NAME_LENGTH = 60
SCHEDULE_PAGE_ROWS = 60
PAYOFF_CAP_MONTHS = 600

GRANULARITIES = ("yearly", "monthly")
PREPAYMENT_MODES = ("reduce_tenure", "reduce_emi")
PAYOFF_STRATEGIES = ("avalanche", "snowball")
COMPOUNDING_PER_YEAR = {"quarterly": 4, "monthly": 12, "annually": 1}
INFLATION_DIRECTIONS = ("future_cost", "present_value")

UNSCHEDULABLE = (
    "this loan cannot be scheduled in whole paise (rounding the EMI to ₹0.01 distorts the "
    "payoff); use a shorter tenure, a lower rate or a larger principal"
)


# --- input checks -------------------------------------------------------------------------------


def _money_in(value: object, name: str, *, minimum: Decimal = Decimal(1)) -> Decimal:
    amount = round2(to_decimal(value, name))
    if amount < minimum:
        raise FinanceInputError(f"{name} must be at least {format_inr(minimum)}")
    if amount > MAX_AMOUNT:
        raise FinanceInputError(f"{name} must be at most {format_inr(MAX_AMOUNT)}")
    return amount


def _rate_in(value: object, name: str) -> Decimal:
    rate = to_decimal(value, name)
    if rate < 0 or rate > MAX_RATE_PCT:
        raise FinanceInputError(f"{name} must be between 0 and 100 (percent per year)")
    return rate


def _int_in(value: object, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise FinanceInputError(f"{name} must be a whole number")
    if not low <= value <= high:
        raise FinanceInputError(f"{name} must be between {low} and {high}")
    return value


def _choice(value: object, name: str, options: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in options:
        raise FinanceInputError(f"{name} must be one of: {', '.join(options)}")
    return value


# --- loan engine --------------------------------------------------------------------------------


def _monthly_interest(balance: Decimal, annual_rate_pct: Decimal) -> Decimal:
    return round2(balance * annual_rate_pct / 1200)


def _emi_exact(principal: Decimal, annual_rate_pct: Decimal, months: int) -> Decimal:
    """P*r*(1+r)^n / ((1+r)^n - 1) with r = annual/12/100, or P/n at a zero rate. Unrounded."""
    if annual_rate_pct == 0:
        return principal / months
    rate = annual_rate_pct / 1200
    growth = (1 + rate) ** months
    return principal * rate * growth / (growth - 1)


@dataclass(frozen=True)
class _Month:
    month: int
    opening: Decimal
    interest: Decimal
    principal: Decimal
    payment: Decimal
    closing: Decimal


def _amortise(
    principal: Decimal, annual_rate_pct: Decimal, months: int, emi: Decimal
) -> list[_Month]:
    """Pay `emi` for months 1..n-1; month n pays the remaining balance plus its interest.

    Rejects loans the paise-rounded EMI cannot amortise sensibly: an EMI of ₹0.00, a month whose
    EMI does not cover its interest, a balance cleared before the last month, or a final payment
    above twice the EMI. Realistic loans never hit these; tiny principals over long tenures and
    extreme rate-tenure pairs do.
    """
    if emi <= 0:
        raise FinanceInputError(UNSCHEDULABLE)
    rows: list[_Month] = []
    balance = principal
    for month in range(1, months + 1):
        interest = _monthly_interest(balance, annual_rate_pct)
        if month == months:
            rows.append(_Month(month, balance, interest, balance, balance + interest, ZERO))
            break
        paid = emi - interest
        closing = balance - paid
        if paid <= 0 or closing <= 0:
            raise FinanceInputError(UNSCHEDULABLE)
        rows.append(_Month(month, balance, interest, paid, emi, closing))
        balance = closing
    if rows[-1].payment > 2 * emi:
        raise FinanceInputError(UNSCHEDULABLE)
    return rows


def _total_interest(rows: list[_Month]) -> Decimal:
    return sum((row.interest for row in rows), ZERO)


def _total_paid(rows: list[_Month]) -> Decimal:
    return sum((row.payment for row in rows), ZERO)


def _loan_inputs(
    principal: object,
    annual_rate_pct: object,
    tenure_months: object,
    *,
    names: tuple[str, str, str],
):
    return (
        _money_in(principal, names[0]),
        _rate_in(annual_rate_pct, names[1]),
        _int_in(tenure_months, names[2], 1, MAX_TENURE_MONTHS),
    )


# --- 1. EMI -------------------------------------------------------------------------------------


@in_context
def calculate_emi(principal: object, annual_rate_pct: object, tenure_months: object) -> dict:
    p, rate, n = _loan_inputs(
        principal,
        annual_rate_pct,
        tenure_months,
        names=("principal", "annual_rate_pct", "tenure_months"),
    )
    emi = round2(_emi_exact(p, rate, n))
    rows = _amortise(p, rate, n, emi)
    return {
        **money("emi", emi),
        "tenure_months": n,
        **money("final_payment", rows[-1].payment),
        **money("total_interest", _total_interest(rows), words=True),
        **money("total_payable", _total_paid(rows), words=True),
    }


# --- 2. amortisation schedule -------------------------------------------------------------------


def _schedule_row(granularity: str, index: int, months: list[_Month]) -> dict:
    head = (
        {"month": months[0].month}
        if granularity == "monthly"
        else {
            "year": index,
            "first_month": months[0].month,
            "last_month": months[-1].month,
        }
    )
    return {
        **head,
        **money("opening_balance", months[0].opening),
        **money("principal_paid", sum((m.principal for m in months), ZERO)),
        **money("interest_paid", sum((m.interest for m in months), ZERO)),
        **money("closing_balance", months[-1].closing),
    }


@in_context
def amortization_schedule(
    principal: object,
    annual_rate_pct: object,
    tenure_months: object,
    granularity: object = "yearly",
    start_period: object = 1,
) -> dict:
    p, rate, n = _loan_inputs(
        principal,
        annual_rate_pct,
        tenure_months,
        names=("principal", "annual_rate_pct", "tenure_months"),
    )
    grain = _choice(granularity, "granularity", GRANULARITIES)
    size = 1 if grain == "monthly" else 12
    total_periods = -(-n // size)
    start = _int_in(start_period, "start_period", 1, total_periods)

    emi = round2(_emi_exact(p, rate, n))
    rows = _amortise(p, rate, n, emi)
    periods = [rows[i : i + size] for i in range(0, n, size)]
    page = periods[start - 1 : start - 1 + SCHEDULE_PAGE_ROWS]
    end = start - 1 + len(page)

    final = rows[-1].payment
    adjusted = final != emi
    note = (
        f"The final payment is {format_inr(final)}, adjusted from the EMI of {format_inr(emi)} "
        "so the balance closes at exactly ₹0.00."
        if adjusted
        else "The final payment equals the EMI and the balance closes at exactly ₹0.00."
    )
    return {
        "granularity": grain,
        **money("emi", emi),
        "tenure_months": n,
        **money("final_payment", final),
        "final_payment_adjusted": adjusted,
        "note": note,
        **money("total_interest", _total_interest(rows), words=True),
        **money("total_payable", _total_paid(rows), words=True),
        "total_periods": total_periods,
        "start_period": start,
        "rows_returned": len(page),
        "next_start_period": end + 1 if end < total_periods else None,
        "rows": [_schedule_row(grain, start + i, months) for i, months in enumerate(page)],
    }


# --- 3. prepayment ------------------------------------------------------------------------------


def _repay_at_fixed_payment(
    balance: Decimal, annual_rate_pct: Decimal, payment: Decimal, max_months: int
) -> tuple[int, Decimal, Decimal]:
    """Pay `payment` each month until balance plus interest is at most `payment`; that month pays
    exactly what is due. Month `max_months` always pays everything due. Returns (months, final
    payment, total interest)."""
    interest_total = ZERO
    for month in range(1, max_months + 1):
        interest = _monthly_interest(balance, annual_rate_pct)
        interest_total += interest
        due = balance + interest
        if due <= payment or month == max_months:
            return month, due, interest_total
        balance = due - payment
    raise AssertionError("unreachable: max_months >= 1")


@in_context
def prepayment_impact(
    outstanding_principal: object,
    annual_rate_pct: object,
    remaining_months: object,
    prepayment_amount: object,
    mode: object = "reduce_tenure",
) -> dict:
    p, rate, n = _loan_inputs(
        outstanding_principal,
        annual_rate_pct,
        remaining_months,
        names=("outstanding_principal", "annual_rate_pct", "remaining_months"),
    )
    prepay = _money_in(prepayment_amount, "prepayment_amount")
    chosen = _choice(mode, "mode", PREPAYMENT_MODES)
    if prepay >= p:
        raise FinanceInputError("prepayment_amount must be less than outstanding_principal")

    emi = round2(_emi_exact(p, rate, n))
    current_interest = _total_interest(_amortise(p, rate, n, emi))
    reduced = p - prepay
    if chosen == "reduce_emi":
        new_emi = round2(_emi_exact(reduced, rate, n))
        new_rows = _amortise(reduced, rate, n, new_emi)
        new_months, new_final, new_interest = n, new_rows[-1].payment, _total_interest(new_rows)
    else:
        new_emi = emi
        new_months, new_final, new_interest = _repay_at_fixed_payment(reduced, rate, emi, n)

    return {
        "mode": chosen,
        **money("current_emi", emi),
        "current_tenure_months": n,
        **money("current_total_interest", current_interest, words=True),
        **money("new_principal", reduced, words=True),
        **money("new_emi", new_emi),
        "new_tenure_months": new_months,
        **money("new_final_payment", new_final),
        **money("new_total_interest", new_interest, words=True),
        **money("interest_saved", current_interest - new_interest, words=True),
        "months_saved": n - new_months,
        **money("emi_reduction", emi - new_emi),
    }


# --- 4. debt payoff -----------------------------------------------------------------------------

_DEBT_KEYS = ("name", "balance", "annual_rate_pct", "minimum_payment")


@dataclass(eq=False)
class _Debt:
    name: str
    balance: Decimal
    rate: Decimal
    minimum: Decimal
    interest_paid: Decimal = ZERO
    cleared_in_month: int | None = None


def _parse_debts(debts: object) -> list[_Debt]:
    if not isinstance(debts, list) or not 1 <= len(debts) <= MAX_DEBTS:
        raise FinanceInputError(f"debts must be a list of 1 to {MAX_DEBTS} debts")
    parsed: list[_Debt] = []
    for i, item in enumerate(debts):
        where = f"debts[{i}]"
        if not isinstance(item, dict):
            raise FinanceInputError(f"{where} must be an object")
        unknown = sorted(set(item) - set(_DEBT_KEYS))
        if unknown:
            raise FinanceInputError(f"{where} has unknown field(s): {', '.join(unknown)}")
        name = item.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > MAX_NAME_LENGTH:
            raise FinanceInputError(
                f"{where}.name must be a non-empty string of at most 60 characters"
            )
        parsed.append(
            _Debt(
                name=name,
                balance=_money_in(item.get("balance"), f"{where}.balance"),
                rate=_rate_in(item.get("annual_rate_pct"), f"{where}.annual_rate_pct"),
                minimum=_money_in(
                    item.get("minimum_payment"), f"{where}.minimum_payment", minimum=ZERO
                ),
            )
        )
    names = [debt.name for debt in parsed]
    if len(set(names)) != len(names):
        raise FinanceInputError("debt names must be unique")
    return parsed


@in_context
def debt_payoff_plan(debts: object, monthly_budget: object, strategy: object = "avalanche") -> dict:
    """Simulate month by month, at most 600 months. Each month:

    1. every unpaid debt accrues round2(balance * annual_rate_pct / 1200) on its opening balance;
    2. every unpaid debt is paid min(minimum_payment, balance);
    3. what is left of the budget goes to unpaid debts in priority order, each taking up to its
       balance, so a cleared target passes the remainder to the next in the same month.

    The budget is the same every month, so a cleared debt's minimum becomes surplus from then on.
    Priority is fixed at the start: avalanche by highest rate, snowball by smallest starting
    balance, ties in input order.
    """
    plan = _parse_debts(debts)
    budget = _money_in(monthly_budget, "monthly_budget")
    chosen = _choice(strategy, "strategy", PAYOFF_STRATEGIES)
    minimums = sum((debt.minimum for debt in plan), ZERO)
    if budget < minimums:
        raise FinanceInputError(
            f"monthly_budget {format_inr(budget)} is below the sum of minimum payments "
            f"{format_inr(minimums)}"
        )

    indexed = list(enumerate(plan))
    if chosen == "avalanche":
        indexed.sort(key=lambda pair: (-pair[1].rate, pair[0]))
    else:
        indexed.sort(key=lambda pair: (pair[1].balance, pair[0]))
    order = [debt for _, debt in indexed]

    total_paid = ZERO
    months = 0
    while months < PAYOFF_CAP_MONTHS and any(debt.balance > 0 for debt in order):
        months += 1
        active = [debt for debt in order if debt.balance > 0]
        for debt in active:
            interest = _monthly_interest(debt.balance, debt.rate)
            debt.balance += interest
            debt.interest_paid += interest
        available = budget
        for debt in active:
            pay = min(debt.minimum, debt.balance)
            debt.balance -= pay
            available -= pay
        for debt in active:
            if available <= 0:
                break
            pay = min(available, debt.balance)
            debt.balance -= pay
            available -= pay
        total_paid += budget - available
        for debt in active:
            if debt.balance == 0:
                debt.cleared_in_month = months

    debt_free = all(debt.balance == 0 for debt in order)
    rank = {id(debt): position for position, debt in enumerate(order)}
    cleared = sorted(
        (debt for debt in order if debt.cleared_in_month is not None),
        key=lambda debt: (debt.cleared_in_month, rank[id(debt)]),
    )
    return {
        "strategy": chosen,
        "priority_order": [debt.name for debt in order],
        **money("total_minimum_payments", minimums),
        **money("surplus_over_minimums", budget - minimums),
        "debt_free": debt_free,
        "months_to_debt_free": months if debt_free else None,
        "months_simulated": months,
        "payoff_order": [debt.name for debt in cleared],
        **money("total_interest", sum((debt.interest_paid for debt in order), ZERO), words=True),
        **money("total_paid", total_paid, words=True),
        "debts": [
            {
                "name": debt.name,
                "cleared_in_month": debt.cleared_in_month,
                **money("interest_paid", debt.interest_paid),
                **money("remaining_balance", debt.balance),
            }
            for debt in order
        ],
    }


# --- 5. SIP -------------------------------------------------------------------------------------


@in_context
def sip_future_value(
    monthly_investment: object,
    expected_annual_return_pct: object,
    years: object,
    annual_step_up_pct: object = 0,
) -> dict:
    """Annuity due: each month's contribution is added, then the month's growth applies.
    Year y (from 0) invests round2(monthly_investment * (1 + step/100)^y) every month. The
    corpus is carried unrounded (50 significant digits) and rounded once at the end."""
    base = _money_in(monthly_investment, "monthly_investment")
    rate = _rate_in(expected_annual_return_pct, "expected_annual_return_pct")
    n_years = _int_in(years, "years", 1, MAX_SIP_YEARS)
    step = _rate_in(annual_step_up_pct, "annual_step_up_pct")

    growth = 1 + rate / 1200
    value = Decimal(0)
    invested = ZERO
    contribution = base
    for year in range(n_years):
        contribution = round2(base * (1 + step / 100) ** year)
        for _ in range(12):
            value = (value + contribution) * growth
            invested += contribution
    corpus = round2(value)
    return {
        "months": 12 * n_years,
        **money("corpus", corpus, words=True),
        **money("total_invested", invested, words=True),
        **money("gains", corpus - invested, words=True),
        **money("final_monthly_investment", contribution),
    }


# --- 6. fixed deposit ---------------------------------------------------------------------------


@in_context
def fd_maturity(
    principal: object, annual_rate_pct: object, years: object, compounding: object = "quarterly"
) -> dict:
    """k = floor(years * m) full periods compound at R/(100m); the part period f = years*m - k
    earns simple interest: A = P * (1 + R/(100m))^k * (1 + f * R/(100m)), rounded at the end."""
    p = _money_in(principal, "principal")
    rate = _rate_in(annual_rate_pct, "annual_rate_pct")
    tenure = to_decimal(years, "years")
    if not MIN_FD_YEARS <= tenure <= MAX_FD_YEARS:
        raise FinanceInputError("years must be between 0.01 and 50")
    chosen = _choice(compounding, "compounding", tuple(COMPOUNDING_PER_YEAR))

    per_year = COMPOUNDING_PER_YEAR[chosen]
    periods = tenure * per_year
    full = periods.to_integral_value(rounding=ROUND_FLOOR)
    part = periods - full
    period_rate = rate / (100 * per_year)
    maturity = round2(p * (1 + period_rate) ** int(full) * (1 + part * period_rate))
    return {
        "compounding": chosen,
        "full_periods": int(full),
        "part_period": part.normalize() if part else Decimal(0),
        **money("maturity_amount", maturity, words=True),
        **money("interest_earned", maturity - p, words=True),
    }


# --- 7. inflation -------------------------------------------------------------------------------


@in_context
def inflation_adjusted_value(
    amount: object, annual_inflation_pct: object, years: object, direction: object = "future_cost"
) -> dict:
    a = _money_in(amount, "amount")
    rate = _rate_in(annual_inflation_pct, "annual_inflation_pct")
    n_years = _int_in(years, "years", 1, MAX_INFLATION_YEARS)
    chosen = _choice(direction, "direction", INFLATION_DIRECTIONS)
    factor = (1 + rate / 100) ** n_years
    value = a * factor if chosen == "future_cost" else a / factor
    return {
        "direction": chosen,
        "years": n_years,
        **money("adjusted_value", value, words=True),
        "cumulative_inflation_pct": round_pct((factor - 1) * 100),
    }


# --- 8. affordability ---------------------------------------------------------------------------


@in_context
def loan_affordability(
    monthly_net_income: object,
    existing_monthly_emis: object,
    annual_rate_pct: object,
    tenure_months: object,
    max_foir_pct: object = 50,
) -> dict:
    """FOIR limit = round2(income * max_foir_pct / 100). Max new EMI = limit - existing, floored
    at zero. Max loan = the principal whose exact EMI equals that, rounded half-up to paise."""
    income = _money_in(monthly_net_income, "monthly_net_income")
    existing = _money_in(existing_monthly_emis, "existing_monthly_emis", minimum=ZERO)
    rate = _rate_in(annual_rate_pct, "annual_rate_pct")
    n = _int_in(tenure_months, "tenure_months", 1, MAX_TENURE_MONTHS)
    foir = to_decimal(max_foir_pct, "max_foir_pct")
    if not 1 <= foir <= 100:
        raise FinanceInputError("max_foir_pct must be between 1 and 100")

    limit = round2(income * foir / 100)
    max_emi = max(ZERO, limit - existing)
    if max_emi == 0:
        loan = ZERO
    elif rate == 0:
        loan = max_emi * n
    else:
        monthly = rate / 1200
        growth = (1 + monthly) ** n
        loan = max_emi * (growth - 1) / (monthly * growth)
    return {
        **money("foir_limit_emi", limit),
        **money("existing_monthly_emis", existing),
        "current_foir_pct": round_pct(existing * 100 / income),
        "eligible": max_emi > 0,
        **money("max_new_emi", max_emi),
        **money("max_loan_amount", loan, words=True),
    }
