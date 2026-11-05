"""D71's judge panel: several judge models grade the same recorded trials, one row per verdict.

    EVALS_PROXY_URL=http://127.0.0.1:4000 EVALS_JUDGE_KEY=<a LiteLLM key capped for the panel> \\
    python3 scripts/judge_panel.py <experiment_id> --models gemini-3.8-flash,claude-sonnet-5-5 \\
        --out judge-panel/phase1-round1.jsonl [--rubric configs/rubrics/advice.v2.md] \\
        [--trials t_a,t_b] [--api http://127.0.0.1:3000/api] [--jobs 6]

REAL MONEY: every (trial, model) pair is one judge call through LiteLLM; it needs Rishi's
sign-off with a cost estimate first (R8, D71). Nothing else is sent anywhere.

For each finished trial of the experiment (its last done attempt, from GET
/experiments/:id/trials, read from runs/<experiment>/<trial>/attempt-<n>/) and each model, it
runs the offline grader (`graders/.venv/bin/evals-grade`) with only the task's judge graders,
from the task file in tasks/ (or with their rubric swapped for --rubric), and writes one JSON line
per criterion: trial, task, model, rubric, criterion, verdict, quote, whether the quote was found,
and the judge's reason. A call that fails is a row with `verdict: "error"`, never dropped. Rows
already in --out for the same trial, model and rubric are kept and not run again, so a stopped
panel resumes where it was. Standard library only.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
GRADE_BIN = REPO / "graders" / ".venv" / "bin" / "evals-grade"


def get(api: str, path: str) -> Any:
    with urllib.request.urlopen(f"{api.rstrip('/')}{path}", timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def done_trials(api: str, experiment_id: str) -> list[dict[str, Any]]:
    """The last done attempt of each slot: trial id, task id, attempt and config hash."""
    rows = get(api, f"/experiments/{experiment_id}/trials")
    return [
        {"trial_id": r["id"], "task_id": r["task_id"], "attempt": r["attempt"], "config_hash": r["config_hash"]}
        for r in rows
        if r.get("status") == "done"
    ]


def judge_task_dir(task_id: str, rubric: str | None, scratch: Path) -> Path:
    """A copy of the task's folder whose task.json keeps only its judge graders, each reading
    `rubric` when one is given. The copy keeps the task's other files (its client file)."""
    dest = scratch / f"{task_id}--{hashlib.sha256((rubric or '').encode()).hexdigest()[:8]}"
    if dest.exists():
        return dest
    shutil.copytree(REPO / "tasks" / task_id, dest)
    task = json.loads((dest / "task.json").read_text(encoding="utf-8"))
    judges = [g for g in task.get("graders", []) if isinstance(g, dict) and g.get("type") == "judge"]
    if rubric:
        judges = [{**g, "rubric": rubric} for g in judges]
    task["graders"] = judges
    (dest / "task.json").write_text(json.dumps(task, indent=2, ensure_ascii=False), encoding="utf-8")
    return dest


def verdict_rows(grade_report: dict[str, Any]) -> list[dict[str, Any]]:
    """One row per judge criterion from an evals-grade report (its judge grades' evidence)."""
    rows = []
    for grade in grade_report.get("grades", []):
        if grade.get("type") != "judge":
            continue
        criteria = [e for e in grade.get("evidence") or [] if isinstance(e, dict) and "criterion" in e]
        if not criteria:
            rows.append({"grader_id": grade.get("grader_id"), "criterion": None, "verdict": grade.get("verdict"), "reason": grade.get("reason")})
        for e in criteria:
            rows.append(
                {
                    "grader_id": grade.get("grader_id"),
                    "criterion": e.get("criterion"),
                    "verdict": e.get("verdict"),
                    "required": e.get("required"),
                    "quote": e.get("quote"),
                    "quote_found": e.get("quote_found"),
                    "reason": e.get("reason"),
                }
            )
    return rows


