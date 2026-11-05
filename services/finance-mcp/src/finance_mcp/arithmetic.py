"""The arithmetic tools (D54, 5 Nov): add, subtract, multiply, divide, percent_of, percent_change
and round. Pure functions like the calculators: JSON numbers in, an ordered dict of Decimals out.
No clock, no randomness, no I/O.

They exist so that every figure an agent writes can come from a tool result, never from its own
arithmetic: the number-provenance check (checks.json) counts a figure as supported only when a
tool result, the client file or a user message holds it. Conventions (the README repeats them):

- Inputs are used exactly as given, after the float-through-repr conversion every tool uses. They
  are not rounded to paise on entry, because an input may be a rate or a count, not money.
- Every input and every result lies within -10^12 to 10^12, the ceiling every money input has.
- Results are rounded half-up to 2 decimals, like money outputs (`23120.00`), except round's,
  which has exactly the places asked for. They are plain numbers, with no `_formatted` or
  `_words`, because these tools do not know whether a number is rupees, months or a count.
- The arithmetic is exact Decimal at 50 significant digits, so 0.1 + 0.2 is 0.30, not
  0.30000000000000004.
- Results never echo the inputs, so a tool result holds only what the tool worked out.
"""

from decimal import ROUND_HALF_UP, Decimal

from finance_mcp.money import (
    CONTEXT,
    ZERO,
    FinanceInputError,
    in_context,
    round2,
    to_decimal,
)

MAX_VALUE = Decimal(10**12)
HALF_PAISA = Decimal("0.005")
BOUNDS = "-10^12 to 10^12"
MIN_TERMS = 2
MAX_TERMS = 100
MIN_PLACES = -7
MAX_PLACES = 10


def _number_in(value: object, name: str) -> Decimal:
    number = to_decimal(value, name)
    if abs(number) > MAX_VALUE:
        raise FinanceInputError(f"{name} must be within {BOUNDS}")
    return number


def _terms_in(values: object, name: str) -> list[Decimal]:
    if not isinstance(values, list) or not MIN_TERMS <= len(values) <= MAX_TERMS:
        raise FinanceInputError(f"{name} must be a list of {MIN_TERMS} to {MAX_TERMS} numbers")
    return [_number_in(value, f"{name}[{index}]") for index, value in enumerate(values)]


def _result(name: str, value: Decimal) -> Decimal:
    """`value` rounded half-up to 2 decimals, or an error naming `name` when the rounded value
    would lie outside the bounds. Checked before rounding, because a product of 100 large
    numbers has too many digits to round to paise."""
    if abs(value) >= MAX_VALUE + HALF_PAISA:
        raise FinanceInputError(f"the {name} is outside {BOUNDS}")
    return round2(value)


@in_context
def add(values: object) -> dict:
    terms = _terms_in(values, "values")
    return {"sum": _result("sum", sum(terms, ZERO))}


@in_context
def subtract(a: object, b: object) -> dict:
    return {"difference": _result("difference", _number_in(a, "a") - _number_in(b, "b"))}


@in_context
def multiply(values: object) -> dict:
    terms = _terms_in(values, "values")
    product = Decimal(1)
    for term in terms:
        product *= term
    return {"product": _result("product", product)}


@in_context
def divide(a: object, b: object) -> dict:
    dividend = _number_in(a, "a")
    divisor = _number_in(b, "b")
    if divisor == 0:
        raise FinanceInputError("cannot divide by zero: b is 0")
    return {"quotient": _result("quotient", dividend / divisor)}


@in_context
def percent_of(value: object, percent: object) -> dict:
    """value * percent / 100: 18 percent of 50,000 is 9,000.00."""
    base = _number_in(value, "value")
    pct = _number_in(percent, "percent")
    return {"amount": _result("amount", base * pct / 100)}


@in_context
def percent_change(from_value: object, to_value: object) -> dict:
    """change = to - from, and change_pct = change / |from| * 100, so a rise is positive even
    from a negative starting number. A start of 0 has no percent change and is an error."""
    start = _number_in(from_value, "from_value")
    end = _number_in(to_value, "to_value")
    if start == 0:
        raise FinanceInputError("from_value is 0, so there is no percent change")
    change = end - start
    return {
        "change": _result("change", change),
        "change_pct": _result("change_pct", change * 100 / abs(start)),
    }


@in_context
def round_number(value: object, places: object = 2) -> dict:
    """Half-up, so halves round away from zero (2.345 is 2.35, -2.345 is -2.35). A negative
    `places` rounds to tens, hundreds and so on: -3 is the nearest thousand."""
    number = _number_in(value, "value")
    if isinstance(places, bool) or not isinstance(places, int):
        raise FinanceInputError("places must be a whole number")
    if not MIN_PLACES <= places <= MAX_PLACES:
        raise FinanceInputError(f"places must be between {MIN_PLACES} and {MAX_PLACES}")
    rounded = number.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP, context=CONTEXT)
    if rounded.is_zero():
        rounded = rounded.copy_abs()  # never -0.00
    return {"rounded": rounded}
