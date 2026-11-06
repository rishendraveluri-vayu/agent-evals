"""Platform checks the runner makes after every trial, written to /trial/out/checks.json
(contract v2, `contract/v2/checks.schema.json`). Standard library only.

1. **Number provenance** (Rishi's review notes 21 and 31). Every money amount the agent wrote in
   its replies (₹ and Rs amounts, Indian digit grouping, lakh and crore forms such as
   "₹4.41 lakh") is looked up in what the agent could have read by then:

   - `tool`: a tool result (the `execute_tool` spans of the same or an earlier agent turn);
   - `client`: the task's client file (the files in /trial/state);
   - `user`: a user or simulated-client message before the reply.

   An amount matches a number when it equals it at the precision shown: exactly, rounded
   half-up, or cut (truncated) to the digits written ("about ₹8,997" matches 8997.26, "₹1,667"
   matches 1667.50, "₹1.23 lakh" matches 123,456), cutting only for a figure written with three
   significant digits or more ("₹5 lakh" matches 4.50 to 5.49 lakh, not 5.95 lakh). Trailing
   zeros in a whole amount may also be rounding, as long as two significant digits remain and
   the number is within 1% of the amount ("about ₹49,500" matches 49,483; "₹31,000" does not
   match 31,330). This is a heuristic for a reader, not a grade.

   **Verify, don't trace (D61, A44).** Each amount is verified one of three ways, recorded in
   `verified_by`:

   - `source`: it matches a number in a source, as above;
   - `tool`: it matches the result of an arithmetic call that counts (below);
   - `derived_in_prose`: the checker recomputes it as a one-step derivation of numbers a reader
     can see (derive.py): a sum or difference of a figure the answer wrote and verified and
     another such figure or a sourced amount; a sourced amount or written figure times or
     divided by 12 or a count the answer writes ("3 months"); a percentage of one at a rate the
     answer states or a source holds; or the sum of a run of 3 to 8 verified figures written
     next to it. It must match at the precision written, not by trailing-zeros rounding.

   Anything else is `unsupported`, a wrong sum included. `derived_in_prose` counts the figures
   written without a tool, the measure D61 reports per arm.

   **Arithmetic tools** (`add`, `subtract`, `multiply`, `divide`, `percent_of`,
   `percent_change`, `round`): a call's result counts when the call returned no error and each
   number it was given is sourced (an earlier non-arithmetic tool result or counted arithmetic
   result, the client file, or a message up to the call's turn) or a free factor (a unit fact,
   a whole number from 1 to 60, a percentage the replies state); add, subtract, percent_change
   and round need a source for every input; every call needs one sourced amount (100 or more);
   and no number in its result only repeats an input with no source (D58's identity guard). So
   `multiply([emi, 12])` counts and `multiply([100, 12])` does not, and `round(x)` or
   `add([x, 0])` on a made-up x does not. Every call is listed in `arithmetic` with each input's
   status and, when it does not count, the reason; an amount whose only match is such a result
   names it in `rejected`. The other tools' results count whatever their inputs.

2. **Required tool calls** (a grader primitive). A task may list `required_tools` in the spec;
   the check records which of them the agent called and which are missing, from the trace's
   `execute_tool` spans, with harness prefixes such as Hermes's `mcp__finance__` removed.

Run it on a finished trial folder: `python -m evals_adapter.checks <trial-dir>`.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from evals_adapter.derive import AMOUNT_MIN, Derivation, Operand, Pool, Pools, find
from evals_adapter.spec import CONTRACT_VERSION, TrialPaths

SOURCES = ("tool", "client", "user")  # also the order of preference between equal matches
HOW = ("exact", "rounded", "truncated", "rounded")  # by match rank; rank 3 is trailing zeros

# Number words that scale what comes before them. Case-insensitive.
UNIT_WORDS = {
    "lakh": 100_000,
    "lakhs": 100_000,
    "lac": 100_000,
    "lacs": 100_000,
    "crore": 10_000_000,
    "crores": 10_000_000,
    "cr": 10_000_000,
    "thousand": 1_000,
    "k": 1_000,
    "million": 1_000_000,
    "mn": 1_000_000,
    "l": 100_000,  # only as "₹1.2L", directly after a marked amount
}
MONEY_UNITS = {"lakh", "lakhs", "lac", "lacs", "crore", "crores", "cr"}  # money without a marker

NUMBER = r"\d+(?:,\d+)*(?:\.\d+)?"
UNIT = r"lakhs?|lacs?|crores?|cr\b\.?|thousand|k\b|million|mn\b|L\b"
# A number, with a currency marker before it or else not glued to a word or a decimal point
# (so "t001" and "v2.3" hold no numbers), and an optional unit word and "rupees" after it.
TOKEN = re.compile(
    rf"(?:(?P<cur>₹|\bRs\.?|\bINR)[ \t]*|(?<![\w.]))(?P<num>{NUMBER})"
    rf"(?:[ \t]*(?P<unit>{UNIT}))?(?:[ \t]*(?P<post>rupees?)\b)?",
    re.IGNORECASE,
)
# Dates and times in sources (transaction dates) are not amounts: 2026-10-25 is not ₹2,026.
DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b")
# Nor are the digits of a URL (D58: reference_rates cites its sources, such as an RBI press release
# at ...?prid=63742 or a PDF named with %20 and a year). A URL ends at whitespace or a quote, so
# one inside a JSON string stops at the string's end.
URL = re.compile(r"\bhttps?://[^\s\"'<>]+", re.IGNORECASE)
RANGE_GAP = re.compile(r"^[ \t]*(?:–|—|-|to)[ \t]*$", re.IGNORECASE)
WESTERN = re.compile(r"^\d{1,3}(?:,\d{3})+$")
INDIAN = re.compile(r"^\d{1,2}(?:,\d{2})*,\d{3}$")
INDIAN_LAKH_PLUS = re.compile(r"^\d{1,2}(?:,\d{2})+,\d{3}$")  # 1,00,000 and up
MCP_PREFIX = re.compile(r"^mcp__.+?__")
COARSE_TOLERANCE = Decimal("0.01")
# Cutting a number to the digits shown matches only a figure written with this many significant
# digits or more (G8): "about ₹8,997" for 8,997.26 and "₹4.41 lakh" for 4,41,999 still match.
TRUNCATE_MIN_DIGITS = 3

# D56: the finance server's arithmetic tools (toolset finance/v2, D54). Their results are sources
# only when their inputs are supported; every other tool's result is a source as it stands.
ARITHMETIC_TOOLS = frozenset(
    {"add", "subtract", "multiply", "divide", "percent_of", "percent_change", "round"}
)
# Arguments that say how a tool works, not a figure it works on (A40): round's decimal places.
NOT_FIGURES = {"round": frozenset({"places"})}
# D58: unit facts, which an arithmetic input may be without a source: days in a week (7), months
# in a year (12), days in a month (28 to 31), weeks in a year (52), a hundred for a percentage
# (100), days in a year (365, 366), a lakh (1,00,000) and a crore (1,00,00,000). Matched by value,
# sign ignored (12, 12.0 and -12 alike), and only as an arithmetic input: an amount in a reply
# still needs a source. Never 0 or 1, the identities that pass a made-up figure through unchanged.
UNIT_FACTS = frozenset(
    Decimal(n) for n in (7, 12, 28, 29, 30, 31, 52, 100, 365, 366, 100_000, 10_000_000)
)

# D61 (A44): figures are verified, not traced. A figure counts when it matches a source, or when
# the checker recomputes it as a one-step derivation (derive.py) with at least one sourced amount.
# Free factors, which an arithmetic tool's input may be without a source: the unit facts, whole
# numbers from 1 to COUNT_MAX (counts and periods: months, years, people, instalments), and
# percentages written in the agent's replies.
COUNT_MAX = 60
# A derivation in prose uses only factors a reader can see: a count written in the replies (a
# whole number from 2 to WRITTEN_COUNT_MAX that is not a money amount, in digits or as a word up
# to twelve), 12 (months in a year, nearly always said in words), a percentage written in the
# replies, or a rate in a source (a number written with %, or a JSON number under a key that
# names a rate or percentage).
WRITTEN_COUNT_MAX = 600
_WORDS = "two three four five six seven eight nine ten eleven twelve"
NUMBER_WORDS = {w: Decimal(n) for n, w in enumerate(_WORDS.split(), start=2)}
# A count is a number written right before what it counts: "3 months", "24 EMIs", "two people".
COUNTED = (
    r"months?|years?|yrs?|weeks?|days?|quarters?|people|persons?|members?|children|kids|"
    r"instal?l?ments?|EMIs?|payments?|times|visits?|sessions?"
)
# A counted word right after a number ("46 months", "12 more EMIs"): the number is a count.
COUNT_AFTER = re.compile(
    rf"[ \t-]*(?:more[ \t]+|extra[ \t]+|fewer[ \t]+|less[ \t]+)?(?:{COUNTED})\b", re.IGNORECASE
)
CURRENCY_BEFORE = re.compile(r"(?:₹|\bRs\.?|\bINR)[ \t]*$", re.IGNORECASE)
COUNT_TEXT = re.compile(
    rf"(?<![\w.,])(?P<n>\d+|{'|'.join(NUMBER_WORDS)})[ \t-]*(?:more[ \t]+|extra[ \t]+)?"
    rf"(?:{COUNTED})\b",
    re.IGNORECASE,
)
# A JSON key names a rate when one of its words (split at _) is one of these: annual_rate_pct,
# inflation_pct, expected_annual_return_pct. Not "returned_count".
RATE_WORDS = frozenset(
    {"pct", "percent", "percentage", "rate", "rates", "inflation", "return", "cagr"}
)
# A run of this many figures written one after another in a reply may add up to a figure next
# to it ("₹9,650, ₹18,500 and ₹2,605: about ₹30,750").
RUN_MIN, RUN_MAX = 3, 8
# A percentage in text: "7.4%", "7.4 %", "7.4 per cent".
PERCENT_TEXT = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)[ \t]*(?:%|per[ \t]?cent\b)", re.IGNORECASE)
# Arithmetic tools whose inputs must all have a source: a sum, a difference, a percent change
# and a rounding work on amounts, never on a free factor. The others (multiply, divide,
# percent_of) need one sourced amount; their other inputs may be free factors.
EVERY_INPUT_SOURCED = frozenset({"add", "subtract", "percent_change", "round"})
SOURCED = ("tool", "client", "user")  # an input's supported_by when a source holds it
# Whether a coarse match (trailing zeros within 1%) may verify a derivation, as it may a source.
# It may not (A44): a round figure is usually a choice or an estimate ("such as ₹4,500 a month"),
# and within 1% nearly every round figure is some sum or share of the numbers in an answer. On
# the 4 Nov transcripts it raised the share of figures moved 7% to 13% off that still "derived"
# from 4.5% to 10.9%. The cost: "about ₹40,200" for 40,211.63 stays unsupported.
DERIVE_COARSE = False


@dataclass(frozen=True)
class Amount:
    text: str
    shown: Decimal  # the digits as written, in `unit`
    unit: int
    decimals: int

    @property
    def value(self) -> Decimal:
        return self.shown * self.unit


def _grouped(digits: str) -> list[str] | None:
    """The number as one string without commas, or None if its commas are not a grouping."""
    whole, dot, frac = digits.partition(".")
    if "," not in whole:
        return [digits]
    if WESTERN.match(whole) or INDIAN.match(whole):
        return [whole.replace(",", "") + dot + frac]
    return None


def _unit_of(match: re.Match[str]) -> tuple[str | None, int]:
    word = (match.group("unit") or "").rstrip(".")
    if not word:
        return None, 1
    if word == "L" and match.group("cur"):
        return "l", UNIT_WORDS["l"]
    key = word.lower()
    if key == "l":  # a bare "l" or "L" without a currency marker is not a unit
        return None, 1
    return key, UNIT_WORDS[key]


def money_amounts(text: str) -> list[Amount]:
    """Every money amount in an agent's reply, in order. Money is a number with a currency
    marker (₹, Rs, INR, or "rupees" after it), or with lakh or crore after it, or written in
    Indian grouping from one lakh up (4,41,050), or a bare number right after a marked amount
    in a range ("₹8,000–9,000"). Other numbers (9%, 240 months, 2026) are not money."""
    found: list[Amount] = []
    last_end: int | None = None
    last_unit = 1
    for m in TOKEN.finditer(text):
        raw = m.group("num")
        unit_key, unit = _unit_of(m)
        whole = raw.partition(".")[0]
        parts = _grouped(raw)
        marked = bool(m.group("cur") or m.group("post"))
        percent = text[m.end() : m.end() + 1] == "%"
        # G9 (6 Nov review): "₹5.96 lakh – 46 months sooner" is a figure and a count, not a range:
        # the second end of a range is money only when no counted word follows it.
        in_range = (
            last_end is not None
            and RANGE_GAP.match(text[last_end : m.start()])
            and not COUNT_AFTER.match(text, m.end())
        )
        is_money = marked or (
            not percent
            and (
                unit_key in MONEY_UNITS
                or bool(INDIAN_LAKH_PLUS.match(whole))
                or (bool(in_range) and parts is not None)
            )
        )
        if not is_money or parts is None:
            if not is_money:
                last_end = None
            continue
        if unit == 1 and in_range and not marked:
            unit = last_unit
        if unit == 1 and m.group("cur"):
            unit = _range_unit(text, m.end()) or 1
        number = parts[0]
        decimals = len(number.partition(".")[2])
        try:
            shown = Decimal(number)
        except InvalidOperation:
            continue
        span_text = m.group(0).strip()
        found.append(Amount(span_text, shown, unit, decimals))
        last_end, last_unit = m.end(), unit
    return found


def _range_unit(text: str, end: int) -> int | None:
    """'₹2–3 lakh': a marked amount with no unit takes the unit of the range's other end."""
    rest = re.match(
        rf"^[ \t]*(?:–|—|-|to)[ \t]*(?:₹|Rs\.?|INR)?[ \t]*{NUMBER}[ \t]*(?P<unit>{UNIT})",
        text[end:],
        re.IGNORECASE,
    )
    if not rest:
        return None
    key = rest.group("unit").rstrip(".").lower()
    return UNIT_WORDS.get(key) if key in MONEY_UNITS else None


