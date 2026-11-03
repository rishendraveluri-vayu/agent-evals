# ruff: noqa: E501
"""The invariance diff: two configs' first model requests should differ only on the axis.

When one setting changes, nothing else may change unnoticed (spec, Goal). This compares the
first request each trial sent, as LiteLLM stored it (artifacts/proxy/0001.request.json), after
normalising what legitimately differs per trial:

- the trial folder's absolute path (Hermes puts paths in its prompt; in a container it is
  always /trial, outside one it is not);
- the "Conversation started:" date line Hermes writes (D20 keeps it; the date cannot be fixed);
- stored-header bookkeeping LiteLLM adds.

Every remaining difference is listed with its JSON path. Differences on the axis's paths are
expected; anything else is reported as unexpected and the command exits 1. For long strings such
as the system prompt, the changed lines are shown, so a harness-added line (for example Hermes's
"Model:" line on a model axis) is visible rather than hidden in one big change.

    evals-invariance runs/a/trial runs/b/trial --axis system_prompt
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Which request paths each axis may change. A path matches if it equals or starts with one.
AXIS_PATHS: dict[str, tuple[str, ...]] = {
    "system_prompt": ("messages[0].content",),
    "model": ("model",),
    "temperature": ("temperature",),
    "max_output_tokens": ("max_tokens", "max_completion_tokens"),
    "parallel_tool_calls": ("parallel_tool_calls",),
    "toolset": ("tools",),
    "none": (),
}
IGNORED_KEYS = {"_headers_seen"}
DATE_LINE = re.compile(r"^Conversation started: .*$", re.MULTILINE)


@dataclass
class Difference:
    path: str
    a: Any
    b: Any
    on_axis: bool
    lines: list[str] = field(default_factory=list)


def first_request(trial_dir: Path) -> dict[str, Any]:
    path = trial_dir / "out" / "artifacts" / "proxy" / "0001.request.json"
    if not path.exists():
        raise FileNotFoundError(
            f"{path}: the trial has no stored first request (run it through LiteLLM)"
        )
    return json.loads(path.read_text(encoding="utf-8"))


def normalise(value: Any, trial_root: str) -> Any:
    if isinstance(value, dict):
        return {k: normalise(v, trial_root) for k, v in value.items() if k not in IGNORED_KEYS}
    if isinstance(value, list):
        return [normalise(v, trial_root) for v in value]
    if isinstance(value, str):
        text = value.replace(trial_root, "/trial") if trial_root else value
        return DATE_LINE.sub("Conversation started: <date>", text)
    return value


def _on_axis(path: str, axis: str) -> bool:
    return any(
        path == p or path.startswith(p + ".") or path.startswith(p + "[") for p in AXIS_PATHS[axis]
    )


def compare(a: Any, b: Any, axis: str, path: str = "") -> list[Difference]:
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in sorted(set(a) | set(b)):
            sub = f"{path}.{key}" if path else key
            if key not in a or key not in b:
                out.append(
                    Difference(
                        sub, a.get(key, "<absent>"), b.get(key, "<absent>"), _on_axis(sub, axis)
                    )
                )
            else:
                out += compare(a[key], b[key], axis, sub)
        return out
    if isinstance(a, list) and isinstance(b, list):
        out = []
        for i in range(max(len(a), len(b))):
            sub = f"{path}[{i}]"
            if i >= len(a) or i >= len(b):
                out.append(
                    Difference(
                        sub,
                        a[i] if i < len(a) else "<absent>",
                        b[i] if i < len(b) else "<absent>",
                        _on_axis(sub, axis),
                    )
                )
            else:
                out += compare(a[i], b[i], axis, sub)
        return out
    if a == b:
        return []
    lines: list[str] = []
    if isinstance(a, str) and isinstance(b, str) and ("\n" in a or "\n" in b):
        lines = [
            line
            for line in difflib.unified_diff(a.splitlines(), b.splitlines(), lineterm="", n=0)
            if not line.startswith(("---", "+++", "@@"))
        ]
    return [Difference(path, a, b, _on_axis(path, axis), lines)]


def diff_trials(a_dir: Path, b_dir: Path, axis: str) -> list[Difference]:
    a = normalise(first_request(a_dir), str(a_dir.resolve()))
    b = normalise(first_request(b_dir), str(b_dir.resolve()))
    return compare(a, b, axis)


def report(diffs: list[Difference]) -> str:
    if not diffs:
        return "identical after normalisation"
    out = []
    for d in diffs:
        tag = "axis" if d.on_axis else "UNEXPECTED"
        if d.lines:
            out.append(f"[{tag}] {d.path}: {len(d.lines)} changed line(s)")
            out += [f"    {line[:200]}" for line in d.lines[:40]]
        else:
            out.append(f"[{tag}] {d.path}: {json.dumps(d.a)[:200]} -> {json.dumps(d.b)[:200]}")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Diff two trials' first model requests.")
    parser.add_argument("a", type=Path, help="trial folder (holds out/)")
    parser.add_argument("b", type=Path)
    parser.add_argument("--axis", choices=sorted(AXIS_PATHS), required=True)
    args = parser.parse_args(argv)
    diffs = diff_trials(args.a, args.b, args.axis)
    print(report(diffs))
    sys.exit(1 if any(not d.on_axis for d in diffs) else 0)


if __name__ == "__main__":
    main()
