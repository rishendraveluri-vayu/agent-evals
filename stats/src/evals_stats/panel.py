"""D71's judge panel: each judge, and the majority of them, against the human labels.

    evals-panel judge-panel/phase1-round1-advice-v1.jsonl --labels labels/tuning.jsonl \\
        [--human-unsure exclude|no] [--weights judge-panel/phase2-to-label.json] [--json]

Reads the rows `scripts/judge_panel.py` writes (one per trial, judge model and criterion) and
the human labels (every rater's, D73: lines with no rater are Rishi's). Reports, per judge and
criterion, the same agreement figures as `evals-agreement` (kappa, sensitivity, specificity,
agreement, with bootstrap intervals over trials) against each rater and, with two or more
raters, against their majority, which is the reference that counts. Then the raters against
each other (the ceiling a judge can be expected to reach), and every trial and criterion where
the judges disagree with each other or with the reference. The judges' majority is a judge of
its own: on a criterion it says what at least two of three said, and is undecided otherwise.
Calls no model and reads nothing but the files it is given. A label for a criterion no judge
answered, and a verdict with no label, are counted, not compared.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from evals_stats.agreement import (
    HUMAN_UNSURE_POLICIES,
    YES_NO,
    Pair,
    between_raters,
    human_majority,
    report,
    weighted_table,
)
from evals_stats.agreement_cli import read_rater_labels

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


HUMANS = "humans"


def references(
    labels_by_rater: dict[str, dict[tuple[str, str], str]], human_unsure: str
) -> dict[str, dict[tuple[str, str], str]]:
    """What the judges are measured against (D73): each rater, and with two or more raters also
    their majority (`humans`), which is the reference that counts."""
    refs = dict(sorted(labels_by_rater.items()))
    if len(labels_by_rater) > 1:
        refs[HUMANS] = human_majority(labels_by_rater, human_unsure)
    return refs


def summary(
    rows: Sequence[dict[str, Any]],
    labels_by_rater: dict[str, dict[tuple[str, str], str]],
    human_unsure: str,
    arms: dict[str, str] | None = None,
    weights: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Every judge (and the judges' majority) against every human reference, the raters against
    each other, and with `weights` the weighted point estimates per criterion (D71 phase 2)."""
    table = verdicts(rows)
    judges = [*models_of(rows), MAJORITY]
    judged_trials = {t for (t, _c) in table}
    refs = references(labels_by_rater, human_unsure)
    primary = HUMANS if HUMANS in refs else next(iter(refs), None)
    out: dict[str, Any] = {
        "reference": primary,
        "references": {
            ref: {
                j: [r.as_dict() for r in report(pairs(table, labels, j, arms), human_unsure)]
                for j in judges
            }
            for ref, labels in refs.items()
        },
        "between_raters": between_raters(labels_by_rater, human_unsure),
        "disagreements": disagreements(table, refs.get(primary, {}) if primary else {}),
        # Labelled on a judged trial, but no judge answered that criterion.
        "labelled_not_judged": sorted(
            {
                f"{t}:{c}"
                for labels in labels_by_rater.values()
                for (t, c) in labels
                if t in judged_trials and (t, c) not in table
            }
        ),
    }
    out["judges"] = out["references"].get(primary, {}) if primary else {}
    if weights is not None:
        weighted: dict[str, dict[str, dict[str, Any]]] = {}
        for ref, labels in refs.items():
            for j in judges:
                by_criterion: dict[str, list[Pair]] = defaultdict(list)
                for pr in pairs(table, labels, j, arms):
                    by_criterion[pr.criterion].append(pr)
                weighted.setdefault(ref, {})[j] = {
                    c: weighted_table(ps, weights, human_unsure).as_dict()
                    for c, ps in by_criterion.items()
                }
        out["weighted"] = weighted
    return out


def read_weights(path: Path) -> dict[str, float]:
    """D71 phase 2: each labelled trial's weight, from judge-panel/phase2-to-label.json. A trial
    the judges disagreed on stands for itself; each agreed trial drawn stands for
    agreed_total / drawn of the agreed ones."""
    d = json.loads(path.read_text(encoding="utf-8"))
    drawn = d.get("agreed_drawn") or []
    w = {t: 1.0 for t in d.get("disagreed") or []}
    if drawn:
        w.update({t: d["agreed_total"] / len(drawn) for t in drawn})
    return w


def _fmt(v: Any) -> str:
    return "n/a" if v is None else f"{v:.2f}" if isinstance(v, float) else str(v)


def _print_reports(reports: list[dict[str, Any]]) -> None:
    for r in reports:
        ci = r["intervals"].get("kappa", {})
        print(
            f"    {r['criterion']:<28} n={r['n']:<3} agree={_fmt(r['agreement'])} "
            f"kappa={_fmt(r['kappa'])} ({_fmt(ci.get('low'))} to {_fmt(ci.get('high'))}) "
            f"sens={_fmt(r['sensitivity'])} spec={_fmt(r['specificity'])} "
            f"FP={r['fp']} FN={r['fn']} undecided={r['judge_undecided']}"
        )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="evals-panel", description=__doc__.splitlines()[0])
    p.add_argument("panel", type=Path, help="rows from scripts/judge_panel.py")
    p.add_argument("--labels", type=Path, required=True, help="human labels (labels/*.jsonl)")
    p.add_argument("--human-unsure", choices=HUMAN_UNSURE_POLICIES, default="exclude")
    p.add_argument("--weights", type=Path, help="judge-panel/phase2-to-label.json (D71 phase 2)")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    labels_by_rater = {
        r: labels for r, (labels, _relabels) in read_rater_labels(args.labels).items()
    }
    weights = read_weights(args.weights) if args.weights else None
    out = summary(read_panel(args.panel), labels_by_rater, args.human_unsure, weights=weights)
    if args.json:
        print(json.dumps(out, indent=2))
        return 0
    for ref, judges in out["references"].items():
        print(
            f"== against {ref}{' (the reference that counts)' if ref == out['reference'] else ''}"
        )
        for judge, reports in judges.items():
            print(f"  -- {judge}")
            _print_reports(reports)
    if out["between_raters"]:
        print("== raters against each other (the ceiling for a judge)")
        for b in out["between_raters"]:
            print(
                f"  {b['raters'][0]} vs {b['raters'][1]}: n={_fmt(b['n'])} "
                f"agree={_fmt(b['agreement'])} kappa={_fmt(b['kappa'])}"
            )
    if "weighted" in out:
        print("== weighted point estimates (each agreed trial drawn stands for several)")
        ref = out["reference"]
        for judge, by_criterion in out["weighted"].get(ref, {}).items():
            for criterion, t in by_criterion.items():
                print(
                    f"  {judge:<18} {criterion:<28} n={_fmt(t['n'])} agree={_fmt(t['agreement'])} "
                    f"kappa={_fmt(t['kappa'])} sens={_fmt(t['sensitivity'])} "
                    f"spec={_fmt(t['specificity'])}"
                )
    print(f"== disagreements with {out['reference']} or among judges ({len(out['disagreements'])})")
    for d in out["disagreements"]:
        judges = ", ".join(f"{m}={v}" for m, v in d["judges"].items())
        print(f"  {d['trial_id']} {d['criterion']}: human={d['human']}; {judges}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
