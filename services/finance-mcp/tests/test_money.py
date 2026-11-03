from decimal import Decimal

import pytest
from finance_mcp.money import FinanceInputError, format_inr, inr_words, money, round2, to_decimal
from finance_mcp.output import to_json


@pytest.mark.parametrize(
    ("amount", "expected"),
    [
        ("100000", "₹1,00,000.00"),
        ("1234567.89", "₹12,34,567.89"),
        ("-1234567.89", "-₹12,34,567.89"),
        ("999.5", "₹999.50"),
        ("1000", "₹1,000.00"),
        ("12", "₹12.00"),
        ("0", "₹0.00"),
        ("0.5", "₹0.50"),
        ("-0.004", "₹0.00"),  # rounds to zero, and zero is never negative
        ("-75", "-₹75.00"),
        ("99999.995", "₹1,00,000.00"),  # half-up to paise first
        ("10000000", "₹1,00,00,000.00"),
        ("1000000000000", "₹10,00,00,00,00,000.00"),
    ],
)
def test_format_inr(amount: str, expected: str) -> None:
    assert format_inr(Decimal(amount)) == expected


@pytest.mark.parametrize(
    ("amount", "expected"),
    [
        ("99999.99", None),
        ("100000", "1 lakh"),
        ("1234567.89", "12.35 lakh"),
        ("2500000", "25 lakh"),
        ("-2500000", "-25 lakh"),
        ("9999999.99", "1 crore"),  # 100.00 lakh is shown as crore
        ("9949999", "99.5 lakh"),
        ("12000000", "1.2 crore"),
        ("123456789012", "12,345.68 crore"),
    ],
)
def test_inr_words(amount: str, expected: str | None) -> None:
    assert inr_words(Decimal(amount)) == expected


def test_round2_is_half_up_not_bankers() -> None:
    assert round2(Decimal("2.345")) == Decimal("2.35")
    assert round2(Decimal("2.335")) == Decimal("2.34")
    assert round2(Decimal("-2.345")) == Decimal("-2.35")
    assert str(round2(Decimal("-0.001"))) == "0.00"


def test_money_fields() -> None:
    assert money("emi", Decimal("8997.255")) == {
        "emi": Decimal("8997.26"),
        "emi_formatted": "₹8,997.26",
    }
    assert money("x", Decimal("150000"), words=True)["x_words"] == "1.5 lakh"
    assert "x_words" not in money("x", Decimal("99999"), words=True)


def test_to_decimal_uses_shortest_float_repr() -> None:
    assert to_decimal(9.1, "r") == Decimal("9.1")
    assert to_decimal(240, "n") == Decimal(240)
    for bad in (True, "12", None, float("nan"), float("inf")):
        with pytest.raises(FinanceInputError):
            to_decimal(bad, "x")


def test_to_json_is_compact_exact_and_ordered() -> None:
    value = {
        "b": Decimal("1000.10"),
        "a": [1, None, True, "₹1,000.10"],
        "z": {"n": Decimal("0.00")},
    }
    assert to_json(value) == '{"b":1000.10,"a":[1,null,true,"₹1,000.10"],"z":{"n":0.00}}'


def test_to_json_refuses_floats() -> None:
    with pytest.raises(TypeError):
        to_json({"x": 1.5})
