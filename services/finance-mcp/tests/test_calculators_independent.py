"""Every calculator against a second implementation written here, over a grid of inputs.

The second implementation follows only the conventions in the README (and A5, A6, D21): it
shares no code with `finance_mcp`, uses exact rational arithmetic (`fractions.Fraction`, the
standard library only) where the server uses 50-digit Decimals, and is written differently
where it can be (the SIP grows a year at a time in closed form; the server goes month by
month). Each test compares the whole result, every field and the key order, so a slip in
rounding, formatting, words or paging shows up. Golden values at the end pin published figures
and a few hand-worked cases as literals.

Rishi's review note 17: "The finance MCP needs its own separate testing."
"""

import json
import math
import random
from decimal import Decimal
from fractions import Fraction as F

import pytest
from finance_mcp import calculators as calc
from finance_mcp.money import FinanceInputError

# --- exact helpers ------------------------------------------------------------------------------


def num(value) -> F:
    """A JSON number as the server reads it: ints exactly, floats through their shortest repr."""
    return F(repr(value)) if isinstance(value, float) else F(value)


def r2(x: F) -> F:
    """Half-up (away from zero) to paise."""
    cents = math.floor(abs(x) * 100 + F(1, 2))
    return F(cents if x >= 0 else -cents, 100)


def s2(x: F) -> str:
    """An exact paise amount as '1234.50' ('0.00', never '-0.00')."""
    cents = x * 100
    assert cents.denominator == 1, x
    n = cents.numerator
    sign = "-" if n < 0 else ""
    return f"{sign}{abs(n) // 100}.{abs(n) % 100:02d}"


def plain(x: F) -> str:
    """A terminating decimal Fraction as its shortest decimal string: 2/5 -> '0.4', 0 -> '0'."""
    if x.denominator == 1:
        return str(x.numerator)
    for places in range(1, 30):
        scaled = x * 10**places
        if scaled.denominator == 1:
            digits = str(abs(scaled.numerator)).rjust(places + 1, "0")
            text = digits[:-places] + "." + digits[-places:]
            return ("-" if x < 0 else "") + text
    raise AssertionError(f"{x} does not terminate")


def indian(whole: int) -> str:
    """12345678 -> '1,23,45,678', built from the right: three digits, then pairs."""
    digits = str(whole)
    if len(digits) <= 3:
        return digits
    parts = [digits[-3:]]
    rest = digits[:-3]
    while rest:
        parts.append(rest[-2:])
        rest = rest[:-2]
    return ",".join(reversed(parts))


def inr(x: F) -> str:
    x = r2(x)
    text = s2(abs(x))
    whole, paise = text.split(".")
    return f"{'-' if x < 0 else ''}₹{indian(int(whole))}.{paise}"


def short(x: F) -> str:
    """At most two decimals, trailing zeros dropped, Indian grouping: 1234.50 -> '1,234.5'."""
    text = s2(x)
    whole, frac = text.split(".")
    frac = frac.rstrip("0")
    return indian(int(whole)) + (f".{frac}" if frac else "")


def words(x: F) -> str | None:
    x = r2(x)
    size = abs(x)
    if size < 100_000:
        return None
    sign = "-" if x < 0 else ""
    lakhs = r2(size / 100_000)
    if size >= 10_000_000 or lakhs >= 100:
        return f"{sign}{short(r2(size / 10_000_000))} crore"
    return f"{sign}{short(lakhs)} lakh"


def money(name: str, x: F, with_words: bool = False) -> dict:
    x = r2(x)
    out = {name: s2(x), f"{name}_formatted": inr(x)}
    if with_words and (w := words(x)) is not None:
        out[f"{name}_words"] = w
    return out