def source_numbers(text: str) -> list[Decimal]:
    """Every number in a source text (a tool result, a message, the client file), in rupees
    where a lakh or crore word follows it. Commas that are not a digit grouping (a JSON list)
    split the numbers. Dates and URLs hold none."""
    out: list[Decimal] = []
    for m in TOKEN.finditer(DATE.sub(" ", URL.sub(" ", text))):
        raw = m.group("num")
        parts = _grouped(raw)
        _, unit = _unit_of(m)
        if parts is None:
            whole, _, frac = raw.partition(".")
            pieces = whole.split(",")
            if frac:
                pieces[-1] += "." + frac
            parts, unit = pieces, 1
        for piece in parts:
            try:
                out.append(Decimal(piece) * unit)
            except InvalidOperation:
                continue
    return out


def significant_digits(shown: Decimal) -> int:
    """The significant digits a figure is written with: 3 for 4.41, 1 for 5 or 0.5, 3 for 500."""
    return len(shown.as_tuple().digits) if shown.is_finite() else 0


def _match_rank(amount: Amount, source: Decimal) -> tuple[int, Decimal] | None:
    """How well `source` (rupees) explains `amount`: (rank, step in rupees), best rank first:
    0 exact, 1 rounded to the digits shown, 2 cut to them, 3 rounded at trailing zeros.

    A figure written with fewer than TRUNCATE_MIN_DIGITS significant digits is never matched by
    cutting (G8, 6 Nov review): "₹5 lakh" was "supported" by anything from 5.00 to 5.99 lakh
    (₹5,95,511.77 included), and "₹1 lakh" by 1.00 to 1.99 lakh. It still matches by rounding,
    so "₹5 lakh" stands for 4.50 to 5.49 lakh."""
    value = abs(source) / amount.unit
    shown = abs(amount.shown)
    step = Decimal(1).scaleb(-amount.decimals)
    try:
        if value == shown:
            return 0, step * amount.unit
        if value.quantize(step, rounding=ROUND_HALF_UP) == shown:
            return 1, step * amount.unit
        if (
            significant_digits(shown) >= TRUNCATE_MIN_DIGITS
            and value.quantize(step, rounding=ROUND_DOWN) == shown
        ):
            return 2, step * amount.unit
        # Trailing zeros as rounding ("about ₹49,500" for 49,483): at least two significant
        # digits must remain, and the number must be within 1% of the amount, so a round
        # figure is not "supported" by any number that happens to round to it.
        if amount.decimals == 0 and shown != 0 and abs(value - shown) <= shown * COARSE_TOLERANCE:
            digits = str(int(shown))
            zeros = len(digits) - len(digits.rstrip("0"))
            for z in range(1, min(zeros, len(digits) - 2) + 1):
                coarse = Decimal(1).scaleb(z)
                rounded = (value / coarse).quantize(Decimal(1), rounding=ROUND_HALF_UP) * coarse
                if rounded == shown:
                    return 3, coarse * amount.unit
    except InvalidOperation:  # a source number too long to quantize
        return None
    return None


