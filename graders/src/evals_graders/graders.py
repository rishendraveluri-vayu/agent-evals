"""The grader types, and grading one trial with a task's graders.

Every grader returns a grade:

    {grader_id, type, required, verdict, score, reason, evidence, grader_version, spec_sha256}

`verdict` is pass, fail, not_applicable (nothing to check, e.g. no checks.json), error (the
grader could not run: a bad spec, a missing file, a unit test that crashed or timed out) or
not_implemented (the reserved judge). `score` is 0..1, or null when there is no verdict on the
agent. `evidence` items are {source, quote?, span_id?, ...}; a quote is always a verbatim
substring of the text named by `source`, so a reader can find exactly what the grade relied on.
Sources: final_answer, agent_message (with its transcript `index`), span (a tool call's
arguments), tool_result, result (a result.json field) and checks.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from evals_graders import FRAMEWORK_VERSION
from evals_graders.amounts import context, find, fmt_inr, within
from evals_graders.spec import Prepared, prepare
from evals_graders.trial import ToolCall, TrialView, normalise_tool_name

DEFAULT_NUMBER_TOLERANCE = {"abs": 1.0}
DEFAULT_ARGS_TOLERANCE = {"abs": 1e-6}
VERDICTS = ("pass", "fail", "not_applicable", "error", "not_implemented")


class Context:
    """What one grading run shares: the trial, the task folder (for unit_test files)."""

    def __init__(self, trial: TrialView, task_dir: Path | None) -> None:
        self.trial = trial
        self.task_dir = task_dir
        self._calls: list[ToolCall] | None = None

    @property
    def calls(self) -> list[ToolCall]:
        if self._calls is None:
            self._calls = self.trial.tool_calls()
        return self._calls


def _n(value: float) -> str:
    return format(value, ".15g")


def _tol(tolerance: dict[str, float]) -> str:
    parts = []
    if "abs" in tolerance:
        parts.append(f"±{_n(float(tolerance['abs']))}")
    if "rel" in tolerance:
        parts.append(f"±{_n(float(tolerance['rel']) * 100)}%")
    return " or ".join(parts) or "±0"


def _grade(
    verdict: str,
    reason: str,
    evidence: list[dict[str, Any]] | None = None,
    score: float | None = None,
) -> dict[str, Any]:
    if score is None and verdict in ("pass", "fail"):
        score = 1.0 if verdict == "pass" else 0.0
    return {"verdict": verdict, "score": score, "reason": reason, "evidence": evidence or []}


# ---- targets --------------------------------------------------------------------------------


def _texts(ctx: Context, target: str) -> list[tuple[str, dict[str, Any]]] | None:
    """(text, evidence source fields) for each piece of the target, or None when there is none."""
    trial = ctx.trial
    if target == "final_answer":
        final = trial.final_answer
        return None if final is None else [(final, {"source": "final_answer"})]
    pieces: list[tuple[str, dict[str, Any]]] = []
    for m in trial.agent_messages():
        src = (
            {"source": "final_answer"}
            if m.is_final
            else {"source": "agent_message", "index": m.index}
        )
        pieces.append((m.text, src))
    if target == "all_agent_text":
        for c in ctx.calls:
            if c.arguments_text:
                pieces.append(
                    (c.arguments_text, {"source": "span", "span_id": c.span_id, "tool": c.name})
                )
    return pieces or None


def _quote(text: str, start: int, end: int, src: dict[str, Any]) -> dict[str, Any]:
    return {**src, "quote": context(text, start, end)}


# ---- number ---------------------------------------------------------------------------------


def _path(value: Any, path: str) -> tuple[bool, Any]:
    """`debts[0].interest_paid` or `debts.0.interest_paid` into parsed JSON."""
    parts = [p for p in re.split(r"\.|\[(\d+)\]", path) if p]
    for part in parts:
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            return False, None
    return True, value


def _leaf_quote(call: ToolCall, field: str, value: float) -> str | None:
    """The `"key":value` text in the tool's own output, verbatim."""
    if not call.result_text:
        return None
    leaf = re.split(r"\.|\[\d+\]", field.rstrip("]"))[-1] or field
    pattern = re.compile(r'"' + re.escape(leaf) + r'"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)')
    for m in pattern.finditer(call.result_text):
        try:
            if float(m.group(1)) == value:
                return m.group(0)
        except ValueError:
            continue
    return None


