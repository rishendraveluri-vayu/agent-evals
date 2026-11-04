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
    "crore": 10_000_000.0,
    "crores": 10_000_000.0,
    "cr": 10_000_000.0,
    "thousand": 1_000.0,
    "k": 1_000.0,
}
# Scales that make a bare number an amount on their own. "k" and "thousand" need a rupee marker.
MONEY_SCALES = {"lakh", "lakhs", "lac", "lacs", "crore", "crores", "cr"}

NUMBER_RE = re.compile(
    # A rupee marker, then the number. Without a marker the number must start a token, so the
    # 5 in "v5" or the 41 in "4.41" is never read on its own.
    r"(?:(?P<cur>₹|\bRs\.?|\bINR)\s?)?"
    r"(?(cur)|(?<![\w.,]))"
    r"(?P<num>\d+(?:,\d+)*(?:\.\d+)?)"
    r"(?![\w,]*\d)"
    r"(?:\s?(?P<scale>lakhs?|lacs?|crores?|cr|thousand|k)\b)?"
    r"(?:\s?(?P<cur2>rupees?)\b)?",
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
        if scale in ("k", "thousand") and not currency:
            scale = ""  # "20k steps": not money, and keep the bare number only
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
