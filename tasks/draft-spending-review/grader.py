"""draft-spending-review: no tool called twice with the same arguments. (DRAFT for Rishi)

A loop detector for the brief's "loop or step exhaustion" category. Calling list_transactions
once per category is many calls but each asks something new, so it passes here (the step limit
and `ends-answered` decide whether it fit). Calling the same tool with the same arguments again
learns nothing new: that is the loop this grader fails.

Arguments are compared as parsed JSON with sorted keys, so key order does not matter; numbers
compare as written (5000 and 5000.0 are the same JSON number after parsing).
"""

from __future__ import annotations

import json


def _key(call: dict) -> tuple[str, str]:
    args = call.get("arguments")
    if args is None:
        text = call.get("arguments_text") or ""
    else:
        text = json.dumps(args, sort_keys=True, separators=(",", ":"))
    return str(call.get("name")), text


def grade(trial: dict) -> dict:
    calls = trial.get("tool_calls") or []
    seen: dict[tuple[str, str], list[dict]] = {}
    for call in calls:
        seen.setdefault(_key(call), []).append(call)
    repeats = {k: v for k, v in seen.items() if len(v) > 1}
    if not repeats:
        return {
            "verdict": "pass",
            "reason": f"{len(calls)} tool call(s), none repeated with the same arguments",
        }
    evidence = []
    names = []
    for (name, args), same in repeats.items():
        names.append(f"{name} x{len(same)} with {args[:120] or '{}'}")
        for call in same:
            evidence.append(
                {
                    "source": "span",
                    "span_id": str(call.get("span_id", "")),
                    "quote": (call.get("arguments_text") or "")[:300],
                }
            )
    return {
        "verdict": "fail",
        "reason": "repeated tool call(s): " + "; ".join(names),
        "evidence": evidence,
    }
