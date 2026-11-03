"""Decimal arithmetic, paise rounding and Indian-style formatting.

Every calculation runs under CONTEXT (50 significant digits, ROUND_HALF_UP). Money is rounded
half-up to paise (0.01) wherever the tools say it is. Nothing here reads a clock, the locale or
any global state, so the same inputs always give the same strings.
"""

import functools
import math
from collections.abc import Callable
from decimal import ROUND_HALF_UP, Context, Decimal, localcontext

CONTEXT = Context(prec=50, rounding=ROUND_HALF_UP)
PAISE = Decimal("0.01")
ZERO = Decimal("0.00")
LAKH = Decimal(100_000)
CRORE = Decimal(10_000_000)
RUPEE = "₹"


class FinanceInputError(ValueError):
    """An input the tools reject. The message is short and safe to show the model."""


def in_context[**P, R](fn: Callable[P, R]) -> Callable[P, R]:
    """Run fn under CONTEXT. Decimal contexts are per thread, and the SDK runs sync tools on
    worker threads, so every public calculator sets its own instead of relying on a global."""

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        with localcontext(CONTEXT):
            return fn(*args, **kwargs)

    return wrapper


def to_decimal(value: object, name: str) -> Decimal:
    """A JSON number as an exact Decimal. Floats go through repr, the shortest string that
    round-trips, so 9.1 becomes Decimal('9.1') rather than its binary expansion."""
    if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
        raise FinanceInputError(f"{name} must be a number")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise FinanceInputError(f"{name} must be a finite number")
        return Decimal(repr(value))
    result = Decimal(value)
    if not result.is_finite():
        raise FinanceInputError(f"{name} must be a finite number")
    return result


def round2(value: Decimal) -> Decimal:
    """Round half-up to paise. Never returns negative zero."""
    rounded = value.quantize(PAISE, rounding=ROUND_HALF_UP, context=CONTEXT)
    return ZERO if rounded.is_zero() else rounded


def round_pct(value: Decimal) -> Decimal:
    """Percentages in outputs: half-up to 2 decimals, like money."""
    return round2(value)


def group_indian(digits: str) -> str:
    """'1234567' -> '12,34,567': the last three digits, then groups of two."""
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    groups: list[str] = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return ",".join([*groups, tail])


def format_inr(amount: Decimal) -> str:
    """'₹12,34,567.89'. Negative amounts put the sign before the rupee sign: '-₹1,500.00'."""
    rounded = round2(amount)
    sign = "-" if rounded < 0 else ""
    whole, paise = f"{abs(rounded):f}".split(".")
    return f"{sign}{RUPEE}{group_indian(whole)}.{paise}"


def _plain_number(value: Decimal) -> str:
    """2 decimals at most, trailing zeros dropped, Indian grouping: 12.30 -> '12.3'."""
    text = f"{value.normalize(context=CONTEXT):f}"
    whole, _, frac = text.partition(".")
    return group_indian(whole) + (f".{frac}" if frac else "")


def inr_words(amount: Decimal) -> str | None:
    """'12.35 lakh' or '1.2 crore', or None below one lakh.

    Works on the paise-rounded amount. The lakh figure is rounded half-up to 2 decimals; if
    that reaches 100 lakh, or the amount is at least one crore, it is given in crore instead.
    """
    rounded = round2(amount)
    size = abs(rounded)
    if size < LAKH:
        return None
    sign = "-" if rounded < 0 else ""
    lakhs = round2(CONTEXT.divide(size, LAKH))
    if size >= CRORE or lakhs >= 100:
        return f"{sign}{_plain_number(round2(CONTEXT.divide(size, CRORE)))} crore"
    return f"{sign}{_plain_number(lakhs)} lakh"


def money(name: str, amount: Decimal, *, words: bool = False) -> dict[str, Decimal | str]:
    """The output fields for one money value: `name` (rupees, 2 decimals), `name_formatted`,
    and, when words=True and the amount is at least one lakh, `name_words`."""
    rounded = round2(amount)
    fields: dict[str, Decimal | str] = {name: rounded, f"{name}_formatted": format_inr(rounded)}
    if words and (text := inr_words(rounded)) is not None:
        fields[f"{name}_words"] = text
    return fields
