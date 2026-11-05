"""The arithmetic tools (D54) against an independent reference, plus their edge cases.

The reference uses exact rational arithmetic (fractions.Fraction) and shares no code with the
server: inputs go in through their shortest repr, results are rounded half-up (away from zero) at
the end, and anything whose rounded value lies outside -10^12 to 10^12 is an error. Every pair
from a grid of values is compared, so negatives, floats, zero, paise boundaries and the largest
values all meet each other in every tool.
"""

import math
from decimal import Decimal
from fractions import Fraction as F
from itertools import product

import pytest
from finance_mcp import arithmetic as ar
from finance_mcp.money import FinanceInputError
from finance_mcp.output import to_json

LIMIT = F(10**12)

GRID = [
    0,
    1,
    -1,
    0.1,
    0.2,
    0.005,
    -0.005,
    2.5,
    -2.5,
    3,
    7,
    9.1,
    12,
    8997.26,
    14120,
    18332.5,
    -9000,
    1_000_000,
    999_999_999_999.99,
    10**12,
    -(10**12),
]


def exact(x: object) -> F:
    return F(repr(x)) if isinstance(x, float) else F(x)


def half_up(x: F, places: int = 2) -> F:
    scale = F(10) ** places
    whole = math.floor(abs(x) * scale + F(1, 2))
    return (whole if x >= 0 else -whole) / scale


def ref(x: F) -> F | None:
    """The 2-decimal result, or None where the tool must refuse it as out of range."""
    rounded = half_up(x)
    return rounded if abs(rounded) <= LIMIT else None


def two_places(value: Decimal) -> F:
    """A result as a Fraction, after checking it is written with exactly two decimals."""
    assert value.as_tuple().exponent == -2, value
    assert not (value.is_zero() and value.is_signed()), value
    return F(value)


def check(fn, args: tuple, key: str, expected: F | None) -> None:
    if expected is None:
        with pytest.raises(FinanceInputError, match=f"the {key} is outside -10\\^12 to 10\\^12"):
            fn(*args)
        return
    out = fn(*args)
    assert list(out) == [key]
    assert two_places(out[key]) == expected, (args, out)


# --- the grid ----------------------------------------------------------------------------------


@pytest.mark.parametrize(("a", "b"), list(product(GRID, GRID)))
def test_two_number_tools_match_the_reference(a, b) -> None:
    x, y = exact(a), exact(b)
    check(ar.add, ([a, b],), "sum", ref(x + y))
    check(ar.subtract, (a, b), "difference", ref(x - y))
    check(ar.multiply, ([a, b],), "product", ref(x * y))
    check(ar.percent_of, (a, b), "amount", ref(x * y / 100))
    if y == 0:
        with pytest.raises(FinanceInputError, match="cannot divide by zero: b is 0"):
            ar.divide(a, b)
    else:
        check(ar.divide, (a, b), "quotient", ref(x / y))
    if x == 0:
        with pytest.raises(FinanceInputError, match="from_value is 0"):
            ar.percent_change(a, b)
        return
    change, pct = ref(y - x), ref((y - x) * 100 / abs(x))
    if change is None or pct is None:
        with pytest.raises(FinanceInputError, match="is outside"):
            ar.percent_change(a, b)
        return
    out = ar.percent_change(a, b)
    assert list(out) == ["change", "change_pct"]
    assert (two_places(out["change"]), two_places(out["change_pct"])) == (change, pct)


@pytest.mark.parametrize(("value", "places"), list(product(GRID, range(-7, 11))))
def test_round_matches_the_reference(value, places) -> None:
    out = ar.round_number(value, places)
    assert list(out) == ["rounded"]
    rounded = out["rounded"]
    assert F(rounded) == half_up(exact(value), places)
    assert not (rounded.is_zero() and rounded.is_signed())
    text = to_json(rounded)
    if places > 0:
        assert len(text.partition(".")[2]) == places, text
    else:
        assert "." not in text and "E" not in text, text


