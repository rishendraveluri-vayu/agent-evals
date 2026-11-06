"""`evals-agreement --set tuning --human-unsure exclude`: the judge against Rishi's labels.

Reads labels/<set>.jsonl (Rishi's own labels; the first label per trial and criterion counts, a
later one is a relabel and goes to self-agreement, except a second-look answer (D46), which
replaces a first "unsure" and is not a relabel), fetches each labelled trial from the API
(GET /trials/:id: its config, which is the arm, and its current judge grades), pairs the two per
criterion, and prints the report as a table, or JSON with --json. Reads only; calls no model.

--human-unsure has no default: how Rishi's "unsure" labels count is his decision.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path
from typing import Any

from evals_stats.agreement import (
    HUMAN_UNSURE_POLICIES,
    MAX_UNDEFINED_SHARE,
    CriterionReport,
    Interval,
    Pair,
    between_raters,
    human_majority,
    report,
    self_agreement,
)

RISHI = "rishi"


def rater_of(row: dict[str, Any]) -> str:
    """The rater a label line names; a line from before D73 has none and is Rishi's."""
    r = row.get("rater")
    return r if isinstance(r, str) and r else RISHI


def dated(row: Any) -> bool:
    """A label line the order can place: it says when it was labelled. The API skips a line
    without `labelled_at` too, so both read the same labels."""
    return (
        isinstance(row, dict)
        and isinstance(row.get("labelled_at"), str)
        and bool(row["labelled_at"])
    )


def read_rater_labels(
    path: Path, undated: list[int] | None = None
) -> dict[str, tuple[dict[tuple[str, str], str], list[tuple[str, str, str]]]]:
    """D73: `read_labels` for every rater in the file, as {rater: (labels, relabels)}. A relabel is
    the same rater answering the same criterion again; another rater's answer never is one. A line
    with no `labelled_at` is left out, and its line number added to `undated` for the caller to
    report: sorted first, it used to become the first label, or a second look that was dropped."""
    rows: list[dict[str, Any]] = []
    if path.is_file():
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.strip():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if not dated(row):
                    if undated is not None:
                        undated.append(n)
                    continue
                rows.append(row)
    by_rater: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_rater.setdefault(rater_of(r), []).append(r)
    return {rater: _first_labels(rs) for rater, rs in sorted(by_rater.items())}


def read_labels(
    path: Path, rater: str = RISHI
) -> tuple[dict[tuple[str, str], str], list[tuple[str, str, str]]]:
    """One rater's labels (Rishi's by default, D73): see `_first_labels`."""
    return read_rater_labels(path).get(rater, ({}, []))


def _first_labels(
    rows: list[dict[str, Any]],
) -> tuple[dict[tuple[str, str], str], list[tuple[str, str, str]]]:
    """First label per (trial, criterion), and the relabels as (first, later) pairs.

    D46: a line with "second_look": true answers a criterion first marked "unsure"; it replaces
    that "unsure" (a second-look "unsure" stays "unsure", so the policy still leaves it out) and is
    not a relabel, since Rishi was asked again on purpose, not to test himself.
    """
    first: dict[tuple[str, str], str] = {}
    relabels: list[tuple[str, str, str]] = []
    second: set[tuple[str, str]] = set()
    rows = [r for r in rows if dated(r)]
    rows.sort(key=lambda r: r["labelled_at"])
    for r in rows:
        trial = r.get("trial_id") or r.get("item_id")
        crit, value = r.get("criterion"), r.get("value")
        if not isinstance(trial, str) or not isinstance(crit, str) or not isinstance(value, str):
            continue
        key = (trial, crit)
        if r.get("second_look") is True:
            if first.get(key) == "unsure" and key not in second:
                first[key] = value
                second.add(key)
            continue
        if key in first:
            relabels.append((f"{trial}:{crit}", first[key], value))
        else:
            first[key] = value
    return first, relabels


def warn_undated(path: Path, undated: list[int], prog: str) -> None:
    if undated:
        lines = ", ".join(str(n) for n in undated[:10]) + (" ..." if len(undated) > 10 else "")
        print(
            f"{prog}: {len(undated)} label line(s) in {path} have no labelled_at and are left out, "
            f"as the API leaves them out (line {lines})",
            file=sys.stderr,
        )


def judge_verdicts(trial: dict[str, Any]) -> dict[str, str]:
    """{criterion: verdict} from the trial's current judge grades; an error or not_implemented
    grade with no criterion items gives nothing (the pair shows as judge 'missing')."""
    out: dict[str, str] = {}
    for g in trial.get("grades") or []:
        if g.get("type") != "judge":
            continue
        for e in g.get("evidence") or []:
            if isinstance(e, dict) and isinstance(e.get("criterion"), str):
                out[e["criterion"]] = str(e.get("verdict") or "missing")
    return out


def arm_of(trial: dict[str, Any]) -> str:
    cfg = trial.get("config") or {}
    sha = str(cfg.get("hash") or "")
    return f"{cfg.get('name') or '?'} ({sha.removeprefix('sha256:')[:8]})"


def get(api: str, path: str) -> Any:
    with urllib.request.urlopen(api.rstrip("/") + path, timeout=60) as r:
        return json.loads(r.read())


def fmt(v: Any) -> str:
    return "-" if v is None else (f"{v:.2f}" if isinstance(v, float) else str(v))


