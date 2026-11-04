"""`evals-grade <trial_out_dir> --task task.json`: grade one trial folder and print the grades.

Prints {framework_version, task_id, trial_dir, passed, outcome, outcome_reason, trial_problems,
grades} as JSON. Exit 0 when the graders ran (whatever their verdicts), 2 when the task file
cannot be read. Makes no network calls and writes nothing.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from evals_graders.graders import grade_trial


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evals-grade", description=__doc__.splitlines()[0])
    parser.add_argument(
        "trial_dir", type=Path, help="a trial's out/ folder (result.json, trace.jsonl)"
    )
    parser.add_argument(
        "--task", type=Path, required=True, help="the task.json whose graders to run"
    )
    parser.add_argument("--indent", type=int, default=2)
    args = parser.parse_args(argv)
    try:
        task = json.loads(args.task.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"evals-grade: cannot read {args.task}: {exc}", file=sys.stderr)
        return 2
    graders = task.get("graders") if isinstance(task, dict) else None
    if not isinstance(graders, list):
        print(f"evals-grade: {args.task} has no graders list", file=sys.stderr)
        return 2
    if not args.trial_dir.is_dir():
        print(f"evals-grade: {args.trial_dir} is not a folder", file=sys.stderr)
        return 2
    report = grade_trial(args.trial_dir, graders, task_dir=args.task.resolve().parent)
    out = {"task_id": task.get("id"), "trial_dir": str(args.trial_dir), **report}
    print(json.dumps(out, indent=args.indent or None, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