# --- each tool's own cases ---------------------------------------------------------------------


def test_add_and_multiply_take_2_to_100_numbers() -> None:
    for fn in (ar.add, ar.multiply):
        for bad in ([], [5], list(range(101)), "1,2", None, (1, 2)):
            with pytest.raises(FinanceInputError, match="must be a list of 2 to 100 numbers"):
                fn(bad)
    assert ar.add(list(range(100))) == {"sum": Decimal("4950.00")}
    assert ar.multiply([1.5] * 3 + [1] * 97) == {"product": Decimal("3.38")}


def test_inputs_must_be_finite_numbers_within_the_bounds() -> None:
    with pytest.raises(FinanceInputError, match=r"values\[1\] must be a number"):
        ar.add([1, "2"])
    with pytest.raises(FinanceInputError, match=r"values\[0\] must be a number"):
        ar.add([True, 2])
    with pytest.raises(FinanceInputError, match="a must be a finite number"):
        ar.subtract(math.nan, 1)
    with pytest.raises(FinanceInputError, match="b must be a finite number"):
        ar.divide(1, math.inf)
    with pytest.raises(FinanceInputError, match=r"values\[1\] must be within -10\^12 to 10\^12"):
        ar.add([1, 10**12 + 1])
    with pytest.raises(FinanceInputError, match=r"percent must be within -10\^12 to 10\^12"):
        ar.percent_of(100, -1e13)
    with pytest.raises(FinanceInputError, match=r"value must be within -10\^12 to 10\^12"):
        ar.round_number(-1.5e12)


def test_floats_are_exact_decimals_not_binary() -> None:
    assert ar.add([0.1, 0.2]) == {"sum": Decimal("0.30")}
    assert ar.subtract(0.3, 0.1) == {"difference": Decimal("0.20")}
    assert ar.multiply([1.1, 1.1]) == {"product": Decimal("1.21")}
    assert ar.round_number(1.005) == {"rounded": Decimal("1.01")}  # Python's round gives 1.0
    assert ar.round_number(2.675) == {"rounded": Decimal("2.68")}  # Python's round gives 2.67


def test_results_are_rounded_half_up_away_from_zero() -> None:
    assert ar.divide(1, 8) == {"quotient": Decimal("0.13")}
    assert ar.divide(-1, 8) == {"quotient": Decimal("-0.13")}
    assert ar.divide(100000, 3) == {"quotient": Decimal("33333.33")}
    assert ar.divide(200000, 3) == {"quotient": Decimal("66666.67")}
    assert ar.add([0.004, 0.001]) == {"sum": Decimal("0.01")}
    assert ar.round_number(-2.345) == {"rounded": Decimal("-2.35")}
    assert ar.round_number(-0.004) == {"rounded": Decimal("0.00")}


def test_negative_numbers_and_zero_never_show_as_negative_zero() -> None:
    assert ar.add([-14120, -9000]) == {"sum": Decimal("-23120.00")}
    assert ar.subtract(9000, 23120) == {"difference": Decimal("-14120.00")}
    assert ar.multiply([-3, -4]) == {"product": Decimal("12.00")}
    for out in (ar.multiply([-5, 0]), ar.subtract(0.001, 0.002), ar.add([-0.001, 0])):
        (value,) = out.values()
        assert value == 0 and not value.is_signed() and str(value) == "0.00"


