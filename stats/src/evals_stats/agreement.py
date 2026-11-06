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

# An interval is undefined (low and high None) when more than this share of its resamples had no
# value: kappa when a resample has one answer only, a rate with no negatives in it. Dropping them
# silently gave kappa [1, 1] from a single human "no" (destructive review S3). Proposed 6 Nov, for
# Rishi to confirm.
MAX_UNDEFINED_SHARE = 0.05


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


# D73: the raters' majority on an item where as many raters said yes as no. It is not an "unsure"
# (nobody was unsure), so it is left out under either unsure policy (destructive review S11).
TIE = "tie"


def human_value(label: str, policy: str) -> str | None:
    """yes, no, or None (left out) for one of Rishi's labels under the unsure policy. A raters'
    tie (TIE) is always left out."""
    if policy not in HUMAN_UNSURE_POLICIES:
        raise ValueError(f"human_unsure must be one of {HUMAN_UNSURE_POLICIES}, not {policy!r}")
    if label in ("yes", "no"):
        return label
    if label == TIE:
        return None
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
    drawn: int = 0  # how many resamples were drawn

    @property
    def undefined_share(self) -> float | None:
        """The share of the drawn resamples that had no value; None when none was drawn."""
        return (self.drawn - self.resamples) / self.drawn if self.drawn else None

    @property
    def includes_zero(self) -> bool | None:
        return None if self.low is None or self.high is None else self.low <= 0 <= self.high

    def as_dict(self) -> dict[str, Any]:
        return {
            "low": self.low,
            "high": self.high,
            "resamples": self.resamples,
            "drawn": self.drawn,
            "undefined_share": self.undefined_share,
        }


def percentile(values: Sequence[float], q: float) -> float:
    """Linear interpolation between order statistics (numpy's default)."""
    s = sorted(values)
    if not s:
        raise ValueError("no values")
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def _interval(values: Sequence[float], drawn: int, level: float) -> Interval:
    """Percentile interval of the defined values, or undefined (None, None) when none is defined
    or more than MAX_UNDEFINED_SHARE of the `drawn` resamples were not."""
    if not values or (drawn - len(values)) / drawn > MAX_UNDEFINED_SHARE:
        return Interval(None, None, len(values), drawn)
    tail = (1 - level) / 2
    return Interval(percentile(values, tail), percentile(values, 1 - tail), len(values), drawn)


def bootstrap(
    items: Sequence[Any],
    statistic: Callable[[Sequence[Any]], float | None],
    *,
    resamples: int = 2000,
    seed: int = 0,
    level: float = 0.95,
) -> Interval:
    """Percentile interval: resample the items with replacement, recompute, take the tails. A
    resample where the statistic is undefined is counted, and too many make the interval
    undefined (MAX_UNDEFINED_SHARE)."""
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
    return _interval(values, resamples, level)


@dataclass(frozen=True)
class Gap:
    """D8's false-pass gap between two arms: the second arm's false-pass rate minus the first's
    (arms in name order, so B - A), signed, with its bootstrap interval. An unbiased judge's gap
    is as likely below 0 as above, so its interval holds 0; the unsigned max - min this replaced
    is never below 0, and its interval left 0 out for unbiased judges (destructive review S2)."""

    arms: tuple[str, str]
    gap: float | None
    interval: Interval

    def as_dict(self) -> dict[str, Any]:
        return {
            "arms": list(self.arms),
            "gap": self.gap,
            "interval": self.interval.as_dict(),
            "includes_zero": self.interval.includes_zero,
        }


