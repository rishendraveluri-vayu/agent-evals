"""Write a harness's capabilities from evidence (contract v2 section 4, R11).

Runs the adapter against the fake model server and records what actually reached the request:

- defaults: a trial with temperature, max_output_tokens and parallel_tool_calls unset, to see
  what the harness sends on its own (the harness default the UI shows);
- settings: a trial with each set to a distinctive value; a setting is supported only if that
  value is what the model received;
- steps: a model that never stops calling tools, at max_steps 3; supported if the trial ends in
  step_limit, and extra_calls_at_limit is whatever the harness sent beyond 3.

The probed fields (supported, native, default, evidence, observed, extra_calls_at_limit) are
written back into capabilities.json. timeout_s, memory, skills and compression stay as declared:
a request cannot show them. Run it after changing an adapter, then review the diff and commit.

    evals-probe-harness --capabilities workers/ownloop/src/ownloop/capabilities.json \\
        -- python -m ownloop.adapter
"""

from __future__ import annotations

import argparse
import copy
import datetime as _dt
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from evals_adapter.adapter import CAPABILITIES_ENV
from evals_adapter.gate import FakeServer, Gate

PROBED = {
    "temperature": "temperature",
    "max_output_tokens": "max_tokens",
    "parallel_tool_calls": "parallel_tool_calls",
}
PROBE_VALUES = {"temperature": 0.37, "max_output_tokens": 777, "parallel_tool_calls": False}
MISSING = object()


def _sent(body: dict[str, Any], key: str) -> Any:
    if key == "max_tokens" and key not in body and "max_completion_tokens" in body:
        return body["max_completion_tokens"]
    return body.get(key, MISSING)


def probe(
    capabilities_path: Path, adapter_cmd: list[str], env: dict[str, str], tool_prefix: str = ""
) -> dict[str, Any]:
    declared = json.loads(capabilities_path.read_text())
    caps = copy.deepcopy(declared)
    # While probing, the adapter must accept every probed setting.
    trial_caps = copy.deepcopy(declared)
    for name in [*PROBED, "max_steps"]:
        trial_caps["settings"][name]["supported"] = True
    today = _dt.date.today().isoformat()
    evidence = f"probe:{today}"
    fake = FakeServer()
    try:
        with tempfile.TemporaryDirectory(prefix="evals-probe-") as tmp:
            tmp_path = Path(tmp)
            caps_file = tmp_path / "capabilities.json"
            caps_file.write_text(json.dumps(trial_caps))
            gate = Gate(
                harness=declared["harness"],
                adapter_cmd=adapter_cmd,
                capabilities=trial_caps,
                tool_name=lambda n: f"{tool_prefix}{n}",
                env={**env, CAPABILITIES_ENV: str(caps_file)},
            )

            def run(name: str, script: str, **settings: Any):
                d = tmp_path / name
                d.mkdir()
                spec = gate.spec(d / "trial", script, fake, **settings)
                result = gate.run(d, fake, spec)
                return result, gate.agent_requests(result)

            unset = {name: None for name in PROBED}
            _, base_reqs = run("defaults", "finance-emi", **unset)
            set_run, set_reqs = run("settings", "finance-emi", **PROBE_VALUES)
            step_run, step_reqs = run("steps", "finance-loop", max_steps=3)

            if not base_reqs or not set_reqs:
                raise RuntimeError(
                    "the adapter made no model call; fix it before probing:\n" + set_run.explain()
                )
            for name, key in PROBED.items():
                default_sent = _sent(base_reqs[0]["body"], key)
                values = [_sent(r["body"], key) for r in set_reqs]
                supported = all(v == PROBE_VALUES[name] for v in values)
                entry = caps["settings"][name]
                entry["supported"] = supported
                entry["evidence"] = evidence
                entry["default"] = None if default_sent is MISSING else default_sent
                shown = "not sent" if default_sent is MISSING else f"sends {default_sent!r}"
                if supported:
                    entry["observed"] = (
                        f"unset: {shown}; set to {PROBE_VALUES[name]!r}: sent as {key}"
                    )
                else:
                    got = sorted({repr(None if v is MISSING else v) for v in values})
                    entry["observed"] = (
                        f"unset: {shown}; set to {PROBE_VALUES[name]!r}: sent {', '.join(got)}"
                    )
            steps = caps["settings"]["max_steps"]
            calls = len(step_reqs)
            steps["supported"] = step_run.result.get("end_state") == "step_limit" and calls >= 3
            steps["evidence"] = evidence
            steps["extra_calls_at_limit"] = max(0, calls - 3)
            steps["observed"] = (
                f"max_steps 3: {calls} model calls, end_state {step_run.result.get('end_state')}, "
                f"harness counted {step_run.result.get('counts', {}).get('model_calls')}"
            )
    finally:
        fake.stop()
    return caps


def diff(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    lines = []
    for name, entry in new["settings"].items():
        before = old["settings"].get(name, {})
        for key in sorted(set(entry) | set(before)):
            if entry.get(key) != before.get(key):
                lines.append(f"{name}.{key}: {before.get(key)!r} -> {entry.get(key)!r}")
    return lines


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Write capabilities.json from probe evidence.")
    parser.add_argument("--capabilities", required=True, type=Path)
    parser.add_argument("--env", action="append", default=[], help="NAME=VALUE for the adapter")
    parser.add_argument("--tool-prefix", default="", help="e.g. mcp__finance__ for Hermes")
    parser.add_argument("--dry-run", action="store_true", help="print the changes, write nothing")
    parser.add_argument("adapter_cmd", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    cmd = args.adapter_cmd[1:] if args.adapter_cmd[:1] == ["--"] else args.adapter_cmd
    if not cmd:
        parser.error("give the adapter command after --")
    env = {}
    for item in args.env:
        k, _, v = item.partition("=")
        env[k] = v
    old = json.loads(args.capabilities.read_text())
    new = probe(args.capabilities, cmd, env, args.tool_prefix)
    changes = diff(old, new)
    print("\n".join(changes) if changes else "no changes")
    if not args.dry_run:
        args.capabilities.write_text(json.dumps(new, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote {args.capabilities}")
    sys.exit(0)


if __name__ == "__main__":
    main()
