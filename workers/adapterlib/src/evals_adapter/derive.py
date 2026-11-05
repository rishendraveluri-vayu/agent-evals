"""One-step derivations in prose (D61, 5 Nov): is a figure in an answer a sum, difference,
product, ratio or percentage of numbers a reader can see? The checker recomputes each candidate
exactly and accepts it when it explains the figure at the precision the figure is written in
(the amounts' rule, `_match_rank` in checks.py, passed in as `rank`). Standard library only.

The search is bounded on purpose, because every extra pairing is another way for a figure the
agent made up, or simply chose ("such as ₹3,000 a month"), to match by chance. On the 4 Nov
transcripts a search over every pair of source numbers, at the sources' tolerance, "verified" 28%
of the figures moved 7% to 13% off their true value; these pools, with matches at the precision
written (no trailing-zeros rounding, checks.DERIVE_COARSE), bring that to 4.5% (A44). The pools
keep the operands to what the answer shows:

- **sum, difference:** a figure written in the answer, and another written figure or a sourced
  amount;
- **product, ratio:** a written figure or sourced amount, times or divided by a multiplier (a
  count written in the answer, or 12);
- **percentage:** a written figure or sourced amount, times a percent (one written in the answer
  or a rate in a source), over 100.

checks.py builds the pools (A44 has the exact rule).
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, localcontext

AMOUNT_MIN = Decimal(100)  # a sourced number this size or more is an amount
OPS = ("add", "subtract", "multiply", "divide", "percent_of")  # also the order of preference


@dataclass(frozen=True)
class Operand:
    value: Decimal  # non-negative: amounts are matched without their sign
    where: str  # tool:<name>, client:<file>, task:0, answer:<turn>, unit fact, answer %


@dataclass(frozen=True)
class Derivation:
    op: str
    operands: tuple[Operand, ...]
    value: Decimal  # the exact result
    rank: int  # the amounts' match rank: 0 exact, 1 rounded, 2 truncated, 3 trailing zeros


class Pool:
    """Operands sorted by value, one per value (the first offered wins, so callers offer their
    best source first)."""

    def __init__(self, operands: Iterable[Operand]) -> None:
        seen: dict[Decimal, Operand] = {}
        for op in operands:
            if op.value.is_finite() and op.value > 0 and op.value not in seen:
                seen[op.value] = op
        self.items = sorted(seen.values(), key=lambda o: o.value)
        self.values = [o.value for o in self.items]

    def between(self, lo: Decimal, hi: Decimal) -> list[Operand]:
        """Operands with lo <= value <= hi."""
        if hi < lo:
            return []
        return self.items[bisect_left(self.values, lo) : bisect_right(self.values, hi)]


@dataclass
class Pools:
    written: Pool  # figures verified in the answer so far
    amounts: Pool  # written figures and sourced amounts (AMOUNT_MIN or more)
    multipliers: Pool
    percents: Pool


def _exact(op: str, a: Decimal, b: Decimal) -> Decimal | None:
    with localcontext() as ctx:
        ctx.prec = 50
        try:
            if op == "add":
                return a + b
            if op == "subtract":
                return abs(a - b)
            if op == "multiply":
                return a * b
            if op == "divide":
                return a / b if b else None
            if op == "percent_of":
                return a * b / 100
        except InvalidOperation:
            return None
    return None


def find(
    window: tuple[Decimal, Decimal], rank: Callable[[Decimal], int | None], pools: Pools
) -> Derivation | None:
    """The best one-step derivation of a figure whose matching values lie within `window` (a
    superset, in rupees, from the figure's precision), or None. `rank` is the figure's match rank
    for a candidate value. Best is the lowest rank, then the order of OPS, then the smallest
    operands."""
    lo, hi = window
    if hi <= 0:
        return None
    found: list[tuple[int, int, list[Decimal], Derivation]] = []

    def offer(op: str, a: Operand, b: Operand) -> None:
        value = _exact(op, a.value, b.value)
        r = rank(value) if value is not None else None
        if value is not None and r is not None:
            d = Derivation(op, (a, b), value, r)
            found.append((r, OPS.index(op), [a.value, b.value], d))

    for a in pools.written.items:  # a + b = x and |a - b| = x: a written, b written or sourced
        for b in pools.amounts.between(lo - a.value, hi - a.value):
            if b.value != a.value:
                offer("add", a, b)
        for b in pools.amounts.between(a.value - hi, a.value - lo):
            offer("subtract", a, b)
        for b in pools.amounts.between(a.value + lo, a.value + hi):
            offer("subtract", b, a)
    for m in pools.multipliers.items:  # a * m = x and a / m = x
        for a in pools.amounts.between(lo / m.value, hi / m.value):
            offer("multiply", a, m)
        for a in pools.amounts.between(lo * m.value, hi * m.value):
            offer("divide", a, m)
    for p in pools.percents.items:  # a * p / 100 = x
        for a in pools.amounts.between(lo * 100 / p.value, hi * 100 / p.value):
            offer("percent_of", a, p)
    if not found:
        return None
    found.sort(key=lambda f: (f[0], f[1], f[2]))
    return found[0][3]
