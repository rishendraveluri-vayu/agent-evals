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
RANGE_GAP = re.compile(r"^[ \t]*(?:–|—|-|to)[ \t]*$", re.IGNORECASE)
WESTERN = re.compile(r"^\d{1,3}(?:,\d{3})+$")
INDIAN = re.compile(r"^\d{1,2}(?:,\d{2})*,\d{3}$")
INDIAN_LAKH_PLUS = re.compile(r"^\d{1,2}(?:,\d{2})+,\d{3}$")  # 1,00,000 and up
MCP_PREFIX = re.compile(r"^mcp__.+?__")
COARSE_TOLERANCE = Decimal("0.01")


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
    split the numbers."""
    out: list[Decimal] = []
    for m in TOKEN.finditer(DATE.sub(" ", text)):
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
    """The execute_tool spans as {name, turn, is_error, result}, in start order. `turn` is the
    agent turn the call belongs to, or -1 when the span has no turn parent."""
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
                "name": tool_name(str(raw)),
                "turn": int(turn) if turn is not None else -1,
                "is_error": bool(a.get("evals.tool.is_error")),
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
                Source("tool", call["name"], call["turn"], source_numbers(str(call["result"])))
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


def provenance(transcript: list[dict[str, Any]], sources: list[Source]) -> list[dict[str, Any]]:
    """One row per money amount in the agent's replies, with its best match or none."""
    rows = []
    agent_turn = -1
    for entry in transcript:
        if entry.get("source") != "agent":
            continue
        agent_turn += 1
        for amount in money_amounts(entry.get("content") or ""):
            best: tuple[int, int, Decimal, Source, Decimal] | None = None
            for source in sources:
                if source.turn > agent_turn:
                    continue  # read only after this reply was written
                order = SOURCES.index(source.kind)
                for number in source.numbers:
                    ranked = _match_rank(amount, number)
                    if ranked is None:
                        continue
                    key = (ranked[0], order)
                    if best is None or key < (best[0], best[1]):
                        best = (ranked[0], order, ranked[1], source, number)
            row: dict[str, Any] = {
                "turn": agent_turn,
                "text": amount.text,
                "value": _number(amount.value),
                "supported_by": None,
                "match": None,
            }
            if best is not None:
                rank, _, step, source, number = best
                row["supported_by"] = source.kind
                row["match"] = {
                    "value": _number(number),
                    "where": f"{source.kind}:{source.where}"
                    if source.kind != "user"
                    else source.where,
                    "how": HOW[rank],
                    "precision": _number(step),
                }
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
    rows = provenance(transcript, gather_sources(calls, transcript, files))
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
            lines.append(f"  turn {row['turn']}: {row['text']} (no tool, client or user number)")
        else:
            m = row["match"]
            lines.append(
                f"  turn {row['turn']}: {row['text']} = {m['value']} ({m['how']}, {m['where']})"
            )
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