def judge_one(trial: dict[str, Any], model: str, task_dir: Path, folder: Path) -> list[dict[str, Any]]:
    base = {"trial_id": trial["trial_id"], "task_id": trial["task_id"], "config_hash": trial["config_hash"], "model": model}
    if not folder.is_dir():
        return [{**base, "criterion": None, "verdict": "error", "reason": f"no trial folder {folder}"}]
    run = subprocess.run(
        [str(GRADE_BIN), str(folder), "--task", str(task_dir / "task.json"), "--repo-root", str(REPO), "--judge-model", model, "--indent", "0"],
        capture_output=True,
        text=True,
        timeout=600,
        env={**os.environ},
    )
    if run.returncode != 0:
        return [{**base, "criterion": None, "verdict": "error", "reason": (run.stderr or run.stdout)[-500:]}]
    rows = verdict_rows(json.loads(run.stdout))
    return [{**base, **r} for r in rows] or [{**base, "criterion": None, "verdict": "error", "reason": "no judge grade"}]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("experiment_id")
    p.add_argument("--models", required=True, help="comma-separated LiteLLM model names")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--rubric", help="a repo-relative rubric path to use instead of each task's")
    p.add_argument("--trials", help="comma-separated trial ids (default: every done trial)")
    p.add_argument("--api", default=f"http://127.0.0.1:{os.environ.get('API_PORT') or '3000'}/api")
    p.add_argument("--runs", type=Path, default=REPO / "runs")
    p.add_argument("--jobs", type=int, default=6)
    args = p.parse_args(argv)
    if not os.environ.get("EVALS_PROXY_URL") or not os.environ.get("EVALS_JUDGE_KEY"):
        print("judge_panel: needs EVALS_PROXY_URL and EVALS_JUDGE_KEY (a LiteLLM key capped for the panel)", file=sys.stderr)
        return 2
    if not GRADE_BIN.exists():
        print(f"judge_panel: {GRADE_BIN} missing: run `uv sync` in graders/", file=sys.stderr)
        return 2
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    rubric = args.rubric
    rubric_name = rubric or "task's own"
    trials = done_trials(args.api, args.experiment_id)
    if args.trials:
        wanted = set(args.trials.split(","))
        trials = [t for t in trials if t["trial_id"] in wanted]
        missing = wanted - {t["trial_id"] for t in trials}
        if missing:
            print(f"judge_panel: not done trials of {args.experiment_id}: {sorted(missing)}", file=sys.stderr)
            return 2
    have: set[tuple[str, str, str]] = set()
    if args.out.exists():
        for line in args.out.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                if r.get("verdict") != "error":
                    have.add((r["trial_id"], r["model"], r.get("rubric")))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    jobs = [(t, m) for t in trials for m in models if (t["trial_id"], m, rubric_name) not in have]
    print(f"judge_panel: {len(trials)} trials x {len(models)} models; {len(jobs)} judge calls to make", file=sys.stderr)
    with tempfile.TemporaryDirectory(prefix="judge-panel-") as tmp, open(args.out, "a", encoding="utf-8") as out:
        scratch = Path(tmp)
        task_dirs = {t["task_id"]: judge_task_dir(t["task_id"], rubric, scratch) for t in trials}
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            futures = {
                pool.submit(
                    judge_one,
                    t,
                    m,
                    task_dirs[t["task_id"]],
                    args.runs / args.experiment_id / t["trial_id"] / f"attempt-{t['attempt']}",
                ): (t, m)
                for t, m in jobs
            }
            done = 0
            for fut in concurrent.futures.as_completed(futures):
                t, m = futures[fut]
                try:
                    rows = fut.result()
                except Exception as exc:  # noqa: BLE001 - reported as an error row, never dropped
                    rows = [{"trial_id": t["trial_id"], "task_id": t["task_id"], "model": m, "criterion": None, "verdict": "error", "reason": repr(exc)[:500]}]
                for r in rows:
                    out.write(json.dumps({**r, "rubric": rubric_name, "experiment_id": args.experiment_id}, ensure_ascii=False) + "\n")
                out.flush()
                done += 1
                if done % 10 == 0 or done == len(jobs):
                    print(f"judge_panel: {done}/{len(jobs)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
