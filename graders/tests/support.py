"""Synthetic trial folders in contract v2's shape, for known pass and known fail outputs.

The real trials are in tests/fixtures/real-20261104/: result.json, trace.jsonl and
runner-report.json copied from runs/20261104T083111Z-real/<harness>/claude-haiku-5-5/<scenario>/
trial/out/ (the first real run, 4 Nov, Haiku 5.5 on every harness; the client data is invented).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).parent / "fixtures" / "real-20261104"
HARNESSES = ("ownloop", "hermes", "langgraph", "adk", "openai-agents")


def real(name: str) -> Path:
    return FIXTURES / name


def _attr(key: str, value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        v = {"boolValue": value}
    elif isinstance(value, int):
        v = {"intValue": str(value)}
    elif isinstance(value, float):
        v = {"doubleValue": value}
    else:
        v = {"stringValue": value}
    return {"key": key, "value": v}


def tool_span(i: int, name: str, args: Any, result: Any, is_error: bool = False) -> dict[str, Any]:
    args_text = args if isinstance(args, str) else json.dumps(args)
    result_text = result if isinstance(result, str) else json.dumps(result)
    return {
        "traceId": "0" * 32,
        "spanId": f"{i + 1:016x}",
        "parentSpanId": "f" * 16,
        "name": f"execute_tool {name}",
        "kind": 1,
        "startTimeUnixNano": str(1_000_000 + i),
        "endTimeUnixNano": str(1_000_100 + i),
        "attributes": [
            _attr("gen_ai.operation.name", "execute_tool"),
            _attr("gen_ai.tool.name", name),
            _attr("evals.tool.arguments", args_text),
            _attr("evals.tool.is_error", is_error),
            _attr("evals.tool.result", result_text),
        ],
        "status": {"code": 2 if is_error else 1},
    }


def make_trial(
    root: Path,
    final_answer: str | None,
    tools: list[tuple[str, Any, Any]] | list[tuple[str, Any, Any, bool]] = (),
    end_state: str = "answered",
    earlier: list[str] = (),
    checks: Any = None,
    write_result: bool = True,
) -> Path:
    """A trial out/ folder. `earlier` are the agent's replies before the final one."""
    out = root / "out"
    out.mkdir(parents=True, exist_ok=True)
    transcript = [{"role": "user", "content": "Help me with my loan.", "source": "task"}]
    for text in earlier:
        transcript.append({"role": "assistant", "content": text, "source": "agent"})
        transcript.append({"role": "user", "content": "And then?", "source": "client_sim"})
    if final_answer is not None:
        transcript.append({"role": "assistant", "content": final_answer, "source": "agent"})
    result = {
        "contract_version": "2",
        "trial_id": "t_test",
        "end_state": end_state,
        "end_detail": {
            "harness_stop_reason": "stop",
            "exception_type": None,
            "exception_message": None,
            "last_message_excerpt": None,
        },
        "final_answer": final_answer,
        "conversation": {
            "agent_turns": 1,
            "client_turns": len(earlier),
            "ended_by": None,
            "transcript": transcript,
        },
    }
    if write_result:
        (out / "result.json").write_text(json.dumps(result), encoding="utf-8")
    spans = [tool_span(i, *t) for i, t in enumerate(tools)]
    (out / "trace.jsonl").write_text("".join(json.dumps(s) + "\n" for s in spans), encoding="utf-8")
    if checks is not None:
        (out / "checks.json").write_text(
            json.dumps(checks) if not isinstance(checks, str) else checks, encoding="utf-8"
        )
    return out


EMI_RESULT = {
    "emi": 8997.26,
    "emi_formatted": "₹8,997.26",
    "total_interest": 1159342.4,
    "total_interest_words": "11.59 lakh",
}
EMI_ARGS = {"principal": 1000000, "annual_rate_pct": 9, "tenure_months": 240}