def test_very_large_values() -> None:
    assert ar.add([10**12, -(10**12)]) == {"sum": Decimal("0.00")}
    assert ar.add([999_999_999_999.99, 0.01]) == {"sum": Decimal("1000000000000.00")}
    assert ar.add([999_999_999_999.99, 0.014]) == {"sum": Decimal("1000000000000.00")}
    with pytest.raises(FinanceInputError, match=r"the sum is outside -10\^12 to 10\^12"):
        ar.add([999_999_999_999.99, 0.015])
    with pytest.raises(FinanceInputError, match="the difference is outside"):
        ar.subtract(-(10**12), 1)
    with pytest.raises(FinanceInputError, match="the product is outside"):
        ar.multiply([10**12] * 100)  # 10^1200: refused, not a crash while rounding
    assert ar.multiply([10**12, 10**-12]) == {"product": Decimal("1.00")}
    with pytest.raises(FinanceInputError, match="the quotient is outside"):
        ar.divide(10**12, 0.5)
    assert ar.divide(10**12, 10**12) == {"quotient": Decimal("1.00")}
    assert ar.round_number(10**12, -7) == {"rounded": Decimal("1.00000E+12")}
    assert to_json(ar.round_number(10**12, -7)) == '{"rounded":1000000000000}'


def test_division_by_zero_is_a_plain_error() -> None:
    for zero in (0, 0.0, -0.0):
        with pytest.raises(FinanceInputError) as caught:
            ar.divide(5000, zero)
        assert str(caught.value) == "cannot divide by zero: b is 0"


def test_percent_of() -> None:
    assert ar.percent_of(50000, 18) == {"amount": Decimal("9000.00")}
    assert ar.percent_of(92500, 40) == {"amount": Decimal("37000.00")}
    assert ar.percent_of(84250, 3.5) == {"amount": Decimal("2948.75")}
    assert ar.percent_of(1000, 250) == {"amount": Decimal("2500.00")}
    assert ar.percent_of(1000, -5) == {"amount": Decimal("-50.00")}


def test_percent_change() -> None:
    assert ar.percent_change(14120, 23120) == {
        "change": Decimal("9000.00"),
        "change_pct": Decimal("63.74"),
    }
    assert ar.percent_change(60000, 50000) == {
        "change": Decimal("-10000.00"),
        "change_pct": Decimal("-16.67"),
    }
    # A rise is positive even from a negative start: -100 to -50 is up by half.
    assert ar.percent_change(-100, -50) == {
        "change": Decimal("50.00"),
        "change_pct": Decimal("50.00"),
    }
    assert ar.percent_change(5, 5) == {"change": Decimal("0.00"), "change_pct": Decimal("0.00")}
    with pytest.raises(FinanceInputError, match="from_value is 0, so there is no percent change"):
        ar.percent_change(0, 0)
    with pytest.raises(FinanceInputError, match="the change_pct is outside"):
        ar.percent_change(0.0001, 10**10)


def test_round_places() -> None:
    assert ar.round_number(23120.456) == {"rounded": Decimal("23120.46")}
    assert to_json(ar.round_number(23120.456, 0)) == '{"rounded":23120}'
    assert to_json(ar.round_number(23120.456, -3)) == '{"rounded":23000}'
    assert to_json(ar.round_number(123456, -5)) == '{"rounded":100000}'
    assert to_json(ar.round_number(150000, -5)) == '{"rounded":200000}'
    assert to_json(ar.round_number(1.23456789, 4)) == '{"rounded":1.2346}'
    assert to_json(ar.round_number(5, 3)) == '{"rounded":5.000}'
    for bad in (1.5, "2", True, None):
        with pytest.raises(FinanceInputError, match="places must be a whole number"):
            ar.round_number(1, bad)
    for bad in (-8, 11):
        with pytest.raises(FinanceInputError, match="places must be between -7 and 10"):
            ar.round_number(1, bad)


def test_results_hold_only_what_the_tool_worked_out() -> None:
    """No input is echoed back: a provenance check reading this result finds the answer only,
    never a number the agent passed in."""
    assert to_json(ar.add([14120, 9000])) == '{"sum":23120.00}'
    assert to_json(ar.percent_of(50000, 18)) == '{"amount":9000.00}'
    assert to_json(ar.percent_change(14120, 23120)) == '{"change":9000.00,"change_pct":63.74}'
