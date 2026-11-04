"""What a grader reads: one trial's out/ folder, as contract v2 writes it.

- `result.json` (contract/v2/result.schema.json): the end state, the final answer and the
  visible transcript.
- `trace.jsonl` (contract/v2/span.schema.json): OpenTelemetry spans; the `execute_tool <name>`
  spans carry each tool call's name, arguments and result.
- `checks.json`, when the runner wrote one: platform checks such as number provenance.

Tool names and results are normalised so one grader spec works on every harness: Hermes shows
the model `mcp__finance__<tool>` and wraps results as `{"result": "<json>"}`, Google ADK wraps
them as an MCP `CallToolResult` (`{"content": [{"type": "text", "text": "<json>"}]}`).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MCP_PREFIX = re.compile(r"^mcp__.+?__")
UNTRUSTED = re.compile(r"^\s*<untrusted_tool_result[^>]*>(.*)</untrusted_tool_result>\s*$", re.S)
TRUNCATED = re.compile(r"\.\.\.\[truncated \d+ chars\]$")


def normalise_tool_name(name: str) -> str:
    """`mcp__finance__list_debts` (Hermes) and `list_debts` (everyone else) are one tool."""
    return MCP_PREFIX.sub("", name.strip())


def otlp_value(value: dict[str, Any]) -> Any:
    """An OTLP any_value as plain Python."""
    if "stringValue" in value:
        return value["stringValue"]
    if "boolValue" in value:
        return value["boolValue"]
    if "intValue" in value:
        return int(value["intValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "arrayValue" in value:
        return [otlp_value(v) for v in value["arrayValue"].get("values", [])]
    return None


def _parse_json(text: str) -> tuple[bool, Any]:
    try:
        return True, json.loads(text)
    except (ValueError, TypeError):
        return False, None


def unwrap_tool_result(raw: str | None) -> tuple[str | None, Any]:
    """(the text the tool returned, its parsed JSON or None).

    Peels the wrappers harnesses add around the tool's own output: an <untrusted_tool_result>
    block, Hermes's `{"result": "<json>"}` and an MCP CallToolResult's text content.
    """
    if raw is None:
        return None, None
    text = raw
    for _ in range(4):
        m = UNTRUSTED.match(text)
        if m:
            text = m.group(1)
            continue
        ok, parsed = _parse_json(text)
        if not ok:
            return text, None
        if isinstance(parsed, dict):
            if set(parsed) == {"result"} and isinstance(parsed["result"], str):
                text = parsed["result"]
                continue
            content = parsed.get("content")
            if (
                isinstance(content, list)
                and content
                and set(parsed)
                <= {"content", "isError", "structuredContent", "is_error", "meta", "_meta"}
            ):
                texts = [
                    c.get("text")
                    for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                ]
                if texts and all(isinstance(t, str) for t in texts):
                    text = "\n".join(texts)
                    continue
        return text, parsed
    ok, parsed = _parse_json(text)
    return text, parsed if ok else None


@dataclass
class ToolCall:
    """One `execute_tool` span, normalised."""

    span_id: str
    name: str
    raw_name: str
    arguments_text: str
    arguments: Any
    result_text: str | None
    result: Any
    is_error: bool
    truncated: bool
    start_ns: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "span_id": self.span_id,
            "name": self.name,
            "raw_name": self.raw_name,
            "arguments": self.arguments,
            "arguments_text": self.arguments_text,
            "result": self.result,
            "result_text": self.result_text,
            "is_error": self.is_error,
            "truncated": self.truncated,
        }


@dataclass
class AgentMessage:
    index: int
    text: str
    is_final: bool


@dataclass
class TrialView:
    """A trial as graders see it. `problems` lists files that were missing or unreadable."""

    result: dict[str, Any] | None
    spans: list[dict[str, Any]]
    checks: dict[str, Any] | None
    checks_present: bool
    problems: list[str] = field(default_factory=list)
    end_state_fallback: str | None = None

    # ---- loading ----

    @classmethod
    def load(cls, out_dir: str | Path) -> TrialView:
        out = Path(out_dir)
        problems: list[str] = []
        result = _read_json(out / "result.json", problems)
        spans: list[dict[str, Any]] = []
        trace = out / "trace.jsonl"
        if trace.is_file():
            for i, line in enumerate(trace.read_text(encoding="utf-8").splitlines(), 1):
                if not line.strip():
                    continue
                ok, span = _parse_json(line)
                if ok and isinstance(span, dict):
                    spans.append(span)
                else:
                    problems.append(f"trace.jsonl line {i} is not a JSON object")
        else:
            problems.append("trace.jsonl is missing")
        checks_path = out / "checks.json"
        checks_present = checks_path.is_file()
        checks = _read_json(checks_path, problems) if checks_present else None
        report = (
            _read_json(out / "runner-report.json", [])
            if (out / "runner-report.json").is_file()
            else None
        )
        fallback = report.get("end_state") if isinstance(report, dict) else None
        if result is not None and not isinstance(result, dict):
            problems.append("result.json is not a JSON object")
            result = None
        if checks is not None and not isinstance(checks, dict):
            problems.append("checks.json is not a JSON object")
            checks = None
        return cls(result, spans, checks, checks_present, problems, fallback)

    # ---- what graders read ----

    @property
    def end_state(self) -> str | None:
        if self.result and isinstance(self.result.get("end_state"), str):
            return self.result["end_state"]
        return self.end_state_fallback

    @property
    def final_answer(self) -> str | None:
        if not self.result:
            return None
        value = self.result.get("final_answer")
        return value if isinstance(value, str) else None

    @property
    def transcript(self) -> list[dict[str, Any]]:
        conv = (self.result or {}).get("conversation") or {}
        items = conv.get("transcript") if isinstance(conv, dict) else None
        return [m for m in items or [] if isinstance(m, dict) and isinstance(m.get("content"), str)]

    def agent_messages(self) -> list[AgentMessage]:
        """The agent's visible replies, in order; the last is the final answer when they match."""
        out: list[AgentMessage] = []
        for i, m in enumerate(self.transcript):
            if m.get("role") == "assistant":
                out.append(AgentMessage(i, m["content"], False))
        final = self.final_answer
        if out and final is not None and out[-1].text == final:
            out[-1].is_final = True
        elif final:
            out.append(AgentMessage(len(self.transcript), final, True))
        return out

    def tool_calls(self) -> list[ToolCall]:
        calls: list[ToolCall] = []
        for span in self.spans:
            name = span.get("name", "")
            if not isinstance(name, str) or not name.startswith("execute_tool"):
                continue
            attrs = {
                a.get("key"): otlp_value(a.get("value") or {})
                for a in span.get("attributes") or []
                if isinstance(a, dict)
            }
            raw_name = attrs.get("gen_ai.tool.name") or name.removeprefix("execute_tool").strip()
            args_text = attrs.get("evals.tool.arguments")
            args_text = args_text if isinstance(args_text, str) else ""
            ok, args = _parse_json(args_text) if args_text else (True, {})
            raw_result = attrs.get("evals.tool.result")
            raw_result = raw_result if isinstance(raw_result, str) else None
            truncated = bool(raw_result and TRUNCATED.search(raw_result))
            result_text, result = unwrap_tool_result(raw_result)
            calls.append(
                ToolCall(
                    span_id=str(span.get("spanId", "")),
                    name=normalise_tool_name(str(raw_name)),
                    raw_name=str(raw_name),
                    arguments_text=args_text,
                    arguments=args if ok else None,
                    result_text=result_text,
                    result=result,
                    is_error=bool(attrs.get("evals.tool.is_error")),
                    truncated=truncated,
                    start_ns=int(span.get("startTimeUnixNano") or 0),
                )
            )
        calls.sort(key=lambda c: c.start_ns)
        return calls

    def as_dict(self) -> dict[str, Any]:
        """What a unit_test grader's `grade(trial)` receives: plain JSON."""
        return {
            "end_state": self.end_state,
            "final_answer": self.final_answer,
            "transcript": self.transcript,
            "agent_messages": [m.text for m in self.agent_messages()],
            "tool_calls": [c.as_dict() for c in self.tool_calls()],
            "checks": self.checks,
            "result": self.result,
        }


def _read_json(path: Path, problems: list[str]) -> Any:
    if not path.is_file():
        problems.append(f"{path.name} is missing")
        return None
    ok, value = _parse_json(path.read_text(encoding="utf-8"))
    if not ok:
        problems.append(f"{path.name} is not JSON")
        return None
    return value
