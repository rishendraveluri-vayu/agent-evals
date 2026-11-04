"""Subprocess entry for a unit_test grader: `python -I -m evals_graders.unit_runner FILE FUNC`.

Reads the trial JSON from stdin, refuses network and child processes (audit hook), imports
FILE, calls FUNC(trial) and writes one JSON line: {"ok": true, "value": ...} or {"ok": false,
"error": "..."}. Run by evals_graders.unit, never directly.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import traceback

# Audit events that open a connection or start a process. socket.__new__ covers every socket;
# the rest stop a grader shelling out to curl or similar.
BLOCKED = (
    "socket.__new__",
    "socket.connect",
    "socket.bind",
    "socket.getaddrinfo",
    "socket.gethostbyname",
    "subprocess.Popen",
    "os.system",
    "os.exec",
    "os.posix_spawn",
    "os.spawn",
    "os.fork",
    "os.forkpty",
)


def _hook(event: str, _args: tuple) -> None:
    if event in BLOCKED:
        raise PermissionError(
            f"unit_test graders may not use the network or start processes ({event})"
        )


def main() -> int:
    path, function = sys.argv[1], sys.argv[2]
    trial = json.loads(sys.stdin.read())
    out = sys.stdout
    try:
        import resource

        # A CPU backstop under the parent's wall-clock timeout.
        resource.setrlimit(resource.RLIMIT_CPU, (120, 121))
    except (ImportError, ValueError, OSError):
        pass
    sys.addaudithook(_hook)
    try:
        spec = importlib.util.spec_from_file_location("task_grader", path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fn = getattr(module, function, None)
        if not callable(fn):
            raise AttributeError(f"{path} has no function {function}")
        value = fn(trial)
        text = json.dumps({"ok": True, "value": value}, default=str)
    except BaseException as exc:  # noqa: BLE001 - every failure is reported, never raised
        last = traceback.format_exception_only(type(exc), exc)[-1].strip()
        text = json.dumps({"ok": False, "error": last})
    out.write("\n" + text + "\n")
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
