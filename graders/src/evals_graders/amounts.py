"""Numbers and rupee amounts in an agent's text.

An amount is a number with a rupee marker (₹, Rs, Rs., INR, "rupees"), a lakh or crore scale,
or digit grouping (Indian ₹1,01,341 or Western 101,341). `match: "any"` also takes bare numbers
such as the 28 in "28 months". Each found number keeps its exact text and position, so a grade
can quote what it relied on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SCALES = {
    "lakh": 100_000.0,
    "lakhs": 100_000.0,
    "lac": 100_000.0,
    "lacs": 100_000.0,
    "l": 100_000.0,  # only as "₹49.41L": a capital L right after a marked amount
    "crore": 10_000_000.0,
    "crores": 10_000_000.0,
    "cr": 10_000_000.0,
    "thousand": 1_000.0,
    "k": 1_000.0,
    "million": 1_000_000.0,
    "mn": 1_000_000.0,
}
# Scales that make a bare number an amount on their own. "k", "thousand", "million" and "mn" need
# a rupee marker.
MONEY_SCALES = {"lakh", "lakhs", "lac", "lacs", "crore", "crores", "cr"}
MARKED_ONLY = {"k", "thousand", "million", "mn"}

# The money reader agrees with the runner's (evals_adapter.checks.TOKEN) on every marked amount
# (G10, 6 Nov review; tests/test_amounts.py runs both over the same cases): a no-break, thin or
# narrow space, or markdown emphasis between the marker and the number or the number and its
# scale ("₹ 45,000", "₹**45,000**", "₹4.41 **lakh**"), a minus after the marker ("₹-5,000",
# read without its sign, as "-₹5,000" is), and "₹49.41L". Digit runs are capped at 30 digits (G6:
# a 60,000-digit run took the unit test past its timeout), so a longer run is no number.
GAP = r"(?:[ \t   ]|\*)*"
NUMBER_RE = re.compile(
    # A rupee marker, then the number. Without a marker the number must start a token, so the
    # 5 in "v5" or the 41 in "4.41" is never read on its own.
    rf"(?:(?P<cur>₹|\bRs\.?|\bINR){GAP}[-−]?)?"
    r"(?(cur)|(?<![\w.,]))"
    r"(?P<num>\d{1,30}(?:,\d{1,30}){0,12}(?:\.\d{1,30})?)"
    r"(?![\w,]*?\d)"
    rf"(?:{GAP}(?P<scale>lakhs?|lacs?|crores?|cr|thousand|k|million|mn|L)\b)?"
    rf"(?:{GAP}(?P<cur2>rupees?)\b)?",
    re.IGNORECASE,
)
INDIAN = re.compile(r"^\d{1,2}(?:,\d{2})*,\d{3}(?:\.\d+)?$")
WESTERN = re.compile(r"^\d{1,3}(?:,\d{3})+(?:\.\d+)?$")


@dataclass(frozen=True)
class Found:
    value: float
    text: str
    start: int
    end: int
    is_amount: bool


def find_numbers(text: str) -> list[Found]:
    """Every number in `text`, with whether it reads as a rupee amount."""
    out: list[Found] = []
    for m in NUMBER_RE.finditer(text):
        num = m.group("num")
        grouped = "," in num
        if grouped and not (INDIAN.match(num) or WESTERN.match(num)):
            continue  # "1,2,3" is a list, not a number
        scale = (m.group("scale") or "").lower()
        currency = bool(m.group("cur") or m.group("cur2"))
        if scale in MARKED_ONLY and not currency:
            scale = ""  # "20k steps": not money, and keep the bare number only
        if scale == "l" and not (m.group("scale") == "L" and m.group("cur")):
            scale = ""  # "12 l of milk": a litre, not a lakh
        value = float(num.replace(",", "")) * SCALES.get(scale, 1.0)
        is_amount = currency or grouped or scale in MONEY_SCALES
        start = m.start("cur") if m.group("cur") else m.start("num")
        end = m.end()
        if not (m.group("scale") and scale) and not m.group("cur2"):
            end = m.end("num")
        out.append(Found(value, text[start:end].strip(), start, end, is_amount))
    return out


def find(text: str, match: str = "amount") -> list[Found]:
    found = find_numbers(text)
    return found if match == "any" else [f for f in found if f.is_amount]


def context(text: str, start: int, end: int, width: int = 80) -> str:
    """The line around [start, end), cut to about `width` characters each side. A verbatim
    substring of `text`, so it can be quoted as evidence."""
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    line_end = len(text) if line_end == -1 else line_end
    lo = max(line_start, start - width)
    hi = min(line_end, end + width)
    return text[lo:hi].strip()


def within(found: float, expected: float, tolerance: dict[str, float]) -> bool:
    """Within `abs` or within `rel` (a fraction of expected), whichever is looser."""
    diff = abs(found - expected)
    limits = []
    if "abs" in tolerance:
        limits.append(float(tolerance["abs"]))
    if "rel" in tolerance:
        limits.append(float(tolerance["rel"]) * abs(expected))
    if not limits:
        limits.append(0.0)
    return diff <= max(limits) + 1e-9


def fmt_inr(value: float) -> str:
    """₹1,01,341.01: Indian grouping, paise only when there are any."""
    negative = value < 0
    value = abs(value)
    whole = int(value)
    paise = round((value - whole) * 100)
    if paise == 100:
        whole, paise = whole + 1, 0
    digits = str(whole)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join(groups) + "," + tail
    text = f"₹{digits}" + (f".{paise:02d}" if paise else "")
    return ("-" if negative else "") + text
