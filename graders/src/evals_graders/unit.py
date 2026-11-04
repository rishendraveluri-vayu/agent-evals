"""The unit_test grader: a task's own `grade(trial) -> dict`, run out of process.

The task's grader file (grader.py next to task.json) runs in a fresh Python subprocess
(`python -I -m evals_graders.unit_runner`) with:
- the trial as JSON on stdin (TrialView.as_dict: final answer, transcript, tool calls, checks);
- an empty working folder and an empty environment;
- a wall-clock timeout, after which its whole process group is killed;
- no network and no child processes: the runner installs a Python audit hook that refuses to
  open a socket or start a process before it imports grader.py. Audit hooks cannot be removed
  from Python code. In compose the grader container is also on the internal trials network only.

`grade` returns {"verdict": "pass"|"fail"|..., "score"?, "reason"?, "evidence"?} or
{"pass": bool, ...}. Anything else, an exception or a timeout is an `error` grade, never a fail.
"""

from __future__ import annotations

import contextlib
import json
import os
import signal
import subprocess
import sys
import tempfile
from typing import TYPE_CHECKING, Any

from evals_graders.spec import DEFAULT_UNIT_FILE

if TYPE_CHECKING:
    from evals_graders.graders import Context

DEFAULT_TIMEOUT_S = 10.0
MAX_OUTPUT_BYTES = 1_000_000
SOURCES = {"final_answer", "agent_message", "span", "tool_result", "result", "checks"}


def _error(reason: str) -> dict[str, Any]:
    return {"verdict": "error", "score": None, "reason": reason, "evidence": []}


def _kill_group(proc: subprocess.Popen[bytes]) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)


def normalise_result(value: Any) -> dict[str, Any]:
    """A grade() return value as a grade body, or an error saying what was wrong with it."""
    if not isinstance(value, dict):
        return _error(f"grade() must return a dict, got {type(value).__name__}")
    verdict = value.get("verdict")
    if verdict is None:
        for key in ("pass", "passed"):
            if isinstance(value.get(key), bool):
                verdict = "pass" if value[key] else "fail"
                break
    if verdict not in ("pass", "fail", "not_applicable", "error"):
        return _error(f"grade() returned no usable verdict: {str(value)[:200]}")
    score = value.get("score")
    if score is None and verdict in ("pass", "fail"):
        score = 1.0 if verdict == "pass" else 0.0
    if score is not None and (
        isinstance(score, bool) or not isinstance(score, int | float) or not 0 <= score <= 1
    ):
        return _error(f"grade() returned score {score!r}; it must be a number from 0 to 1, or null")
    evidence = []
    for item in value.get("evidence") or []:
        if isinstance(item, str):
            evidence.append({"source": "final_answer", "quote": item})
        elif (
            isinstance(item, dict)
            and item.get("source") in SOURCES
            and (isinstance(item.get("quote"), str) or isinstance(item.get("span_id"), str))
        ):
            evidence.append(
                {k: v for k, v in item.items() if isinstance(v, str | int | float | bool)}
            )
        else:
            return _error(f"grade() returned evidence it cannot use: {str(item)[:200]}")
    reason = value.get("reason")
    return {
        "verdict": verdict,
        "score": None if score is None else float(score),
        "reason": str(reason) if reason is not None else f"grade() returned {verdict}",
        "evidence": evidence,
    }


def run_unit_test(ctx: Context, spec: dict[str, Any]) -> dict[str, Any]:
    name = spec.get("file", DEFAULT_UNIT_FILE)
    function = spec.get("function", "grade")
    timeout = float(spec.get("timeout_s", DEFAULT_TIMEOUT_S))
    if ctx.task_dir is None:
        return _error(f"no task folder, so {name} cannot be found")
    path = ctx.task_dir / name
    if not path.is_file():
        return _error(f"{name} is not next to task.json")
    payload = json.dumps(ctx.trial.as_dict()).encode()
    with tempfile.TemporaryDirectory(prefix="evals-unit-") as cwd:
        cmd = [
            sys.executable,
            "-I",
            "-m",
            "evals_graders.unit_runner",
            str(path.resolve()),
            function,
        ]
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env={"PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1", "HOME": cwd, "TMPDIR": cwd},
            start_new_session=True,
        )
        try:
            out, err = proc.communicate(payload, timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            proc.communicate()
            return _error(f"{name}:{function} timed out after {timeout:g} s and was killed")
        finally:
            _kill_group(proc)
    if len(out) > MAX_OUTPUT_BYTES:
        return _error(f"{name}:{function} wrote more than {MAX_OUTPUT_BYTES} bytes")
    lines = [ln for ln in out.decode("utf-8", "replace").splitlines() if ln.startswith("{")]
    try:
        reply = json.loads(lines[-1]) if lines else None
    except ValueError:
        reply = None
    if not isinstance(reply, dict):
        tail = err.decode("utf-8", "replace").strip().splitlines()[-3:]
        return _error(
            f"{name}:{function} exited {proc.returncode} without a result: {' | '.join(tail)[:500]}"
        )
    if not reply.get("ok"):
        return _error(f"{name}:{function} raised {reply.get('error', 'an error')}")
    return normalise_result(reply.get("value"))