@dataclass
class CriterionReport:
    criterion: str
    table: Table
    human_left_out: int  # Rishi's unsure labels left out under the policy
    judge_undecided: int  # pairs where the judge gave no yes or no
    intervals: dict[str, Interval] = field(default_factory=dict)
    by_arm: dict[str, Table] = field(default_factory=dict)
    # Every pair of arms, in name order. With two arms there is one, also given as
    # false_pass_gap (B - A) and false_pass_gap_interval.
    false_pass_gaps: list[Gap] = field(default_factory=list)
    d8: dict[str, Any] | None = None

    @property
    def false_pass_gap(self) -> float | None:
        return self.false_pass_gaps[0].gap if len(self.false_pass_gaps) == 1 else None

    @property
    def false_pass_gap_interval(self) -> Interval | None:
        return self.false_pass_gaps[0].interval if len(self.false_pass_gaps) == 1 else None

    @property
    def no_false_pass_gap(self) -> bool | None:
        """D8's arm check: every pair's interval holds 0. None when it cannot be checked: labels
        from one arm only, or an interval undefined."""
        if not self.false_pass_gaps:
            return None
        held = [g.interval.includes_zero for g in self.false_pass_gaps]
        if any(h is False for h in held):
            return False
        return None if any(h is None for h in held) else True

    def as_dict(self) -> dict[str, Any]:
        gi = self.false_pass_gap_interval
        return {
            "criterion": self.criterion,
            **self.table.as_dict(),
            "human_no": self.table.fp + self.table.tn,
            "human_left_out": self.human_left_out,
            "judge_undecided": self.judge_undecided,
            "intervals": {k: v.as_dict() for k, v in self.intervals.items()},
            "by_arm": {arm: t.as_dict() for arm, t in sorted(self.by_arm.items())},
            "false_pass_gap": self.false_pass_gap,
            "false_pass_gap_interval": gi.as_dict() if gi else None,
            "false_pass_gaps": [g.as_dict() for g in self.false_pass_gaps],
            "no_false_pass_gap": self.no_false_pass_gap,
            "d8": self.d8,
        }


def _signed_gap(sample: Sequence[Pair], arms: tuple[str, str], human_unsure: str) -> float | None:
    """The second arm's false-pass rate minus the first's in `sample`; None when either arm has
    no human "no" in it."""
    first = table((p for p in sample if (p.arm or "?") == arms[0]), human_unsure).false_pass_rate
    second = table((p for p in sample if (p.arm or "?") == arms[1]), human_unsure).false_pass_rate
    return None if first is None or second is None else second - first


# ---- D8, the judge's trust bar (settled 5 Nov), on the held-out labels -----------------------

D8_KAPPA = 0.6
D8_KAPPA_LOW = 0.4
D8_RETEST = 0.9
# Fewer human "no" labels than this and specificity, the false-pass rate and its gap between arms
# rest on too few negatives: the criterion cannot pass D8 (destructive review S3: one "no" gave a
# kappa interval of [1, 1]). Proposed 6 Nov, for Rishi to confirm.
MIN_HUMAN_NO = 5


def d8_check(r: CriterionReport, retest_share: float | None = None) -> dict[str, Any]:
    """Whether one criterion clears D8: kappa >= 0.6 with its interval's lower end >= 0.4, no
    false-pass gap between arms (every gap's interval holds 0), test-retest agreement >= 90%, and
    at least MIN_HUMAN_NO human "no" labels. Anything that cannot be measured fails it, with the
    reason. D8 is defined on the held-out set; on another set this is for reading only."""
    reasons = []
    human_no = r.table.fp + r.table.tn
    if human_no < MIN_HUMAN_NO:
        reasons.append(f'{human_no} human "no" labels, fewer than {MIN_HUMAN_NO}')
    k = r.table.kappa
    if k is None:
        reasons.append("kappa is undefined")
    elif k < D8_KAPPA:
        reasons.append(f"kappa {k:.2f} is below {D8_KAPPA}")
    ki = r.intervals.get("kappa")
    if ki is None or ki.low is None:
        share = ki.undefined_share if ki else None
        why = f" ({share:.0%} of resamples undefined)" if share else ""
        reasons.append(f"kappa's interval is undefined{why}")
    elif ki.low < D8_KAPPA_LOW:
        reasons.append(f"kappa's interval reaches {ki.low:.2f}, below {D8_KAPPA_LOW}")
    gap = r.no_false_pass_gap
    if gap is None:
        reasons.append("the false-pass gap between arms could not be measured")
    elif not gap:
        reasons.append("the false-pass rate differs between arms (a gap's interval leaves out 0)")
    if retest_share is None:
        reasons.append("test-retest agreement is not measured")
    elif retest_share < D8_RETEST:
        reasons.append(f"test-retest agreement {retest_share:.0%} is below {D8_RETEST:.0%}")
    return {"trusted": not reasons, "reasons": reasons}


