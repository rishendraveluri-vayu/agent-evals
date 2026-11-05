"""Regenerate tests/fixtures/gate-<date>/: real trial outputs, checks.json included, from gate
runs against the fake model server (no real model is called).

Each case runs one adapter through the runner, exactly as a gate test does, on a task that lists
required_tools, and keeps the out/ files a grader reads. Run from a harness's environment, for
one fixture folder (so an older folder is never rewritten by accident):

    cd workers/ownloop && uv run python ../../graders/tests/fixtures/make_gate_fixtures.py \\
        ownloop gate-20261105
    cd workers/hermes && HERMES_SRC=... uv run python \\
        ../../graders/tests/fixtures/make_gate_fixtures.py hermes gate-20261105
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from evals_adapter.gate import FakeServer, Gate

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
KEEP = ("result.json", "trace.jsonl", "runner-report.json", "checks.json")

# fixture folder -> [(fixture name, fake script, the task's required_tools)]
CASES = {
    "gate-20261104": [
        ("emi", "finance-emi", ["calculate_emi"]),
        ("emi-unsupported", "finance-emi-unsupported", ["calculate_emi", "list_debts"]),
    ],
    # D54: a sum taken from the arithmetic tool add, and the same answer without the add call.
    "gate-20261105": [
        ("sum-tool", "finance-sum-tool", ["calculate_emi", "list_debts"]),
        ("sum-unsupported", "finance-sum-unsupported", ["calculate_emi", "list_debts"]),
    ],
}


def gate_for(harness: str) -> Gate:
    if harness == "ownloop":
        caps = REPO / "workers" / "ownloop" / "src" / "ownloop" / "capabilities.json"
        return Gate(
            harness="ownloop",
            adapter_cmd=[sys.executable, "-m", "ownloop.adapter"],
            capabilities=json.loads(caps.read_text()),
        )
    if harness == "hermes":
        src = Path(os.environ["HERMES_SRC"])
        here = REPO / "workers" / "hermes"
        caps = here / "src" / "hermes_adapter" / "capabilities.json"
        return Gate(
            harness="hermes",
            adapter_cmd=[str(src / ".venv" / "bin" / "python"), "-m", "hermes_adapter.adapter"],
            capabilities=json.loads(caps.read_text()),
            tool_name=lambda name: f"mcp__finance__{name}",
            env={"PYTHONPATH": f"{here / 'src'}:{REPO / 'workers' / 'adapterlib' / 'src'}"},
        )
    raise SystemExit(f"unknown harness {harness}")


def main(harness: str, folder: str) -> None:
    if folder not in CASES:
        raise SystemExit(f"unknown fixture folder {folder}; one of {', '.join(CASES)}")
    out = HERE / folder
    gate = gate_for(harness)
    fake = FakeServer()
    try:
        for name, script, required in CASES[folder]:
            with tempfile.TemporaryDirectory(prefix="gate-fixture-") as tmp:
                tmp_path = Path(tmp)
                spec = gate.spec(tmp_path / "trial", script, fake)
                spec["trial"]["id"] = f"gate-{harness}-{name}"
                spec["task"]["required_tools"] = required
                run = gate.run(tmp_path, fake, spec)
                assert run.report["label"] == "agent", run.explain()
                dest = out / f"{harness}-{name}"
                dest.mkdir(parents=True, exist_ok=True)
                for f in KEEP:
                    shutil.copy2(run.trial_dir / "out" / f, dest / f)
                print(dest.relative_to(REPO), run.report["checks"])
    finally:
        fake.stop()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: make_gate_fixtures.py <ownloop|hermes> <{'|'.join(CASES)}>")
    main(sys.argv[1], sys.argv[2])