def as_plain(value):
    """The server's result with Decimals as their exact strings, as the tool's JSON writes them."""
    if isinstance(value, Decimal):
        return f"{value:f}"
    if isinstance(value, dict):
        return {k: as_plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [as_plain(v) for v in value]
    return value


def same(server: dict, reference: dict) -> None:
    got = as_plain(server)
    assert got == reference
    # The key order is part of the output: the tool writes keys in the order it built them.
    assert json.dumps(got, ensure_ascii=False) == json.dumps(reference, ensure_ascii=False)


class Rejected(Exception):
    """The reference refuses the input, as the server must."""


def agree(server_call, reference_call) -> None:
    """Both accept and give the same result, or both refuse."""
    try:
        expected = reference_call()
    except Rejected:
        with pytest.raises(FinanceInputError):
            server_call()
        return
    same(server_call(), expected)


# --- reference: loans ---------------------------------------------------------------------------


def ref_emi(p: F, pct: F, n: int) -> F:
    if pct == 0:
        return r2(p / n)
    r = pct / 1200
    g = (1 + r) ** n
    return r2(p * r * g / (g - 1))


def ref_months(p: F, pct: F, n: int, emi: F) -> list[dict]:
    """One dict per month. Months 1..n-1 pay the EMI; month n pays what is left plus interest.
    Refused when the paise EMI cannot amortise the loan sensibly (README)."""
    if emi <= 0:
        raise Rejected("emi rounds to zero")
    months, balance = [], p
    for m in range(1, n + 1):
        interest = r2(balance * pct / 1200)
        if m < n:
            principal = emi - interest
            closing = balance - principal
            if principal <= 0 or closing <= 0:
                raise Rejected("emi does not cover interest, or the loan clears early")
            payment = emi
        else:
            principal, closing, payment = balance, F(0), balance + interest
        months.append({"m": m, "open": balance, "int": interest, "prin": principal, "pay": payment})
        balance = closing
    if months[-1]["pay"] > 2 * emi:
        raise Rejected("final payment above twice the EMI")
    return months


def ref_calculate_emi(principal, rate, tenure) -> dict:
    p, pct = r2(num(principal)), num(rate)
    emi = ref_emi(p, pct, tenure)
    months = ref_months(p, pct, tenure, emi)
    return {
        **money("emi", emi),
        "tenure_months": tenure,
        **money("final_payment", months[-1]["pay"]),
        **money("total_interest", sum(x["int"] for x in months), True),
        **money("total_payable", sum(x["pay"] for x in months), True),
    }


def ref_schedule(principal, rate, tenure, granularity="yearly", start=1) -> dict:
    p, pct = r2(num(principal)), num(rate)
    emi = ref_emi(p, pct, tenure)
    months = ref_months(p, pct, tenure, emi)
    size = 12 if granularity == "yearly" else 1
    periods = [months[i : i + size] for i in range(0, tenure, size)]
    if not 1 <= start <= len(periods):
        raise Rejected("start_period out of range")
    page = periods[start - 1 : start - 1 + 60]
    rows = []
    for offset, group in enumerate(page):
        if granularity == "monthly":
            head = {"month": group[0]["m"]}
        else:
            head = {
                "year": start + offset,
                "first_month": group[0]["m"],
                "last_month": group[-1]["m"],
            }
        closing = group[-1]["open"] - group[-1]["prin"]
        rows.append(
            {
                **head,
                **money("opening_balance", group[0]["open"]),
                **money("principal_paid", sum(x["prin"] for x in group)),
                **money("interest_paid", sum(x["int"] for x in group)),
                **money("closing_balance", closing),
            }
        )
    final = months[-1]["pay"]
    if final != emi:
        note = (
            f"The final payment is {inr(final)}, adjusted from the EMI of {inr(emi)} so the "
            "balance closes at exactly ₹0.00."
        )
    else:
        note = "The final payment equals the EMI and the balance closes at exactly ₹0.00."
    last = start - 1 + len(page)
    return {
        "granularity": granularity,
        **money("emi", emi),
        "tenure_months": tenure,
        **money("final_payment", final),
        "final_payment_adjusted": final != emi,
        "note": note,
        **money("total_interest", sum(x["int"] for x in months), True),
        **money("total_payable", sum(x["pay"] for x in months), True),
        "total_periods": len(periods),
        "start_period": start,
        "rows_returned": len(page),
        "next_start_period": last + 1 if last < len(periods) else None,
        "rows": rows,
    }


def ref_fixed_payment(balance: F, pct: F, payment: F, cap: int) -> tuple[int, F, F]:
    """Pay `payment` until what is due fits in one payment; that month pays what is due."""
    total_interest = F(0)
    for month in range(1, cap + 1):
        interest = r2(balance * pct / 1200)
        total_interest += interest
        due = balance + interest
        if due <= payment or month == cap:
            return month, due, total_interest
        balance = due - payment
    raise AssertionError


def ref_prepayment(outstanding, rate, remaining, prepayment, mode="reduce_tenure") -> dict:
    p, pct, prepay = r2(num(outstanding)), num(rate), r2(num(prepayment))
    if prepay >= p:
        raise Rejected("prepayment not below the outstanding amount")
    emi = ref_emi(p, pct, remaining)
    current_interest = sum(x["int"] for x in ref_months(p, pct, remaining, emi))
    reduced = p - prepay
    if mode == "reduce_emi":
        new_emi = ref_emi(reduced, pct, remaining)
        months = ref_months(reduced, pct, remaining, new_emi)
        new_n, new_final = remaining, months[-1]["pay"]
        new_interest = sum(x["int"] for x in months)
    else:
        new_emi = emi
        new_n, new_final, new_interest = ref_fixed_payment(reduced, pct, emi, remaining)
    return {
        "mode": mode,
        **money("current_emi", emi),
        "current_tenure_months": remaining,
        **money("current_total_interest", current_interest, True),
        **money("new_principal", reduced, True),
        **money("new_emi", new_emi),
        "new_tenure_months": new_n,
        **money("new_final_payment", new_final),
        **money("new_total_interest", new_interest, True),
        **money("interest_saved", current_interest - new_interest, True),
        "months_saved": remaining - new_n,
        **money("emi_reduction", emi - new_emi),
    }


# --- reference: debt payoff ---------------------------------------------------------------------


def ref_payoff(debts: list[dict], budget, strategy="avalanche") -> dict:
    book = [
        {
            "name": d["name"],
            "bal": r2(num(d["balance"])),
            "rate": num(d["annual_rate_pct"]),
            "min": r2(num(d["minimum_payment"])),
            "interest": F(0),
            "cleared": None,
            "pos": i,
        }
        for i, d in enumerate(debts)
    ]
    budget = r2(num(budget))
    minimums = sum(d["min"] for d in book)
    if budget < minimums:
        raise Rejected("budget below minimums")
    if strategy == "avalanche":
        order = sorted(book, key=lambda d: (-d["rate"], d["pos"]))
    else:
        order = sorted(book, key=lambda d: (d["bal"], d["pos"]))
    paid_total, month = F(0), 0
    while month < 600 and any(d["bal"] > 0 for d in order):
        month += 1
        unpaid = [d for d in order if d["bal"] > 0]
        for d in unpaid:  # 1. interest on the opening balance
            charge = r2(d["bal"] * d["rate"] / 1200)
            d["bal"] += charge
            d["interest"] += charge
        left = budget
        for d in unpaid:  # 2. minimums
            pay = min(d["min"], d["bal"])
            d["bal"] -= pay
            left -= pay
        for d in unpaid:  # 3. the rest in priority order, rolling past cleared debts
            pay = min(left, d["bal"])
            d["bal"] -= pay
            left -= pay
        paid_total += budget - left
        for d in unpaid:
            if d["bal"] == 0:
                d["cleared"] = month
    free = all(d["bal"] == 0 for d in order)
    rank = {d["name"]: i for i, d in enumerate(order)}
    cleared = sorted(
        (d for d in order if d["cleared"] is not None),
        key=lambda d: (d["cleared"], rank[d["name"]]),
    )
    return {
        "strategy": strategy,
        "priority_order": [d["name"] for d in order],
        **money("total_minimum_payments", minimums),
        **money("surplus_over_minimums", budget - minimums),
        "debt_free": free,
        "months_to_debt_free": month if free else None,
        "months_simulated": month,
        "payoff_order": [d["name"] for d in cleared],
        **money("total_interest", sum(d["interest"] for d in order), True),
        **money("total_paid", paid_total, True),
        "debts": [
            {
                "name": d["name"],
                "cleared_in_month": d["cleared"],
                **money("interest_paid", d["interest"]),
                **money("remaining_balance", d["bal"]),
            }
            for d in order
        ],
    }


# --- reference: SIP, FD, inflation, affordability -----------------------------------------------


def ref_sip(monthly, rate, years, step=0, lump=0) -> dict:
    """A year at a time in closed form: twelve start-of-month contributions c grow to
    c * g * (g^12 - 1) / (g - 1), or 12c at a zero rate, and the year's opening value to v * g^12.
    A lump sum invested at the start grows to lump * g^(12 * years); the corpus is the sum of
    the two rounded parts, and with no lump sum the output has no lump-sum fields.
    """
    base, pct, up, lump_in = r2(num(monthly)), num(rate), num(step), r2(num(lump))
    g = 1 + pct / 1200
    g12 = g**12
    value, invested, c = F(0), F(0), base
    for year in range(years):
        c = r2(base * (1 + up / 100) ** year)
        year_of_contributions = 12 * c if pct == 0 else c * g * (g12 - 1) / (g - 1)
        value = value * g12 + year_of_contributions
        invested += 12 * c
    sip_value = r2(value)
    if lump_in == 0:
        return {
            "months": 12 * years,
            **money("corpus", sip_value, True),
            **money("total_invested", invested, True),
            **money("gains", sip_value - invested, True),
            **money("final_monthly_investment", c),
        }
    lump_value = r2(lump_in * g ** (12 * years))
    corpus, invested = lump_value + sip_value, invested + lump_in
    return {
        "months": 12 * years,
        **money("corpus", corpus, True),
        **money("total_invested", invested, True),
        **money("gains", corpus - invested, True),
        **money("final_monthly_investment", c),
        **money("lump_sum", lump_in, True),
        **money("lump_sum_value", lump_value, True),
        **money("sip_value", sip_value, True),
    }


def ref_fd(principal, rate, years, compounding="quarterly") -> dict:
    per_year = {"quarterly": 4, "monthly": 12, "annually": 1}[compounding]
    p, pct, t = r2(num(principal)), num(rate), num(years)
    periods = t * per_year
    full = math.floor(periods)
    part = periods - full
    i = pct / (100 * per_year)
    maturity = r2(p * (1 + i) ** full * (1 + part * i))
    return {
        "compounding": compounding,
        "full_periods": full,
        "part_period": plain(part),
        **money("maturity_amount", maturity, True),
        **money("interest_earned", maturity - p, True),
    }


def ref_inflation(amount, rate, years, direction="future_cost") -> dict:
    a, pct = r2(num(amount)), num(rate)
    factor = (1 + pct / 100) ** years
    value = a * factor if direction == "future_cost" else a / factor
    return {
        "direction": direction,
        "years": years,
        **money("adjusted_value", value, True),
        "cumulative_inflation_pct": s2(r2((factor - 1) * 100)),
    }


def ref_affordability(income, existing, rate, tenure, foir=50) -> dict:
    inc, ex, pct, cap = r2(num(income)), r2(num(existing)), num(rate), num(foir)
    limit = r2(inc * cap / 100)
    room = max(F(0), limit - ex)
    if room == 0:
        loan = F(0)
    elif pct == 0:
        loan = room * tenure
    else:
        m = pct / 1200
        # The present value of `tenure` payments of `room`: room * (1 - (1+m)^-n) / m.
        loan = room * (1 - (1 + m) ** -tenure) / m
    return {
        **money("foir_limit_emi", limit),
        **money("existing_monthly_emis", ex),
        "current_foir_pct": s2(r2(ex * 100 / inc)),
        "eligible": room > 0,
        **money("max_new_emi", room),
        **money("max_loan_amount", loan, True),
    }


# --- the grids ----------------------------------------------------------------------------------

LOANS = [
    (principal, rate, tenure)
    for principal in (1000, 75000, 500000, 1000000, 2500000.75, 7350000)
    for rate in (0, 6.5, 8.35, 9, 10.75, 14, 24)
    for tenure in (1, 7, 36, 120, 240, 360)
]


@pytest.mark.parametrize(("principal", "rate", "tenure"), LOANS)
def test_calculate_emi_matches_the_reference(principal, rate, tenure) -> None:
    agree(
        lambda: calc.calculate_emi(principal, rate, tenure),
        lambda: ref_calculate_emi(principal, rate, tenure),
    )


SCHEDULES = [
    (principal, rate, tenure, grain, start)
    for principal, rate in ((300000, 9), (2500000.75, 8.35), (60000, 0), (1000, 24))
    for tenure in (5, 30, 240, 360)
    for grain in ("yearly", "monthly")
    for start in (1, 2, 61, 300)
]


@pytest.mark.parametrize(("principal", "rate", "tenure", "grain", "start"), SCHEDULES)
def test_amortization_schedule_matches_the_reference(principal, rate, tenure, grain, start):
    periods = -(-tenure // (12 if grain == "yearly" else 1))
    if start > periods:  # the server's own range check, tested in test_calculators.py
        with pytest.raises(FinanceInputError):
            calc.amortization_schedule(principal, rate, tenure, grain, start)
        return
    agree(
        lambda: calc.amortization_schedule(principal, rate, tenure, grain, start),
        lambda: ref_schedule(principal, rate, tenure, grain, start),
    )


PREPAYMENTS = [
    (outstanding, rate, remaining, prepay, mode)
    for outstanding, rate in ((1800000, 8.5), (450000.5, 11.25), (90000, 0))
    for remaining in (12, 85, 240)
    for prepay in (1, 25000, 89999, 500000, 1799999.99)
    for mode in ("reduce_tenure", "reduce_emi")
]


@pytest.mark.parametrize(("outstanding", "rate", "remaining", "prepay", "mode"), PREPAYMENTS)
def test_prepayment_impact_matches_the_reference(outstanding, rate, remaining, prepay, mode):
    agree(
        lambda: calc.prepayment_impact(outstanding, rate, remaining, prepay, mode),
        lambda: ref_prepayment(outstanding, rate, remaining, prepay, mode),
    )


def debt_sets() -> list[list[dict]]:
    """Deterministic random portfolios, plus the edge cases: equal rates and balances (ties
    keep input order), a debt its minimum clears early, and one that never clears in 600
    months (interest equals the minimum)."""
    rng = random.Random(20261104)
    sets = []
    for _ in range(24):
        debts = []
        for i in range(rng.randint(1, 5)):
            balance = rng.choice([2500, 18000, 46800, 84250, 310000, 1250000]) + rng.randint(0, 99)
            debts.append(
                {
                    "name": f"D{i}",
                    "balance": balance,
                    "annual_rate_pct": rng.choice([0, 8.5, 11, 14.5, 18, 24, 36, 42]),
                    "minimum_payment": max(100, round(balance * rng.choice([0.02, 0.03, 0.05]))),
                }
            )
        sets.append(debts)
    sets.append(
        [
            {"name": "A", "balance": 5000, "annual_rate_pct": 12, "minimum_payment": 500},
            {"name": "B", "balance": 5000, "annual_rate_pct": 12, "minimum_payment": 500},
        ]
    )
    sets.append(
        [
            {"name": "Card", "balance": 1200, "annual_rate_pct": 36, "minimum_payment": 2000},
            {"name": "Loan", "balance": 90000, "annual_rate_pct": 14, "minimum_payment": 3000},
        ]
    )
    sets.append(
        [{"name": "Stuck", "balance": 100000, "annual_rate_pct": 36, "minimum_payment": 3000}]
    )
    return sets


PAYOFFS = [
    (index, strategy, extra)
    for index in range(len(debt_sets()))
    for strategy in ("avalanche", "snowball")
    for extra in (0, 0.1, 0.5, 3)
]


@pytest.mark.parametrize(("index", "strategy", "extra"), PAYOFFS)
def test_debt_payoff_plan_matches_the_reference(index, strategy, extra) -> None:
    debts = debt_sets()[index]
    minimums = sum(d["minimum_payment"] for d in debts)
    budget = round(minimums * (1 + extra), 2)
    agree(
        lambda: calc.debt_payoff_plan(debts, budget, strategy),
        lambda: ref_payoff(debts, budget, strategy),
    )


def test_a_budget_below_the_minimums_is_refused_by_both() -> None:
    debts = debt_sets()[0]
    budget = sum(d["minimum_payment"] for d in debts) - 0.01
    agree(lambda: calc.debt_payoff_plan(debts, budget), lambda: ref_payoff(debts, budget))


SIPS = [
    (monthly, rate, years, step, lump)
    for monthly in (500, 1234.56, 10000)
    for rate in (0, 6, 8.5, 12, 15)
    for years in (1, 3, 10, 25)
    for step in (0, 5, 10)
    for lump in (0, 0.004, 0.01, 100000, 2500000.55)
]


@pytest.mark.parametrize(("monthly", "rate", "years", "step", "lump"), SIPS)
def test_sip_future_value_matches_the_reference(monthly, rate, years, step, lump) -> None:
    agree(
        lambda: calc.sip_future_value(monthly, rate, years, step, lump),
        lambda: ref_sip(monthly, rate, years, step, lump),
    )


def test_sip_without_a_lump_sum_is_unchanged() -> None:
    """No lump sum, or 0, gives exactly the output from before the lump sum existed."""
    for lump in (0, 0.0, 0.004):  # 0.004 rounds to ₹0.00 on entry
        same(calc.sip_future_value(10000, 12, 10, 5, lump), ref_sip(10000, 12, 10, 5))
    assert list(calc.sip_future_value(10000, 12, 10)) == [
        "months",
        "corpus",
        "corpus_formatted",
        "corpus_words",
        "total_invested",
        "total_invested_formatted",
        "total_invested_words",
        "gains",
        "gains_formatted",
        "gains_words",
        "final_monthly_investment",
        "final_monthly_investment_formatted",
    ]


FDS = [
    (principal, rate, years, compounding)
    for principal in (1000, 100000, 2500000.5)
    for rate in (0, 5.5, 7, 7.25, 9)
    for years in (0.25, 1, 1.1, 1.5, 2.33, 5, 10.75)
    for compounding in ("quarterly", "monthly", "annually")
]


@pytest.mark.parametrize(("principal", "rate", "years", "compounding"), FDS)
def test_fd_maturity_matches_the_reference(principal, rate, years, compounding) -> None:
    agree(
        lambda: calc.fd_maturity(principal, rate, years, compounding),
        lambda: ref_fd(principal, rate, years, compounding),
    )


INFLATIONS = [
    (amount, rate, years, direction)
    for amount in (1000, 100000, 2500000)
    for rate in (0, 3, 6, 7.5, 12)
    for years in (1, 5, 10, 25, 40)
    for direction in ("future_cost", "present_value")
]


@pytest.mark.parametrize(("amount", "rate", "years", "direction"), INFLATIONS)
def test_inflation_adjusted_value_matches_the_reference(amount, rate, years, direction) -> None:
    agree(
        lambda: calc.inflation_adjusted_value(amount, rate, years, direction),
        lambda: ref_inflation(amount, rate, years, direction),
    )


AFFORDABILITY = [
    (income, existing, rate, tenure, foir)
    for income in (25000, 60000, 100000, 250000.5)
    for existing in (0, 5000, 30000, 60000)
    for rate in (0, 8.5, 9, 10.5, 12)
    for tenure in (12, 60, 240)
    for foir in (40, 50, 60)
]


@pytest.mark.parametrize(("income", "existing", "rate", "tenure", "foir"), AFFORDABILITY)
def test_loan_affordability_matches_the_reference(income, existing, rate, tenure, foir) -> None:
    agree(
        lambda: calc.loan_affordability(income, existing, rate, tenure, foir),
        lambda: ref_affordability(income, existing, rate, tenure, foir),
    )


# --- golden values ------------------------------------------------------------------------------
# Literals, so a change that moved the server and the reference together still fails here.


def test_golden_loans() -> None:
    ten_lakh = calc.calculate_emi(1000000, 9, 240)
    assert as_plain(ten_lakh) == {
        "emi": "8997.26",  # the widely published figure for ₹10 lakh at 9% over 20 years
        "emi_formatted": "₹8,997.26",
        "tenure_months": 240,
        "final_payment": "8996.98",
        "final_payment_formatted": "₹8,996.98",
        "total_interest": "1159342.12",
        "total_interest_formatted": "₹11,59,342.12",
        "total_interest_words": "11.59 lakh",
        "total_payable": "2159342.12",
        "total_payable_formatted": "₹21,59,342.12",
        "total_payable_words": "21.59 lakh",
    }
    assert calc.calculate_emi(5000000, 8.5, 240)["emi"] == Decimal("43391.16")  # published ₹43,391
    assert calc.calculate_emi(100000, 0, 3)["final_payment"] == Decimal("33333.34")
    prepay = calc.prepayment_impact(1800000, 8.5, 240, 200000)
    # Months at a fixed EMI, from the closed form n = -ln(1 - P*r/EMI) / ln(1 + r), rounded up.
    r = 8.5 / 1200
    months = math.ceil(-math.log(1 - 1600000 * r / 15620.82) / math.log(1 + r))
    assert prepay["current_emi"] == Decimal("15620.82")
    assert (prepay["new_tenure_months"], prepay["months_saved"]) == (months, 240 - months)
    assert months == 184
    assert prepay["interest_saved"] == Decimal("687670.55")


def test_golden_payoff_by_hand() -> None:
    """Worked on paper (avalanche, budget 500; 2% a month on the Card, 1% on the Loan).

    Month 1: Card 1,000 + 20.00 - 100 - 300 = 620.00; Loan 2,000 + 20.00 - 100 = 1,920.00.
    Month 2: Card 620 + 12.40 - 100 - 300 = 232.40; Loan 1,920 + 19.20 - 100 = 1,839.20.
    Month 3: Card 232.40 + 4.65 = 237.05, cleared by 100 + 137.05; Loan 1,839.20 + 18.39 - 100
    - 162.95 (the rest of the budget rolls over) = 1,594.64.
    Months 4 to 7, 500 a month to the Loan: interest 15.95, 11.11, 6.22 and 1.28; the last
    payment is 129.20. Interest: Card 37.05, Loan 92.15, total 129.20; paid 3,129.20."""
    plan = calc.debt_payoff_plan(
        [
            {"name": "Card", "balance": 1000, "annual_rate_pct": 24, "minimum_payment": 100},
            {"name": "Loan", "balance": 2000, "annual_rate_pct": 12, "minimum_payment": 100},
        ],
        500,
    )
    card, loan = plan["debts"]
    assert (card["cleared_in_month"], card["interest_paid"]) == (3, Decimal("37.05"))
    assert (loan["cleared_in_month"], loan["interest_paid"]) == (7, Decimal("92.15"))
    assert plan["months_to_debt_free"] == 7
    assert plan["total_interest"] == Decimal("129.20")
    assert plan["total_paid"] == Decimal("3129.20")
    assert plan["payoff_order"] == ["Card", "Loan"]


def test_golden_investments_and_affordability() -> None:
    assert calc.sip_future_value(10000, 12, 10)["corpus"] == Decimal("2323390.76")
    assert calc.sip_future_value(5000, 12, 20)["corpus"] == Decimal("4995739.60")  # ₹49,95,740
    # ₹1 lakh up front plus ₹10,000 a month at 12% for 10 years: the lump sum grows to
    # 1,00,000 x 1.01^120 = 3,30,038.69, the SIP to 23,23,390.76 as above.
    both = calc.sip_future_value(10000, 12, 10, lump_sum=100000)
    assert both["lump_sum_value"] == Decimal("330038.69")
    assert both["sip_value"] == Decimal("2323390.76")
    assert both["corpus"] == Decimal("2653429.45")
    assert both["total_invested"] == Decimal("1300000.00")
    assert both["gains"] == Decimal("1353429.45")
    fd = calc.fd_maturity(100000, 7, 5)
    assert (fd["maturity_amount"], fd["interest_earned"]) == (
        Decimal("141477.82"),
        Decimal("41477.82"),
    )
    assert calc.fd_maturity(100000, 7, 1.1)["part_period"] == Decimal("0.4")
    assert calc.inflation_adjusted_value(100000, 6, 10)["adjusted_value"] == Decimal("179084.77")
    assert calc.inflation_adjusted_value(100000, 6, 10, "present_value")[
        "adjusted_value"
    ] == Decimal("55839.48")
    afford = calc.loan_affordability(100000, 20000, 9, 240)
    assert afford["max_new_emi"] == Decimal("30000.00")
    # 30,000 is 3.334 times the ₹10 lakh EMI of 8,997.26, so about ₹33.34 lakh.
    assert afford["max_loan_amount"] == Decimal("3334348.62")
    assert afford["max_loan_amount_words"] == "33.34 lakh"
