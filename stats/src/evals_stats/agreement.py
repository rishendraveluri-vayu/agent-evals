"""Judge agreement with Rishi's labels (SP5): per criterion, how often the judge and Rishi agree,
beyond chance, and in which direction they disagree, with bootstrap intervals; per arm, so a
judge that is kinder to one arm shows up; and the corrected pass rate (Rogan-Gladen).

Method: docs/proposals/judge-validation.md. "Positive" is a pass (yes). So:

- tp: judge yes, Rishi yes;  fp: judge yes, Rishi no (a false pass);
- fn: judge no, Rishi yes (a false fail);  tn: judge no, Rishi no.
- sensitivity = tp / (tp + fn): of the outputs Rishi passes, the share the judge passes.
- specificity = tn / (tn + fp): of the outputs Rishi fails, the share the judge fails.
- Cohen's kappa = (po - pe) / (1 - pe), with po the observed agreement and pe the agreement two
  raters with these yes-rates would reach by chance. Undefined (None) when pe is 1, i.e. both
  raters gave one answer to everything.

Rishi's "unsure" labels: how to count them is his decision (judge-validation decision 3), so the
caller must say: "exclude" or "no". The judge's own non-answers (unsure, missing, an error grade)
are never put in the table; they are counted and reported next to it.
"""

from __future__ import annotations

import random
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

HUMAN_UNSURE_POLICIES = ("exclude", "no")


@dataclass(frozen=True)
class Pair:
    """One trial's verdict on one criterion, from Rishi and from the judge."""

    trial_id: str
    criterion: str
    human: str  # yes, no, unsure
    judge: str  # yes, no, or anything else the judge gave (unsure, missing, error)
    arm: str | None = None
    task_id: str | None = None


@dataclass(frozen=True)
class Table:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    tn: int = 0

    @property
    def n(self) -> int:
        return self.tp + self.fp + self.fn + self.tn

    @property
    def agreement(self) -> float | None:
        return (self.tp + self.tn) / self.n if self.n else None

    @property
    def kappa(self) -> float | None:
        n = self.n
        if not n:
            return None
        po = (self.tp + self.tn) / n
        judge_yes, human_yes = (self.tp + self.fp) / n, (self.tp + self.fn) / n
        pe = judge_yes * human_yes + (1 - judge_yes) * (1 - human_yes)
        return None if pe >= 1 else (po - pe) / (1 - pe)

    @property
    def sensitivity(self) -> float | None:
        return self.tp / (self.tp + self.fn) if self.tp + self.fn else None

    @property
    def specificity(self) -> float | None:
        return self.tn / (self.tn + self.fp) if self.tn + self.fp else None

    @property
    def false_pass_rate(self) -> float | None:
        return self.fp / (self.fp + self.tn) if self.fp + self.tn else None

    @property
    def false_fail_rate(self) -> float | None:
        return self.fn / (self.fn + self.tp) if self.fn + self.tp else None

    def as_dict(self) -> dict[str, Any]:
        return {
            "n": self.n,
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
            "tn": self.tn,
            "agreement": self.agreement,
            "kappa": self.kappa,
            "sensitivity": self.sensitivity,
            "specificity": self.specificity,
            "false_pass_rate": self.false_pass_rate,
            "false_fail_rate": self.false_fail_rate,
        }


def human_value(label: str, policy: str) -> str | None:
    """yes, no, or None (left out) for one of Rishi's labels under the unsure policy."""
    if policy not in HUMAN_UNSURE_POLICIES:
        raise ValueError(f"human_unsure must be one of {HUMAN_UNSURE_POLICIES}, not {policy!r}")
    if label in ("yes", "no"):
        return label
    return "no" if policy == "no" else None


def table(pairs: Iterable[Pair], human_unsure: str) -> Table:
    tp = fp = fn = tn = 0
    for p in pairs:
        h = human_value(p.human, human_unsure)
        if h is None or p.judge not in ("yes", "no"):
            continue
        if p.judge == "yes":
            tp, fp = (tp + 1, fp) if h == "yes" else (tp, fp + 1)
        else:
            fn, tn = (fn + 1, tn) if h == "yes" else (fn, tn + 1)
    return Table(tp, fp, fn, tn)


