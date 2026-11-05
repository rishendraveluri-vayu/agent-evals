"""D71's judge panel: each judge, and the majority of them, against Rishi's labels.

    evals-panel judge-panel/phase1-round1-advice-v1.jsonl --labels labels/tuning.jsonl \\
        [--human-unsure exclude|no] [--json]

Reads the rows `scripts/judge_panel.py` writes (one per trial, judge model and criterion) and
Rishi's labels, and reports, per judge and criterion, the same agreement figures as
`evals-agreement` (kappa, sensitivity, specificity, agreement, with bootstrap intervals over
trials), then every trial and criterion where the judges disagree with each other or with Rishi.
The majority is a judge of its own: on a criterion it says what at least two of three said, and is
undecided otherwise. Calls no model and reads nothing but the two files. A label for a criterion
no judge answered, and a verdict with no label, are counted, not compared.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from evals_stats.agreement import HUMAN_UNSURE_POLICIES, YES_NO, Pair, report
from evals_stats.agreement_cli import read_labels

MAJORITY = "majority"


def read_panel(path: Path) -> list[dict[str, Any]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def verdicts(rows: Iterable[dict[str, Any]]) -> dict[tuple[str, str], dict[str, str]]:
    """(trial, criterion) -> {model: verdict}. A later row for the same key replaces an earlier one
    (a re-run after an error); a row with no criterion (a failed call) counts as `error` on every
    criterion its trial has from the other judges."""
    out: dict[tuple[str, str], dict[str, str]] = defaultdict(dict)
    failed: dict[str, set[str]] = defaultdict(set)
    for r in rows:
        if r.get("criterion") is None:
            failed[r["trial_id"]].add(r["model"])
            continue
        out[(r["trial_id"], r["criterion"])][r["model"]] = str(r.get("verdict"))
    for (trial, _criterion), by_model in out.items():
        for model in failed.get(trial, ()):
            by_model.setdefault(model, "error")
    return dict(out)


def majority(by_model: dict[str, str]) -> str:
    """yes or no when more than half of the judges say it, else undecided."""
    yes = sum(1 for v in by_model.values() if v == "yes")
    no = sum(1 for v in by_model.values() if v == "no")
    half = len(by_model) / 2
    if yes > half:
        return "yes"
    if no > half:
        return "no"
    return "undecided"


def models_of(rows: Iterable[dict[str, Any]]) -> list[str]:
    seen: list[str] = []
    for r in rows:
        if r.get("model") not in seen:
            seen.append(r["model"])
    return seen


def pairs(
    table: dict[tuple[str, str], dict[str, str]],
    labels: dict[tuple[str, str], str],
    judge: str,
    arms: dict[str, str] | None = None,
) -> list[Pair]:
    """Rishi's label against one judge (or the majority) on every labelled (trial, criterion)."""
    out = []
    for (trial, criterion), by_model in table.items():
        human = labels.get((trial, criterion))
        if human is None:
            continue
        judged = majority(by_model) if judge == MAJORITY else by_model.get(judge, "missing")
        out.append(Pair(trial, criterion, human, judged, (arms or {}).get(trial)))
    return out


def disagreements(
    table: dict[tuple[str, str], dict[str, str]], labels: dict[tuple[str, str], str]
) -> list[dict[str, Any]]:
    """Every (trial, criterion) where the judges' yes/no verdicts differ, or one differs from a
    yes/no label of Rishi's, sorted by trial then criterion."""
    out = []
    for (trial, criterion), by_model in sorted(table.items()):
        decided = {m: v for m, v in by_model.items() if v in YES_NO}
        human = labels.get((trial, criterion))
        values = set(decided.values()) | ({human} if human in YES_NO else set())
        if len(values) > 1:
            out.append(
                {"trial_id": trial, "criterion": criterion, "judges": by_model, "human": human}
            )
    return out


def summary(
    rows: Sequence[dict[str, Any]],
    labels: dict[tuple[str, str], str],
    human_unsure: str,
    arms: dict[str, str] | None = None,
) -> dict[str, Any]:
    table = verdicts(rows)
    judges = [*models_of(rows), MAJORITY]
    judged_trials = {t for (t, _c) in table}
    return {
        "judges": {
            j: [r.as_dict() for r in report(pairs(table, labels, j, arms), human_unsure)]
            for j in judges
        },
        "disagreements": disagreements(table, labels),
        # Rishi labelled it on a judged trial, but no judge answered that criterion.
        "labelled_not_judged": sorted(
            f"{t}:{c}" for (t, c) in labels if t in judged_trials and (t, c) not in table
        ),
    }


def _fmt(v: Any) -> str:
    return "n/a" if v is None else f"{v:.2f}" if isinstance(v, float) else str(v)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="evals-panel", description=__doc__.splitlines()[0])
    p.add_argument("panel", type=Path, help="rows from scripts/judge_panel.py")
    p.add_argument("--labels", type=Path, required=True, help="Rishi's labels (labels/*.jsonl)")
    p.add_argument("--human-unsure", choices=HUMAN_UNSURE_POLICIES, default="exclude")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    labels, _relabels = read_labels(args.labels)
    out = summary(read_panel(args.panel), labels, args.human_unsure)
    if args.json:
        print(json.dumps(out, indent=2))
        return 0
    for judge, reports in out["judges"].items():
        print(f"== {judge}")
        for r in reports:
            ci = r["intervals"].get("kappa", {})
            print(
                f"  {r['criterion']:<28} n={r['n']:<3} agree={_fmt(r['agreement'])} "
                f"kappa={_fmt(r['kappa'])} ({_fmt(ci.get('low'))} to {_fmt(ci.get('high'))}) "
                f"sens={_fmt(r['sensitivity'])} spec={_fmt(r['specificity'])} "
                f"FP={r['fp']} FN={r['fn']} undecided={r['judge_undecided']}"
            )
    print(f"== disagreements ({len(out['disagreements'])})")
    for d in out["disagreements"]:
        judges = ", ".join(f"{m}={v}" for m, v in d["judges"].items())
        print(f"  {d['trial_id']} {d['criterion']}: human={d['human']}; {judges}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
