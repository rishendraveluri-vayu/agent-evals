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
   matches 1667.50, "₹1.23 lakh" matches 123,456). Trailing zeros in a whole amount may also be
   rounding, as long as two significant digits remain and the number is within 1% of the
   amount ("about ₹49,500" matches 49,483; "₹31,000" does not match 31,330). An amount that
   matches nothing is `unsupported`: a calculation with no tool behind it, to be flagged or at
   least highlighted. This is a heuristic for a reader, not a grade.

   **Arithmetic tools (D56).** The result of an arithmetic tool (`add`, `subtract`, `multiply`,
   `divide`, `percent_of`, `percent_change`, `round`) is a source only when the call returned no
   error and every number it was given is itself supported: by an earlier non-arithmetic tool
   result, an earlier supported arithmetic result, the client file, or a user message the agent
   had by then. Inputs are matched exactly as written amounts are (the same `_match_rank`, at the
   precision the argument is written in), and calls are traced in start order, so a chain (add,
   then subtract on its result, then round) is supported when its first inputs are. A made-up
   figure no longer becomes "supported" by passing through `round(x)` or `add([x, 0])`. Every
   arithmetic call is listed in `arithmetic`, with each input's match and, when the result does
   not count, the reason; an amount whose only match is such a result names it in `rejected`.
   The other tools' results count as before, whatever their inputs.

   **Unit facts and the identity guard (D58).** An input equal to one of UNIT_FACTS (7, 12, 28
   to 31, 52, 100, 365, 366, a lakh and a crore) needs no source, so `multiply([emi, 12])` and
   `divide(annual, 365)` count when the other input does; 0 and 1 are never unit facts. A result
   that only repeats an input with no source never counts, whatever UNIT_FACTS holds: `round(365)`
   or `add([100, 0])` would otherwise turn a constant into a supported figure. "Repeats" is the
   amounts' rule again: the result, at the digits it was returned with, matches the input.

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
from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any

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
        in_range = last_end is not None and RANGE_GAP.match(text[last_end : m.start()])
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


def _match_rank(amount: Amount, source: Decimal) -> tuple[int, Decimal] | None:
    """How well `source` (rupees) explains `amount`: (rank, step in rupees), best rank first:
    0 exact, 1 rounded to the digits shown, 2 cut to them, 3 rounded at trailing zeros."""
    value = abs(source) / amount.unit
    shown = abs(amount.shown)
    step = Decimal(1).scaleb(-amount.decimals)
    try:
        if value == shown:
            return 0, step * amount.unit
        if value.quantize(step, rounding=ROUND_HALF_UP) == shown:
            return 1, step * amount.unit
        if value.quantize(step, rounding=ROUND_DOWN) == shown:
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
                )
            )
    for name, text in sorted(client_files.items()):
        sources.append(Source("client", name, -1, source_numbers(text)))
    agent_turn = 0
    for index, entry in enumerate(transcript):
        if entry.get("source") == "agent":
            agent_turn += 1
            continue
        if entry.get("role") == "user":
            where = f"{entry.get('source') or 'user'}:{index}"
            sources.append(Source("user", where, agent_turn, source_numbers(entry["content"])))
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


def trace_arithmetic(
    calls: list[dict[str, Any]], sources: list[Source]
) -> tuple[list[dict[str, Any]], set[int]]:
    """D56 and D58: each arithmetic call, in start order, and whether its result counts as a
    source. It counts when the call returned no error, was given at least one number, every
    number it was given matches a source the agent could have read by then (a non-arithmetic
    tool result or an accepted arithmetic result from an earlier call, the client file, or a
    user message up to the call's turn; every message, for a call with no turn parent) or is a
    unit fact, and no number in its result only repeats an input that has no source (the
    identity guard). Returns the calls' records, as checks.json's `arithmetic`, and the positions
    of the accepted calls."""
    accepted: set[int] = set()
    records: list[dict[str, Any]] = []
    for call in calls:
        name, index, turn = call["name"], call["index"], call["turn"]
        if name not in ARITHMETIC_TOOLS:
            continue

        def before(s: Source, index: int = index) -> bool:
            return s.kind == "tool" and s.call is not None and s.call < index

        def supports(s: Source, index: int = index, turn: int = turn) -> bool:
            if s.kind == "tool":
                return before(s, index) and (not s.arithmetic or s.call in accepted)
            return s.kind == "client" or turn == -1 or s.turn <= turn

        def unaccepted(s: Source, index: int = index) -> bool:
            return before(s, index) and s.arithmetic and s.call not in accepted

        figures, unreadable = call_inputs(call)
        inputs, missing, unsourced = [], [], []
        for arg, number in figures:
            amount = _input_amount(number)
            best = _best(amount, sources, supports) if amount else None
            unit = best is None and is_unit_fact(number)
            inputs.append(
                {
                    "arg": arg,
                    "value": _number(number) if amount else None,
                    "supported_by": best[3].kind if best else ("unit" if unit else None),
                    "match": _match(best) if best else None,
                }
            )
            if best is None:
                unsourced.append(number)
            if best is None and not unit:
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


def provenance(
    transcript: list[dict[str, Any]],
    sources: list[Source],
    arithmetic: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """One row per money amount in the agent's replies, with its best match or none. An
    arithmetic result counts only when `arithmetic` (trace_arithmetic's records) accepts its
    call; an amount whose only matches are results that do not count names the best in
    `rejected`, with the reason."""
    records = {r["call"]: r for r in arithmetic or []}

    def counts(source: Source) -> bool:
        return not source.arithmetic or bool(records.get(source.call, {}).get("supported"))

    rows = []
    agent_turn = -1
    for entry in transcript:
        if entry.get("source") != "agent":
            continue
        agent_turn += 1
        for amount in money_amounts(entry.get("content") or ""):

            def readable(s: Source, turn: int = agent_turn) -> bool:
                return s.turn <= turn  # read only after this reply was written otherwise

            best = _best(amount, sources, lambda s: readable(s) and counts(s))
            row: dict[str, Any] = {
                "turn": agent_turn,
                "text": amount.text,
                "value": _number(amount.value),
                "supported_by": best[3].kind if best else None,
                "match": _match(best) if best else None,
                "rejected": None,
            }
            if best is None:
                rejected = _best(amount, sources, lambda s: readable(s) and not counts(s))
                if rejected is not None:
                    reason = records.get(rejected[3].call, {}).get("reason") or "not supported"
                    row["rejected"] = {**_match(rejected), "reason": reason}
            rows.append(row)
    return rows


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
    arithmetic, _ = trace_arithmetic(calls, sources)
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
    lines = [f"{checks['trial_id']}: {checks['unsupported']} unsupported amount(s)"]
    for row in checks["amounts"]:
        if row["supported_by"] is None:
            rejected = row.get("rejected")
            why = (
                f"{rejected['where']} matched, but {rejected['reason']}"
                if rejected
                else "no tool, client or user number"
            )
            lines.append(f"  turn {row['turn']}: {row['text']} ({why})")
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