@dataclass(frozen=True)
class Interval:
    low: float | None
    high: float | None
    resamples: int  # how many resamples gave a value (the rest were undefined)

    def as_dict(self) -> dict[str, Any]:
        return {"low": self.low, "high": self.high, "resamples": self.resamples}


def percentile(values: Sequence[float], q: float) -> float:
    """Linear interpolation between order statistics (numpy's default)."""
    s = sorted(values)
    if not s:
        raise ValueError("no values")
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def bootstrap(
    items: Sequence[Any],
    statistic: Callable[[Sequence[Any]], float | None],
    *,
    resamples: int = 2000,
    seed: int = 0,
    level: float = 0.95,
) -> Interval:
    """Percentile interval: resample the items with replacement, recompute, take the tails."""
    if not items:
        return Interval(None, None, 0)
    rng = random.Random(seed)
    values = []
    n = len(items)
    for _ in range(resamples):
        sample = [items[rng.randrange(n)] for _ in range(n)]
        v = statistic(sample)
        if v is not None:
            values.append(v)
    if not values:
        return Interval(None, None, 0)
    tail = (1 - level) / 2
    return Interval(percentile(values, tail), percentile(values, 1 - tail), len(values))


@dataclass
class CriterionReport:
    criterion: str
    table: Table
    human_left_out: int  # Rishi's unsure labels left out under the policy
    judge_undecided: int  # pairs where the judge gave no yes or no
    intervals: dict[str, Interval] = field(default_factory=dict)
    by_arm: dict[str, Table] = field(default_factory=dict)
    false_pass_gap: float | None = None  # largest minus smallest false-pass rate across arms
    false_pass_gap_interval: Interval | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "criterion": self.criterion,
            **self.table.as_dict(),
            "human_left_out": self.human_left_out,
            "judge_undecided": self.judge_undecided,
            "intervals": {k: v.as_dict() for k, v in self.intervals.items()},
            "by_arm": {arm: t.as_dict() for arm, t in sorted(self.by_arm.items())},
            "false_pass_gap": self.false_pass_gap,
            "false_pass_gap_interval": (
                self.false_pass_gap_interval.as_dict() if self.false_pass_gap_interval else None
            ),
        }


def _gap(tables: Iterable[Table]) -> float | None:
    rates = [t.false_pass_rate for t in tables]
    known = [r for r in rates if r is not None]
    return max(known) - min(known) if len(known) >= 2 else None


def report(
    pairs: Sequence[Pair], human_unsure: str, *, resamples: int = 2000, seed: int = 0
) -> list[CriterionReport]:
    """One report per criterion, in first-seen order."""
    by_criterion: dict[str, list[Pair]] = defaultdict(list)
    for p in pairs:
        by_criterion[p.criterion].append(p)
    out = []
    for criterion, ps in by_criterion.items():
        used = [p for p in ps if _usable(p, human_unsure)]
        t = table(used, human_unsure)
        r = CriterionReport(
            criterion,
            t,
            human_left_out=sum(1 for p in ps if human_value(p.human, human_unsure) is None),
            judge_undecided=sum(1 for p in ps if p.judge not in YES_NO),
        )
        for name in ("kappa", "sensitivity", "specificity", "agreement"):
            r.intervals[name] = bootstrap(
                used,
                lambda s, name=name: getattr(table(s, human_unsure), name),
                resamples=resamples,
                seed=seed,
            )
        arms: dict[str, list[Pair]] = defaultdict(list)
        for p in used:
            arms[p.arm or "?"].append(p)
        r.by_arm = {arm: table(a, human_unsure) for arm, a in arms.items()}
        if len(arms) >= 2:
            r.false_pass_gap = _gap(r.by_arm.values())

            def gap(sample: Sequence[Pair]) -> float | None:
                grouped: dict[str, list[Pair]] = defaultdict(list)
                for p in sample:
                    grouped[p.arm or "?"].append(p)
                return _gap(table(g, human_unsure) for g in grouped.values())

            r.false_pass_gap_interval = bootstrap(used, gap, resamples=resamples, seed=seed)
        out.append(r)
    return out