def interval_text(i: Interval) -> str:
    """An interval as "0.40 to 0.90", or why there is none: too many resamples had no value (S3)."""
    if i.low is not None:
        return f"{fmt(i.low)} to {fmt(i.high)}"
    share = i.undefined_share
    return f"undefined: {share:.0%} of resamples" if share else "undefined"


def gap_text(r: CriterionReport) -> str:
    """Each pair of arms' signed false-pass gap (second minus first) and its interval (S2)."""
    if not r.false_pass_gaps:
        return "- (one arm)"
    if len(r.false_pass_gaps) == 1:
        g = r.false_pass_gaps[0]
        return f"{fmt(g.gap)} ({interval_text(g.interval)})"
    return "; ".join(
        f"{g.arms[1]} - {g.arms[0]}: {fmt(g.gap)} ({interval_text(g.interval)})"
        for g in r.false_pass_gaps
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="evals-agreement", description=__doc__.splitlines()[0])
    ap.add_argument("--set", required=True, choices=["tuning", "heldout", "final"])
    ap.add_argument("--human-unsure", required=True, choices=HUMAN_UNSURE_POLICIES)
    ap.add_argument("--labels", type=Path, default=Path(__file__).parents[3] / "labels")
    ap.add_argument("--api", default="http://127.0.0.1:3001/api")
    ap.add_argument("--resamples", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument(
        "--rater",
        default=RISHI,
        help="whose labels to measure the judge against: a rater id, or `humans` for the raters' "
        "majority (D73); default rishi",
    )
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    undated: list[int] = []
    by_rater = read_rater_labels(args.labels / f"{args.set}.jsonl", undated)
    warn_undated(args.labels / f"{args.set}.jsonl", undated, "evals-agreement")
    if args.rater == "humans":
        labels = human_majority({r: lab for r, (lab, _) in by_rater.items()}, args.human_unsure)
        relabels: list[tuple[str, str, str]] = []
    else:
        labels, relabels = by_rater.get(args.rater, ({}, []))
    if not labels:
        where = args.labels / f"{args.set}.jsonl"
        print(f"evals-agreement: no labels in {where}", file=sys.stderr)
        return 2
    pairs = []
    trials: dict[str, dict[str, Any]] = {}
    for (trial_id, crit), human in labels.items():
        if trial_id not in trials:
            trials[trial_id] = get(args.api, f"/trials/{trial_id}")
        t = trials[trial_id]
        judge = judge_verdicts(t).get(crit, "missing")
        task = (t.get("task") or {}).get("id")
        pairs.append(Pair(trial_id, crit, human, judge, arm_of(t), task))
    reports = report(pairs, args.human_unsure, resamples=args.resamples, seed=args.seed)
    first = [a for _, a, _ in relabels]
    later = [b for _, _, b in relabels]
    out = {
        "set": args.set,
        "human_unsure": args.human_unsure,
        "labels": len(labels),
        "trials": len(trials),
        "criteria": [r.as_dict() for r in reports],
        "self_agreement": self_agreement(first, later) if relabels else None,
        "rater": args.rater,
        "between_raters": between_raters(
            {r: lab for r, (lab, _) in by_rater.items()}, args.human_unsure
        ),
    }
    if args.json:
        print(json.dumps(out, indent=2))
        return 0
    print(
        f"Set {args.set}: {len(labels)} labels on {len(trials)} trials, measured against "
        f"{args.rater}; unsure labels: {args.human_unsure}\n"
    )
    arms = sorted({a for r in reports for a in r.by_arm})
    if len(arms) == 2:
        print(f"False-pass gap: {arms[1]} minus {arms[0]}.\n")
    print(
        "| criterion | n | kappa (95% CI) | sensitivity | specificity | false passes | "
        "false fails | left out (Rishi unsure / judge no answer) | false-pass gap between arms |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in reports:
        k = r.intervals["kappa"]
        print(
            f"| {r.criterion} | {r.table.n} | {fmt(r.table.kappa)} ({interval_text(k)}) | "
            f"{fmt(r.table.sensitivity)} | {fmt(r.table.specificity)} | "
            f"{r.table.fp} | {r.table.fn} | {r.human_left_out} / {r.judge_undecided} | "
            f"{gap_text(r)} |"
        )
    print(
        f"\nAn interval is undefined when more than {MAX_UNDEFINED_SHARE:.0%} of its resamples "
        "had no value (one answer only, or no human no in an arm)."
    )
    print(f"\nD8, the trust bar (it applies to the held-out set; this is the {args.set} set):")
    for r in reports:
        d8 = r.d8 or {"trusted": False, "reasons": ["not checked"]}
        verdict = "trusted" if d8["trusted"] else "not trusted: " + "; ".join(d8["reasons"])
        print(f"- {r.criterion}: {verdict}")
    for b in out["between_raters"]:
        print(
            f"\n{b['raters'][0]} with {b['raters'][1]} on {b['n']} shared labels: agreement "
            f"{fmt(b['agreement'])}, kappa {fmt(b['kappa'])} (the ceiling for a judge, D73)"
        )
    if out["self_agreement"]:
        s = out["self_agreement"]
        print(
            f"\nRishi with himself on {s['n']} relabels: agreement {fmt(s['agreement'])}, "
            f"kappa {fmt(s['kappa'])}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
