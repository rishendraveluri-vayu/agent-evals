"""`evals-grade <trial_out_dir> --task task.json`: grade one trial folder and print the grades.

Prints {framework_version, task_id, trial_dir, passed, outcome, outcome_reason, trial_problems,
grades} as JSON. Exit 0 when the graders ran (whatever their verdicts), 2 when the task file
cannot be read. Writes nothing. Makes no network calls unless --judge-model is given: then a judge
grader calls that model through LiteLLM (EVALS_PROXY_URL, with the key in EVALS_JUDGE_KEY), which
costs real money and needs Rishi's sign-off first (R8). Without it a judge grade is
not_implemented.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from evals_graders.graders import grade_trial
from evals_graders.judge import JudgeAccess


def find_repo_root(start: Path) -> Path | None:
    """The nearest folder above `start` with a configs/ folder: where rubric paths are read."""
    for folder in [start, *start.parents]:
        if (folder / "configs").is_dir():
            return folder
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evals-grade", description=__doc__.splitlines()[0])
    parser.add_argument(
        "trial_dir", type=Path, help="a trial's out/ folder (result.json, trace.jsonl)"
    )
    parser.add_argument(
        "--task", type=Path, required=True, help="the task.json whose graders to run"
    )
    parser.add_argument("--indent", type=int, default=2)
    parser.add_argument(
        "--repo-root", type=Path, help="where configs/rubrics/ is (default: found from --task)"
    )
    parser.add_argument(
        "--judge-model",
        help="REAL MONEY: call this judge model via EVALS_PROXY_URL with EVALS_JUDGE_KEY",
    )
    args = parser.parse_args(argv)
    judge = None
    if args.judge_model:
        url, key = os.environ.get("EVALS_PROXY_URL"), os.environ.get("EVALS_JUDGE_KEY")
        if not url or not key:
            need = "--judge-model needs EVALS_PROXY_URL and EVALS_JUDGE_KEY"
            print(f"evals-grade: {need}", file=sys.stderr)
            return 2
        judge = JudgeAccess(url, key, args.judge_model)
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
    task_dir = args.task.resolve().parent
    summary = task.get("summary") if isinstance(task.get("summary"), str) else None
    report = grade_trial(
        args.trial_dir,
        graders,
        task_dir=task_dir,
        repo_root=args.repo_root or find_repo_root(task_dir),
        task_summary=summary,
        judge=judge,
    )
    out = {"task_id": task.get("id"), "trial_dir": str(args.trial_dir), **report}
    print(json.dumps(out, indent=args.indent or None, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