def report(
    pairs: Sequence[Pair],
    human_unsure: str,
    *,
    resamples: int = 2000,
    seed: int = 0,
    retest: dict[str, float] | None = None,
) -> list[CriterionReport]:
    """One report per criterion, in first-seen order, each with D8's check (`retest`: each
    criterion's test-retest agreement, when measured)."""
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
        names = sorted(arms)
        for i, first in enumerate(names):
            for second in names[i + 1 :]:
                pair = (first, second)
                r.false_pass_gaps.append(
                    Gap(
                        pair,
                        _signed_gap(used, pair, human_unsure),
                        bootstrap(
                            used,
                            lambda s, pair=pair: _signed_gap(s, pair, human_unsure),
                            resamples=resamples,
                            seed=seed,
                        ),
                    )
                )
        r.d8 = d8_check(r, (retest or {}).get(criterion))
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
    drawn = resamples if judged and used else 0
    for _ in range(drawn):
        js = [judged[rng.randrange(len(judged))] for _ in judged]
        ls = table([used[rng.randrange(len(used))] for _ in used], human_unsure)
        if ls.sensitivity is None or ls.specificity is None:
            continue
        v = rogan_gladen(sum(js) / len(js), ls.sensitivity, ls.specificity)
        if v is not None:
            values.append(v)
    # A resample with no human "no" (or "yes"), or a judge no better than chance, has no
    # corrected rate: counted, and too many make the interval undefined (S3).
    interval = _interval(values, drawn, level) if drawn else Interval(None, None, 0)
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


# ---- D73: more than one human rater ----------------------------------------------------------


def human_majority(
    labels_by_rater: dict[str, dict[tuple[str, str], str]], human_unsure: str
) -> dict[tuple[str, str], str]:
    """Per (trial, criterion): what more than half of the raters who gave a firm answer said, under
    the unsure policy; TIE when they split evenly (always left out: under `--human-unsure no` an
    "unsure" would count as a human no); `unsure` when nobody gave a firm answer."""
    keys: set[tuple[str, str]] = set()
    for labels in labels_by_rater.values():
        keys |= set(labels)
    out: dict[tuple[str, str], str] = {}
    for key in sorted(keys):
        firm = [
            v
            for labels in labels_by_rater.values()
            if key in labels and (v := human_value(labels[key], human_unsure)) is not None
        ]
        yes, no = firm.count("yes"), firm.count("no")
        if not firm:
            out[key] = "unsure"
        else:
            out[key] = "yes" if yes * 2 > len(firm) else "no" if no * 2 > len(firm) else TIE
    return out


def between_raters(
    labels_by_rater: dict[str, dict[tuple[str, str], str]], human_unsure: str
) -> list[dict[str, Any]]:
    """Each pair of raters on the items both answered firmly: n, agreement and Cohen's kappa. The
    agreement humans reach with each other is the ceiling a judge can be expected to reach."""
    out = []
    raters = sorted(labels_by_rater)
    for i, a in enumerate(raters):
        for b in raters[i + 1 :]:
            shared = sorted(set(labels_by_rater[a]) & set(labels_by_rater[b]))
            pairs = []
            for trial, criterion in shared:
                other = human_value(labels_by_rater[b][(trial, criterion)], human_unsure)
                pairs.append(
                    Pair(
                        trial, criterion, labels_by_rater[a][(trial, criterion)], other or "unsure"
                    )
                )
            t = table(pairs, human_unsure)
            out.append({"raters": [a, b], "n": t.n, "agreement": t.agreement, "kappa": t.kappa})
    return out


def weighted_table(pairs: Iterable[Pair], weights: dict[str, float], human_unsure: str) -> Table:
    """`table` with each pair counted `weights[trial_id]` times (1 when absent): for a sample that
    labels some trials on behalf of others (D71 phase 2: the agreed trials drawn stand for all the
    agreed ones). Counts may be fractional; kappa, sensitivity and specificity follow."""
    tp = fp = fn = tn = 0.0
    for p in pairs:
        h = human_value(p.human, human_unsure)
        if h is None or p.judge not in ("yes", "no"):
            continue
        w = weights.get(p.trial_id, 1.0)
        if p.judge == "yes":
            tp, fp = (tp + w, fp) if h == "yes" else (tp, fp + w)
        else:
            fn, tn = (fn + w, tn) if h == "yes" else (fn, tn + w)
    return Table(tp, fp, fn, tn)  # type: ignore[arg-type]