def _expected_values(
    ctx: Context, expected: Any
) -> tuple[list[tuple[float, dict[str, Any] | None]], str | None]:
    """[(value, tool evidence)], or ([], why there is no expected value)."""
    if isinstance(expected, int | float):
        return [(float(expected), None)], None
    tool = normalise_tool_name(expected["from_tool"])
    field = expected["field"]
    calls = [c for c in ctx.calls if c.name == tool]
    if not calls:
        called = sorted({c.name for c in ctx.calls}) or ["none"]
        return (
            [],
            f"{tool} was never called, so there is no tool value to compare"
            f" (tools called: {', '.join(called)})",
        )
    which = expected.get("call", "any")
    if which == "first":
        calls = calls[:1]
    elif which == "last":
        calls = calls[-1:]
    values: list[tuple[float, dict[str, Any] | None]] = []
    misses: list[str] = []
    for c in calls:
        if c.result is None:
            misses.append(
                f"span {c.span_id}: the result is not JSON"
                + (" (cut short in the trace)" if c.truncated else "")
            )
            continue
        ok, value = _path(c.result, field)
        if not ok or isinstance(value, bool) or not isinstance(value, int | float):
            misses.append(f"span {c.span_id}: no number at {field!r}")
            continue
        ev = {"source": "tool_result", "span_id": c.span_id, "tool": c.name, "field": field}
        quote = _leaf_quote(c, field, float(value))
        if quote:
            ev["quote"] = quote
        values.append((float(value), ev))
    if not values:
        return [], f"no usable {tool} result: " + "; ".join(misses)
    return values, None


def grade_number(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    expected, why = _expected_values(ctx, spec["expected"])
    if not expected:
        return _grade("fail", why or "no expected value")
    tolerance = spec.get("tolerance", DEFAULT_NUMBER_TOLERANCE)
    pieces = _texts(ctx, spec.get("target", "final_answer"))
    if not pieces:
        return _grade("fail", "the agent gave no final answer to find a number in")
    match = spec.get("match", "amount")
    best: tuple[float, str, float] | None = None  # (distance, found text, expected)
    for value, tool_ev in expected:
        for text, src in pieces:
            for f in find(text, match):
                if within(f.value, value, tolerance):
                    ev = [_quote(text, f.start, f.end, src)]
                    if tool_ev:
                        ev.append(tool_ev)
                    origin = f" ({tool_ev['tool']} {tool_ev['field']})" if tool_ev else ""
                    return _grade(
                        "pass",
                        f"found {f.text}, within {_tol(tolerance)} of {_n(value)}{origin}",
                        ev,
                    )
                d = abs(f.value - value)
                if best is None or d < best[0]:
                    best = (d, f.text, value)
    kind = "rupee amount" if match == "amount" else "number"
    shown = ", ".join(fmt_inr(v) if match == "amount" else _n(v) for v, _ in expected)
    tool_ev_list = [ev for _, ev in expected if ev]
    if best is None:
        return _grade(
            "fail",
            f"no {kind} in the {spec.get('target', 'final_answer')} (expected {shown})",
            tool_ev_list,
        )
    return _grade(
        "fail",
        f"no {kind} within {_tol(tolerance)} of {shown}; the closest is {best[1]},"
        f" {_n(round(best[0], 6))} away from {_n(best[2])}",
        tool_ev_list,
    )


# ---- tool calls -----------------------------------------------------------------------------


def _number(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int | float):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace(",", "").strip())
        except ValueError:
            return None
    return None