YES_NO = ("yes", "no")


def _usable(p: Pair, human_unsure: str) -> bool:
    return human_value(p.human, human_unsure) is not None and p.judge in YES_NO


# ---- using the judge's output: the corrected pass rate ---------------------------------------


def rogan_gladen(judged_rate: float, sensitivity: float, specificity: float) -> float | None:
    """The true pass rate implied by the judge's pass rate and its error rates, clipped to [0, 1].
    None when sensitivity + specificity <= 1: such a judge carries no information."""
    youden = sensitivity + specificity - 1
    if youden <= 0:
        return None
    return min(1.0, max(0.0, (judged_rate + specificity - 1) / youden))


def corrected_rate(
    judged: Sequence[bool],
    pairs: Sequence[Pair],
    human_unsure: str,
    *,
    resamples: int = 2000,
    seed: int = 0,
    level: float = 0.95,
) -> dict[str, Any]:
    """The corrected pass rate with a joint bootstrap: each resample redraws the judged trials
    and, independently, the labelled pairs that give sensitivity and specificity."""
    used = [p for p in pairs if _usable(p, human_unsure)]
    t = table(used, human_unsure)
    raw = sum(judged) / len(judged) if judged else None
    point = None
    if raw is not None and t.sensitivity is not None and t.specificity is not None:
        point = rogan_gladen(raw, t.sensitivity, t.specificity)
    rng = random.Random(seed)
    values = []
    for _ in range(resamples if judged and used else 0):
        js = [judged[rng.randrange(len(judged))] for _ in judged]
        ls = table([used[rng.randrange(len(used))] for _ in used], human_unsure)
        if ls.sensitivity is None or ls.specificity is None:
            continue
        v = rogan_gladen(sum(js) / len(js), ls.sensitivity, ls.specificity)
        if v is not None:
            values.append(v)
    tail = (1 - level) / 2
    interval = (
        Interval(percentile(values, tail), percentile(values, 1 - tail), len(values))
        if values
        else Interval(None, None, 0)
    )
    return {
        "judged_rate": raw,
        "corrected_rate": point,
        "interval": interval.as_dict(),
        "sensitivity": t.sensitivity,
        "specificity": t.specificity,
        "labelled_pairs": t.n,
        "judged_trials": len(judged),
    }


# ---- consistency: the judge with itself, Rishi with himself ----------------------------------


def retest(runs: dict[Any, Sequence[str]]) -> dict[str, Any]:
    """Judge test-retest: for each item (trial, criterion), its verdicts across repeated runs.
    `stable` is the share of items whose runs all agree; items with fewer than 2 runs are left
    out and counted."""
    rated = {k: v for k, v in runs.items() if len(v) >= 2}
    stable = sum(1 for v in rated.values() if len(set(v)) == 1)
    return {
        "items": len(rated),
        "stable": stable,
        "stable_share": stable / len(rated) if rated else None,
        "single_run_items": len(runs) - len(rated),
    }


def self_agreement(first: Sequence[str], second: Sequence[str]) -> dict[str, Any]:
    """Rishi's relabels against his first labels, item by item (only yes/no pairs count)."""
    if len(first) != len(second):
        raise ValueError("the two passes must label the same items, in the same order")
    pairs = [
        Pair(str(i), "self", human=a, judge=b)
        for i, (a, b) in enumerate(zip(first, second, strict=True))
        if a in YES_NO and b in YES_NO
    ]
    t = table(pairs, "exclude")
    return {"n": t.n, "agreement": t.agreement, "kappa": t.kappa, "left_out": len(first) - t.n}