def _number(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


@dataclass
class Source:
    kind: str  # tool, client or user
    where: str
    turn: int  # the first agent turn that could have read it
    numbers: list[Decimal]
    call: int | None = None  # a tool source: the call's position among the trial's tool calls
    arithmetic: bool = False  # an arithmetic tool's result, a source only if its call is (D56)
    rates: list[Decimal] = field(default_factory=list)  # D61: its rates and percentages
    # G11 (6 Nov review): a call that returned an error is never a source. Its message can echo
    # the call's own arguments ("unknown argument(s) ₹50,000"), which would source a made-up
    # figure. It is kept only so an amount that matches it says why it does not count.
    error: bool = False


def _attrs(span: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for item in span.get("attributes", []):
        value = item.get("value", {})
        out[item.get("key")] = next(iter(value.values()), None) if value else None
    return out


def tool_name(raw: str) -> str:
    """A harness's tool name as the finance server names it: Hermes's mcp__finance__x is x."""
    return MCP_PREFIX.sub("", raw)


def read_spans(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    spans = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip():
            try:
                spans.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return spans


def tool_calls(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The execute_tool spans as {index, name, turn, is_error, arguments, result}, in start
    order. `index` is the call's position in that order, from 0; `turn` is the agent turn the
    call belongs to, or -1 when the span has no turn parent."""
    turns = {
        s.get("spanId"): _attrs(s).get("evals.turn.index")
        for s in spans
        if s.get("name") == "agent.turn"
    }
    calls = []
    ordered = sorted(spans, key=lambda s: int(s.get("startTimeUnixNano", "0") or 0))
    for span in ordered:
        if not str(span.get("name", "")).startswith("execute_tool"):
            continue
        a = _attrs(span)
        raw = a.get("gen_ai.tool.name") or str(span["name"]).removeprefix("execute_tool ").strip()
        turn = turns.get(span.get("parentSpanId"))
        calls.append(
            {
                "index": len(calls),
                "name": tool_name(str(raw)),
                "turn": int(turn) if turn is not None else -1,
                "is_error": bool(a.get("evals.tool.is_error")),
                "arguments": a.get("evals.tool.arguments"),
                "result": a.get("evals.tool.result"),
            }
        )
    return calls


def gather_sources(
    calls: list[dict[str, Any]],
    transcript: list[dict[str, Any]],
    client_files: dict[str, str],
) -> list[Source]:
    sources = []
    for call in calls:
        if call["result"]:
            sources.append(
                Source(
                    "tool",
                    call["name"],
                    call["turn"],
                    source_numbers(str(call["result"])),
                    call=call["index"],
                    arithmetic=call["name"] in ARITHMETIC_TOOLS,
                    rates=source_rates(str(call["result"])),
                    error=bool(call["is_error"]),
                )
            )
    for name, text in sorted(client_files.items()):
        sources.append(Source("client", name, -1, source_numbers(text), rates=source_rates(text)))
    agent_turn = 0
    for index, entry in enumerate(transcript):
        if entry.get("source") == "agent":
            agent_turn += 1
            continue
        if entry.get("role") == "user":
            where = f"{entry.get('source') or 'user'}:{index}"
            text = entry["content"]
            numbers, rates = source_numbers(text), source_rates(text)
            sources.append(Source("user", where, agent_turn, numbers, rates=rates))
    return sources


Best = tuple[int, int, Decimal, Source, Decimal]  # rank, source order, step, source, number


def _best(amount: Amount, sources: list[Source], usable: Callable[[Source], bool]) -> Best | None:
    """The source number that best explains `amount` among the sources `usable` accepts: the
    best match rank (exact, rounded, truncated, trailing zeros), then tool, client, user, then
    the first in source order."""
    best: Best | None = None
    for source in sources:
        if not usable(source):
            continue
        order = SOURCES.index(source.kind)
        for number in source.numbers:
            ranked = _match_rank(amount, number)
            if ranked is None:
                continue
            if best is None or (ranked[0], order) < (best[0], best[1]):
                best = (ranked[0], order, ranked[1], source, number)
    return best


def _match(best: Best) -> dict[str, Any]:
    """checks.json's `match` for a best match; `call` names the tool call a tool match is from."""
    rank, _, step, source, number = best
    out: dict[str, Any] = {
        "value": _number(number),
        "where": f"{source.kind}:{source.where}" if source.kind != "user" else source.where,
        "how": HOW[rank],
        "precision": _number(step),
    }
    if source.call is not None:
        out["call"] = source.call
    return out


def _figure(value: Decimal) -> str:
    """A number for a sentence, grouped as the finance tools group money: 23,120, 4,41,050,
    17.8, -500."""
    if not value.is_finite():
        return str(value)
    whole, dot, frac = format(abs(value), "f").partition(".")
    if len(whole) > 3:
        head, groups = whole[:-3], [whole[-3:]]
        while head:
            groups.insert(0, head[-2:])
            head = head[:-2]
        whole = ",".join(groups)
    return ("-" if value < 0 else "") + whole + dot + frac


def _walk_figures(value: Any, path: str, out: list[tuple[str, Decimal]]) -> None:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, Decimal):
        out.append((path, value))
    elif isinstance(value, str):  # a number sent as a string, which the server coerces
        try:
            out.append((path, Decimal(value.strip())))
        except InvalidOperation:
            return
    elif isinstance(value, list):
        for i, item in enumerate(value):
            _walk_figures(item, f"{path}[{i}]", out)
    elif isinstance(value, dict):
        for key, item in value.items():
            _walk_figures(item, f"{path}.{key}", out)


def call_inputs(call: dict[str, Any]) -> tuple[list[tuple[str, Decimal]], str | None]:
    """The figures an arithmetic call was given, as (argument, number) in argument order, or
    ([], why not) when its arguments are not in the trace or are not a JSON object. Numbers keep
    the digits they were written with, so an input is matched at its own precision. Arguments in
    NOT_FIGURES (round's `places`) are left out."""
    raw = call.get("arguments")
    if not isinstance(raw, str) or not raw.strip():
        return [], "arguments are not in the trace"
    try:
        args = json.loads(raw, parse_float=Decimal, parse_int=Decimal, parse_constant=Decimal)
    except ValueError:  # also a JSON object cut at the trace's string limit
        return [], "arguments could not be read"
    if not isinstance(args, dict):
        return [], "arguments could not be read"
    skip = NOT_FIGURES.get(call["name"], frozenset())
    out: list[tuple[str, Decimal]] = []
    for key, value in args.items():
        if key not in skip:
            _walk_figures(value, str(key), out)
    return out, None


def _input_amount(number: Decimal) -> Amount | None:
    """An input as if it were an amount written in rupees with the digits it was given with, so
    it is matched by the same rule as an amount in a reply. None for NaN or an infinity, which
    nothing supports."""
    if not number.is_finite():
        return None
    exponent = number.as_tuple().exponent
    decimals = max(0, -exponent) if isinstance(exponent, int) else 0
    return Amount(str(number), abs(number), 1, decimals)


def _listing(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def is_unit_fact(number: Decimal) -> bool:
    """D58: whether an arithmetic input is a unit fact (UNIT_FACTS), which needs no source."""
    return number.is_finite() and abs(number) in UNIT_FACTS


def percentages(text: str) -> set[Decimal]:
    """D61: the percentages written in a reply ("7.4%", "12 per cent"), which are free factors."""
    out: set[Decimal] = set()
    for m in PERCENT_TEXT.finditer(text or ""):
        try:
            out.add(Decimal(m.group(1)))
        except InvalidOperation:
            continue
    return out


def _walk_rates(value: Any, key: str, out: list[Decimal]) -> None:
    if isinstance(value, dict):
        unit = value.get("unit")
        for k, item in value.items():
            percent_value = k == "value" and isinstance(unit, str) and unit.startswith("percent")
            _walk_rates(item, "pct" if percent_value else str(k), out)
    elif isinstance(value, list):
        for item in value:
            _walk_rates(item, key, out)
    elif isinstance(value, Decimal) and RATE_WORDS & set(re.split(r"[_\W]+", key.lower())):
        out.append(abs(value))


def source_rates(text: str) -> list[Decimal]:
    """D61: the rates and percentages in a source, which a derivation in prose may take a
    percentage at: numbers written with % (or "per cent"), and, in a JSON source, numbers under
    a key that names a rate or a percentage (annual_rate_pct, inflation) or a `value` whose
    `unit` is a percent (reference_rates)."""
    out = sorted(percentages(text))
    try:
        data = json.loads(text, parse_float=Decimal, parse_int=Decimal)
    except (ValueError, TypeError):
        return out
    found: list[Decimal] = []
    _walk_rates(data, "", found)
    return out + found


def written_counts(text: str) -> set[Decimal]:
    """D61: the counts written in a reply, which a derivation in prose may multiply or divide by:
    a whole number from 2 to WRITTEN_COUNT_MAX, in digits or as a word from two to twelve,
    written right before what it counts ("3 months", "24 EMIs", "two people")."""
    out: set[Decimal] = set()
    for m in COUNT_TEXT.finditer(text or ""):
        if CURRENCY_BEFORE.search(text[max(0, m.start() - 6) : m.start()]):
            continue  # money, not a count: "₹40 a day"
        word = m.group("n").lower()
        n = NUMBER_WORDS.get(word) or Decimal(word)
        if 2 <= n <= WRITTEN_COUNT_MAX:
            out.add(n)
    return out


def is_free_factor(number: Decimal, percents: set[Decimal]) -> bool:
    """D61: a number that needs no source: a unit fact, a whole number from 1 to COUNT_MAX, or a
    percentage the agent wrote in its replies."""
    if not number.is_finite():
        return False
    n = abs(number)
    whole = n == n.to_integral_value()
    return n in UNIT_FACTS or (whole and 1 <= n <= COUNT_MAX) or n in percents


def _window(amount: Amount, coarse: bool) -> tuple[Decimal, Decimal]:
    """Every value that can match `amount` lies in this range, in rupees (a superset: the match
    rank decides). Rounded half-up or truncated to the digits shown, or within 1% when trailing
    zeros may be rounding."""
    step = Decimal(1).scaleb(-amount.decimals)
    shown = abs(amount.shown)
    lo, hi = shown - step / 2, shown + step
    if coarse and amount.decimals == 0 and shown != 0:
        lo, hi = min(lo, shown * (1 - COARSE_TOLERANCE)), max(hi, shown * (1 + COARSE_TOLERANCE))
    return max(lo, Decimal(0)) * amount.unit, hi * amount.unit


def _ranker(amount: Amount, coarse: bool) -> Callable[[Decimal], int | None]:
    def rank(value: Decimal) -> int | None:
        ranked = _match_rank(amount, value)
        if ranked is None or (ranked[0] == 3 and not coarse):
            return None
        return ranked[0]

    return rank


def _where(source: Source) -> str:
    return f"{source.kind}:{source.where}" if source.kind != "user" else source.where


def _pools(
    sources: list[Source],
    usable: Callable[[Source], bool],
    written: list[tuple[Decimal, str]],
    counts: list[tuple[Decimal, str]],
    percents: list[tuple[Decimal, str]],
) -> Pools:
    """The pools for a derivation in prose (A44): the figures verified in the answer so far
    (`written`, with where they were written); the amounts (those, and every sourced number of
    AMOUNT_MIN or more in the usable sources); the multipliers (12, and the counts written in the
    replies); and the percents (those written in the replies, and the usable sources' rates).
    Sources are offered tool first, then client, then user, so a value is labelled with the
    best place it was found."""
    ordered = sorted((s for s in sources if usable(s)), key=lambda s: SOURCES.index(s.kind))
    mine = [Operand(abs(v), where) for v, where in written]
    sourced = [Operand(abs(n), _where(s)) for s in ordered for n in s.numbers]
    rates = [Operand(r, _where(s)) for s in ordered for r in s.rates]
    return Pools(
        written=Pool(mine),
        amounts=Pool([*mine, *(o for o in sourced if o.value >= AMOUNT_MIN)]),
        multipliers=Pool(
            [Operand(Decimal(12), "unit fact"), *(Operand(abs(v), w) for v, w in counts)]
        ),
        percents=Pool([*(Operand(abs(v), w) for v, w in percents), *rates]),
    )


def _derivation(d: Derivation) -> dict[str, Any]:
    """checks.json's `derivation` for a figure or an input verified as a derivation (D61)."""
    return {
        "op": d.op,
        "operands": [{"value": _number(o.value), "where": o.where} for o in d.operands],
        "value": _number(d.value),
        "how": HOW[d.rank],
    }


def _derive(amount: Amount, pools: Pools) -> Derivation | None:
    return find(_window(amount, DERIVE_COARSE), _ranker(amount, DERIVE_COARSE), pools)


def _repeated_input(
    result: list[Decimal], unsourced: list[Decimal]
) -> tuple[Decimal, Decimal] | None:
    """D58's identity guard: the first (result number, input) where a number in the call's
    result is one of its inputs that has no source, by the amounts' rule with the result as the
    amount (at the digits it was returned with) and the input as the number it may come from:
    23,120.00 repeats 23120, and round's 23000 repeats 23,120.456. None when no result number
    repeats one."""
    for number in result:
        amount = _input_amount(number)
        if amount is None:
            continue
        for value in unsourced:
            if value.is_finite() and _match_rank(amount, value) is not None:
                return number, value
    return None


def _replies(transcript: list[dict[str, Any]]) -> list[tuple[int, str]]:
    """The agent's replies as (turn, text), turns from 0."""
    out = []
    for entry in transcript:
        if entry.get("source") == "agent":
            out.append((len(out), entry.get("content") or ""))
    return out


def _percents_by_turn(replies: list[tuple[int, str]]) -> dict[int, set[Decimal]]:
    """The percentages written in the replies up to and including each turn; -1 has them all."""
    out: dict[int, set[Decimal]] = {}
    seen: set[Decimal] = set()
    for turn, text in replies:
        seen = seen | percentages(text)
        out[turn] = seen
    out[-1] = seen
    return out


def trace_arithmetic(
    calls: list[dict[str, Any]],
    sources: list[Source],
    replies: list[tuple[int, str]] = (),  # type: ignore[assignment]
) -> tuple[list[dict[str, Any]], set[int]]:
    """D61 (A44): each arithmetic call, in start order, and whether its result counts as a
    source. Each number it was given is sourced (it matches a non-arithmetic tool result or a
    counted arithmetic result from an earlier call, the client file, or a user message up to the
    call's turn; or it is a one-step derivation of those), a free factor (a unit fact, a whole
    number from 1 to COUNT_MAX, or a percentage written in the replies up to the call's turn), or
    unsupported. The result counts when the call returned no error and was given numbers, none
    unsupported; add, subtract, percent_change and round had a source for every input; at least
    one input is a sourced amount (100 or more); and no number in the result only repeats an
    input with no source (D58's identity guard). Returns the calls' records, as checks.json's
    `arithmetic`, and the positions of the counted calls."""
    accepted: set[int] = set()
    records: list[dict[str, Any]] = []
    percents_by_turn = _percents_by_turn(list(replies))
    for call in calls:
        name, index, turn = call["name"], call["index"], call["turn"]
        if name not in ARITHMETIC_TOOLS:
            continue

        def before(s: Source, index: int = index) -> bool:
            return s.kind == "tool" and s.call is not None and s.call < index

        def supports(s: Source, index: int = index, turn: int = turn) -> bool:
            if s.kind == "tool":
                return before(s, index) and not s.error and (not s.arithmetic or s.call in accepted)
            return s.kind == "client" or turn == -1 or s.turn <= turn

        def unaccepted(s: Source, index: int = index) -> bool:
            return before(s, index) and s.arithmetic and s.call not in accepted

        percents = percents_by_turn.get(turn, percents_by_turn.get(-1, set()))
        figures, unreadable = call_inputs(call)
        inputs, missing, unsourced, unfree, amounts = [], [], [], [], []
        for arg, number in figures:
            amount = _input_amount(number)
            best = _best(amount, sources, supports) if amount else None
            if best:
                kind = best[3].kind
            elif amount and is_unit_fact(number):
                kind = "unit"
            elif amount and is_free_factor(number, percents):
                kind = "free"
            else:
                kind = None
            inputs.append(
                {
                    "arg": arg,
                    "value": _number(number) if amount else None,
                    "supported_by": kind,
                    "match": _match(best) if best else None,
                }
            )
            if kind in SOURCED:
                if abs(number) >= AMOUNT_MIN:
                    amounts.append(number)
            else:
                unsourced.append(number)
                if kind is not None:
                    unfree.append(_figure(number))
            if kind is None:
                via = _best(amount, sources, unaccepted) if amount else None
                note = f" ({via[3].where}'s result, itself unsupported)" if via else ""
                missing.append(_figure(number) + note)
        result = source_numbers(str(call["result"])) if call["result"] else []
        repeated = _repeated_input(result, unsourced)
        if call["is_error"]:
            reason = f"{name} returned an error"
        elif unreadable:
            reason = f"{name}'s {unreadable}"
        elif not figures:
            reason = f"{name} was given no numbers"
        elif missing:
            one = len(missing) == 1
            reason = (
                f"{name}'s {'input' if one else 'inputs'} {_listing(missing)}"
                f" {'is' if one else 'are'} not supported"
            )
        elif name in EVERY_INPUT_SOURCED and unfree:
            one = len(unfree) == 1
            reason = (
                f"{name}'s {'input' if one else 'inputs'} {_listing(unfree)}"
                f" {'has' if one else 'have'} no source ({name} needs a source for every input)"
            )
        elif not amounts:
            reason = f"{name} was given no sourced amount (a sourced number of 100 or more)"
        elif repeated:
            reason = (
                f"{name}'s result {_figure(repeated[0])} only repeats its input"
                f" {_figure(repeated[1])}, which has no source"
            )
        else:
            reason = None
            accepted.add(index)
        records.append(
            {
                "call": index,
                "tool": name,
                "turn": turn,
                "supported": reason is None,
                "inputs": inputs,
                "reason": reason,
            }
        )
    return records, accepted


def _run_sum(
    index: int, amounts: list[Amount], done: dict[int, dict[str, Any]], turn: int
) -> Derivation | None:
    """A run of RUN_MIN to RUN_MAX verified figures written one after another, just before or
    just after figure `index` in the same reply, that adds up to it."""
    amount = amounts[index]
    rank = _ranker(amount, DERIVE_COARSE)
    runs = []
    for k in range(RUN_MIN, RUN_MAX + 1):
        runs.append(range(index - k, index))
        runs.append(range(index + 1, index + 1 + k))
    best: Derivation | None = None
    for run in runs:
        if run.start < 0 or run.stop > len(amounts) or not all(i in done for i in run):
            continue
        parts = [amounts[i].value for i in run]
        r = rank(sum(parts, Decimal(0)))
        if r is not None and (best is None or r < best.rank):
            operands = tuple(Operand(abs(v), f"answer:{turn}") for v in parts)
            best = Derivation("sum", operands, sum(parts, Decimal(0)), r)
    return best


def provenance(
    transcript: list[dict[str, Any]],
    sources: list[Source],
    arithmetic: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """D61 (A44): one row per money amount in the agent's replies, verified one of three ways:
    `source` (it matches a number in a source the agent had by the reply: a non-arithmetic tool
    result, the client file, a user, client or task message), `tool` (it matches the result of
    an arithmetic call that counts) or `derived_in_prose` (the checker recomputes it as a
    one-step derivation with at least one sourced amount, from those sources and the figures
    already verified in the replies; or as the sum of a run of verified figures next to it; or
    it repeats a figure derived earlier). Else unsupported; an amount whose only match is an
    arithmetic result that does not count names it in `rejected`, with the reason."""
    records = {r["call"]: r for r in arithmetic or []}

    def counts(source: Source) -> bool:
        if source.error:
            return False
        return not source.arithmetic or bool(records.get(source.call, {}).get("supported"))

    answer: list[tuple[Decimal, str]] = []  # verified figures: (value, where written)
    derived: list[tuple[Amount, str]] = []  # figures verified as derived, for repeats
    tallies: list[tuple[Decimal, str]] = []  # counts written in the replies so far
    stated: list[tuple[Decimal, str]] = []  # percentages written in the replies so far
    rows: list[dict[str, Any]] = []
    for turn, text in _replies(transcript):
        tallies += [(n, f"answer:{turn}") for n in sorted(written_counts(text))]
        stated += [(p, f"answer:{turn} %") for p in sorted(percentages(text))]

        def readable(s: Source, turn: int = turn) -> bool:
            return s.turn <= turn and counts(s)  # read only after this reply otherwise

        amounts = money_amounts(text)
        done: dict[int, dict[str, Any]] = {}
        for i, amount in enumerate(amounts):
            best = _best(amount, sources, readable)
            if best:
                by = "tool" if best[3].arithmetic else "source"
                done[i] = _row(turn, amount, best[3].kind, _match(best), by, None)
                answer.append((amount.value, f"answer:{turn}"))
        changed = True
        while changed and len(done) < len(amounts):
            changed = False
            pools = _pools(sources, readable, answer, tallies, stated)
            for i, amount in enumerate(amounts):
                if i in done:
                    continue
                found = _derive(amount, pools) or _run_sum(i, amounts, done, turn)
                if found is None:
                    rank = _ranker(amount, DERIVE_COARSE)
                    for earlier, where in derived:
                        r = rank(earlier.value)
                        if r is not None:
                            operand = Operand(abs(earlier.value), where)
                            found = Derivation("repeat", (operand,), earlier.value, r)
                            break
                if found is not None:
                    done[i] = _row(turn, amount, "derived", None, "derived_in_prose", found)
                    answer.append((amount.value, f"answer:{turn}"))
                    derived.append((amount, f"answer:{turn}"))
                    changed = True
        for i, amount in enumerate(amounts):
            if i not in done:
                row = _row(turn, amount, None, None, None, None)
                rejected = _best(amount, sources, lambda s, t=turn: s.turn <= t and not counts(s))
                if rejected is not None:
                    source = rejected[3]
                    reason = records.get(source.call, {}).get("reason") or (
                        f"{source.where} returned an error" if source.error else "not supported"
                    )
                    row["rejected"] = {**_match(rejected), "reason": reason}
                done[i] = row
            rows.append(done[i])
    return rows


def _row(
    turn: int,
    amount: Amount,
    by: str | None,
    match: dict[str, Any] | None,
    verified_by: str | None,
    derivation: Derivation | None,
) -> dict[str, Any]:
    return {
        "turn": turn,
        "text": amount.text,
        "value": _number(amount.value),
        "supported_by": by,
        "match": match,
        "verified_by": verified_by,
        "derivation": _derivation(derivation) if derivation else None,
        "rejected": None,
    }


def required_tools_check(
    required: list[str] | None, calls: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if required is None:
        return None
    names = [tool_name(r) for r in required]
    by_name: dict[str, list[bool]] = {}
    for call in calls:
        by_name.setdefault(call["name"], []).append(call["is_error"])
    called = [n for n in names if n in by_name]
    return {
        "required": names,
        "called": called,
        "missing": [n for n in names if n not in by_name],
        "only_errors": [n for n in called if all(by_name[n])],
    }


def client_files(state_dir: Path) -> dict[str, str]:
    if not state_dir.is_dir():
        return {}
    return {
        p.name: p.read_text(encoding="utf-8", errors="replace")
        for p in sorted(state_dir.iterdir())
        if p.is_file() and p.suffix == ".json"
    }


def run_checks(
    spec: dict[str, Any] | None,
    result: dict[str, Any] | None,
    spans: list[dict[str, Any]],
    files: dict[str, str],
) -> dict[str, Any]:
    """checks.json for one trial, from its spec, result, spans and client files."""
    transcript = ((result or {}).get("conversation") or {}).get("transcript") or []
    calls = tool_calls(spans)
    sources = gather_sources(calls, transcript, files)
    arithmetic, _ = trace_arithmetic(calls, sources, _replies(transcript))
    rows = provenance(transcript, sources, arithmetic)
    required = ((spec or {}).get("task") or {}).get("required_tools")
    seen: list[str] = []
    for call in calls:
        if call["name"] not in seen:
            seen.append(call["name"])
    trial_id = (result or {}).get("trial_id") or ((spec or {}).get("trial") or {}).get("id")
    return {
        "contract_version": CONTRACT_VERSION,
        "trial_id": trial_id or "unknown",
        "amounts": rows,
        "unsupported": sum(1 for r in rows if r["supported_by"] is None),
        "derived_in_prose": sum(1 for r in rows if r["verified_by"] == "derived_in_prose"),
        "tools_called": seen,
        "required_tools": required_tools_check(required, calls),
        "arithmetic": arithmetic,
    }


def check_trial(paths: TrialPaths, spec: dict[str, Any] | None = None) -> dict[str, Any]:
    """Read a finished trial folder and return its checks (nothing is written)."""
    if spec is None and paths.spec.exists():
        spec = json.loads(paths.spec.read_text(encoding="utf-8"))
    result = None
    if paths.result.exists():
        try:
            result = json.loads(paths.result.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            result = None
    return run_checks(spec, result, read_spans(paths.trace), client_files(paths.state))


def summary(checks: dict[str, Any]) -> str:
    derived = checks.get("derived_in_prose")
    lines = [
        f"{checks['trial_id']}: {checks['unsupported']} unsupported amount(s)"
        + (f", {derived} derived in prose" if derived else "")
    ]
    for row in checks["amounts"]:
        if row["supported_by"] is None:
            rejected = row.get("rejected")
            why = (
                f"{rejected['where']} matched, but {rejected['reason']}"
                if rejected
                else "no tool, client or user number, and no derivation"
            )
            lines.append(f"  turn {row['turn']}: {row['text']} ({why})")
        elif row.get("derivation"):
            d = row["derivation"]
            parts = ", ".join(f"{o['value']} from {o['where']}" for o in d["operands"])
            lines.append(
                f"  turn {row['turn']}: {row['text']} = {d['op']}({parts}) = {d['value']}"
                f" ({d['how']}, derived in prose)"
            )
        else:
            m = row["match"]
            lines.append(
                f"  turn {row['turn']}: {row['text']} = {m['value']} ({m['how']}, {m['where']})"
            )
    for call in checks.get("arithmetic") or []:
        if not call["supported"]:
            lines.append(f"  call {call['call']}: {call['tool']} is not a source: {call['reason']}")
    req = checks["required_tools"]
    if req is not None:
        lines.append(f"  required tools: called {req['called']}, missing {req['missing']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Print a trial folder's platform checks.")
    parser.add_argument("trial_dir", nargs="+", type=Path, help="a trial folder (holds out/)")
    parser.add_argument("--json", action="store_true", help="print checks.json instead")
    args = parser.parse_args(argv)
    for trial_dir in args.trial_dir:
        checks = check_trial(TrialPaths(trial_dir))
        if args.json:
            print(json.dumps(checks, ensure_ascii=False, indent=1))
        else:
            print(summary(checks))


if __name__ == "__main__":
    main(sys.argv[1:])