def args_match(expected: Any, actual: Any, tolerance: dict[str, float]) -> bool:
    """`expected` is a subset of `actual`: numbers within tolerance, strings equal ignoring case
    and surrounding spaces, lists item by item, objects key by key (extra keys allowed)."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            k in actual and args_match(v, actual[k], tolerance) for k, v in expected.items()
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(args_match(e, a, tolerance) for e, a in zip(expected, actual, strict=True))
        )
    if expected is None:
        return actual is None
    if isinstance(expected, bool):
        return isinstance(actual, bool) and actual == expected
    if isinstance(expected, int | float):
        got = _number(actual)
        return got is not None and within(got, float(expected), tolerance)
    if isinstance(expected, str):
        return isinstance(actual, str) and actual.strip().casefold() == expected.strip().casefold()
    return expected == actual


def _call_ev(c: ToolCall) -> dict[str, Any]:
    return {"source": "span", "span_id": c.span_id, "tool": c.name, "quote": c.arguments_text[:500]}


def grade_tool_called(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    tool = normalise_tool_name(spec["tool"])
    calls = [c for c in ctx.calls if c.name == tool]
    if spec.get("successful"):
        calls = [c for c in calls if not c.is_error]
    tolerance = spec.get("tolerance", DEFAULT_ARGS_TOLERANCE)
    args = spec.get("args")
    matching = [c for c in calls if args is None or args_match(args, c.arguments, tolerance)]
    need = spec.get("min_calls", 1)
    cap = spec.get("max_calls")
    with_args = f" with {args}" if args is not None else ""
    if len(matching) < need:
        others = sorted({c.name for c in ctx.calls}) or ["none"]
        if calls and args is not None:
            reason = (
                f"{tool} was called {len(calls)} time(s), but {len(matching)} matched"
                f"{with_args} (need {need})"
            )
        else:
            reason = (
                f"{tool} was called {len(matching)} time(s){with_args}, need at least {need}"
                f" (tools called: {', '.join(others)})"
            )
        return _grade("fail", reason, [_call_ev(c) for c in calls])
    if cap is not None and len(calls) > cap:
        return _grade(
            "fail",
            f"{tool} was called {len(calls)} times, more than the {cap} allowed",
            [_call_ev(c) for c in calls],
        )
    return _grade(
        "pass",
        f"{tool} was called {len(matching)} time(s){with_args}",
        [_call_ev(c) for c in matching],
    )


def grade_tool_not_called(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    tool = normalise_tool_name(spec["tool"])
    args = spec.get("args")
    tolerance = spec.get("tolerance", DEFAULT_ARGS_TOLERANCE)
    calls = [
        c
        for c in ctx.calls
        if c.name == tool and (args is None or args_match(args, c.arguments, tolerance))
    ]
    with_args = f" with {args}" if args is not None else ""
    if calls:
        return _grade(
            "fail",
            f"{tool} was called {len(calls)} time(s){with_args}",
            [_call_ev(c) for c in calls],
        )
    return _grade(
        "pass", f"{tool} was not called{with_args} ({len(ctx.calls)} tool call(s) in the trace)"
    )


# ---- regex ----------------------------------------------------------------------------------


def _regex(spec: dict[str, Any]) -> re.Pattern[str]:
    flags = 0 if spec.get("case_sensitive") else re.IGNORECASE
    return re.compile(spec["pattern"], flags | re.MULTILINE)


def grade_regex_present(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    target = spec.get("target", "final_answer")
    pieces = _texts(ctx, target)
    if not pieces:
        return _grade("fail", f"there is no {target} to search")
    rx = _regex(spec)
    for text, src in pieces:
        m = rx.search(text)
        if m:
            return _grade(
                "pass",
                f"/{spec['pattern']}/ matched {m.group(0)!r}",
                [_quote(text, m.start(), m.end(), src)],
            )
    return _grade("fail", f"/{spec['pattern']}/ is not in the {target}")


def grade_regex_absent(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    target = spec.get("target", "final_answer")
    pieces = _texts(ctx, target)
    if not pieces:
        return _grade("not_applicable", f"there is no {target} to search")
    rx = _regex(spec)
    hits = []
    for text, src in pieces:
        for m in rx.finditer(text):
            hits.append(_quote(text, m.start(), m.end(), src))
            if len(hits) >= 5:
                break
    if hits:
        return _grade(
            "fail", f"/{spec['pattern']}/ matched {len(hits)} time(s) in the {target}", hits
        )
    return _grade("pass", f"/{spec['pattern']}/ is not in the {target}")


# ---- end state, provenance ------------------------------------------------------------------


def grade_end_state(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    state = ctx.trial.end_state
    if state is None:
        return _grade(
            "error",
            "the trial has no end state"
            " (result.json and runner-report.json are missing or unreadable)",
        )
    ev = [{"source": "result", "field": "end_state", "quote": state}]
    detail = ((ctx.trial.result or {}).get("end_detail") or {}).get("harness_stop_reason")
    if isinstance(detail, str) and detail:
        ev.append(
            {"source": "result", "field": "end_detail.harness_stop_reason", "quote": detail[:300]}
        )
    if state in spec["states"]:
        return _grade("pass", f"ended {state}", ev)
    return _grade("fail", f"ended {state}, not {' or '.join(spec['states'])}", ev)


PROVENANCE_KEYS = ("number_provenance", "provenance")


def _provenance_node(checks: dict[str, Any]) -> dict[str, Any] | None:
    for key in PROVENANCE_KEYS:
        if isinstance(checks.get(key), dict):
            return checks[key]
    items = checks.get("checks")
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and any(
                item.get(k) in PROVENANCE_KEYS for k in ("id", "name", "type", "check")
            ):
                return item
    return None


def _item_quote(item: Any) -> str:
    if isinstance(item, dict):
        for k in ("text", "quote", "raw", "match", "amount_text"):
            if isinstance(item.get(k), str):
                return item[k]
        for k in ("amount", "value"):
            if k in item:
                return str(item[k])
        return str(item)[:200]
    return str(item)


def grade_provenance(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    trial = ctx.trial
    if not trial.checks_present:
        return _grade(
            "not_applicable", "the trial has no checks.json, so number provenance was not checked"
        )
    if trial.checks is None:
        return _grade("error", "checks.json is not a JSON object")
    node = _provenance_node(trial.checks)
    if node is None:
        return _grade("error", f"checks.json has no {' or '.join(PROVENANCE_KEYS)} entry")
    items = node.get("unsupported")
    if isinstance(items, list):
        count = len(items)
    elif isinstance(node.get("unsupported_count"), int):
        count, items = node["unsupported_count"], []
    else:
        return _grade(
            "error", "the provenance entry has neither an unsupported list nor an unsupported_count"
        )
    cap = spec.get("max_unsupported", 0)
    ev = [{"source": "checks", "quote": _item_quote(i)} for i in items[:20]]
    total = node.get("total") if isinstance(node.get("total"), int) else node.get("amounts")
    of = f" of {total}" if isinstance(total, int) else ""
    if count <= cap:
        return _grade(
            "pass",
            f"{count}{of} amount(s) in the answer have no tool result behind them (allowed {cap})",
            ev,
        )
    return _grade(
        "fail",
        f"{count}{of} amount(s) in the answer have no tool result behind them,"
        f" more than the {cap} allowed",
        ev,
    )


# ---- judge (reserved) -----------------------------------------------------------------------


def grade_judge(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    return _grade(
        "not_implemented",
        "the judge is reserved: it is built after Rishi writes the rubric,"
        " so this grader is recorded but not run",
    )


def grade_unit_test(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    from evals_graders.unit import run_unit_test

    return run_unit_test(ctx, spec)


GRADERS: dict[str, Callable[[Context, dict[str, Any]], dict[str, Any]]] = {
    "number": grade_number,
    "tool_called": grade_tool_called,
    "tool_not_called": grade_tool_not_called,
    "regex_present": grade_regex_present,
    "regex_absent": grade_regex_absent,
    "end_state": grade_end_state,
    "provenance": grade_provenance,
    "unit_test": grade_unit_test,
    "judge": grade_judge,
}


# ---- one trial ------------------------------------------------------------------------------


def run_one(ctx: Context, prepared: Prepared) -> dict[str, Any]:
    head = {
        "grader_id": prepared.id,
        "type": prepared.type,
        "required": prepared.required,
        "grader_version": prepared.version,
        "spec_sha256": prepared.spec_sha256,
    }
    if prepared.problems:
        return {**head, **_grade("error", "invalid grader spec: " + "; ".join(prepared.problems))}
    try:
        body = GRADERS[prepared.type](ctx, prepared.spec)
    except Exception as exc:  # a grader bug must not lose the other grades
        body = _grade("error", f"the {prepared.type} grader crashed: {type(exc).__name__}: {exc}")
    return {**head, **body}


def outcome(grades: list[dict[str, Any]]) -> tuple[bool | None, str, str]:
    """(passed, outcome, why). Passed only when every required grader passed; failed when a
    required grader failed; otherwise undetermined (`incomplete`), never counted either way."""
    required = [g for g in grades if g["required"]]
    if not required:
        return None, "incomplete", "the task has no required graders"
    failed = [g["grader_id"] for g in required if g["verdict"] == "fail"]
    if failed:
        return False, "fail", "required grader(s) failed: " + ", ".join(failed)
    open_ = [f"{g['grader_id']} ({g['verdict']})" for g in required if g["verdict"] != "pass"]
    if open_:
        return None, "incomplete", "required grader(s) gave no verdict: " + ", ".join(open_)
    return True, "pass", f"all {len(required)} required grader(s) passed"


def grade_trial(
    out_dir: str | Path,
    specs: list[Any],
    task_dir: str | Path | None = None,
    spec_hashes: list[str] | None = None,
    end_state_fallback: str | None = None,
) -> dict[str, Any]:
    """Runs every grader on one trial folder. Never raises for a grader's sake: a grader that
    cannot run is an `error` grade, so the others are still recorded."""
    trial = TrialView.load(out_dir)
    if end_state_fallback and trial.end_state is None:
        trial.end_state_fallback = end_state_fallback
    tdir = Path(task_dir) if task_dir is not None else None
    ctx = Context(trial, tdir)
    prepared = prepare(specs, tdir, spec_hashes)
    grades = [run_one(ctx, p) for p in prepared]
    passed, result, why = outcome(grades)
    return {
        "framework_version": FRAMEWORK_VERSION,
        "passed": passed,
        "outcome": result,
        "outcome_reason": why,
        "trial_problems": trial.problems,
        "grades": grades,
    }
