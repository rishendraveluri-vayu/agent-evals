#!/usr/bin/env python3
"""Pass rates and the paired verdict under strict, lenient and no sourcing check.

Reads the rows `sourcing_recheck.py` wrote. The sign-flip test is exact (every sign pattern
over the tasks); the interval is a task bootstrap with 10,000 resamples, a re-implementation of
the platform's, so it can differ from the platform's by about a point.

    python3 scripts/analysis/sourcing_compare.py rows.json <config hash A> <config hash B>
"""

import itertools
import json
import random
import sys

MODES = ("shipped", "strict", "lenient", "none")


def passes(row, mode):
    if not row["has_provenance"] or mode == "none":
        sourcing = True
    elif mode == "shipped":
        sourcing = row["prov_shipped_pass"]
    else:
        sourcing = row[f"{mode}_unsupported"] == 0
    return row["others_pass"] and sourcing


def sign_flip_p(diffs):
    observed = abs(sum(diffs))
    hits = sum(
        1
        for signs in itertools.product((1, -1), repeat=len(diffs))
        if abs(sum(s * d for s, d in zip(signs, diffs, strict=True))) >= observed - 1e-12
    )
    return hits / 2 ** len(diffs)


def bootstrap(diffs, n=10_000, seed=7):
    rng = random.Random(seed)
    means = sorted(sum(rng.choice(diffs) for _ in diffs) / len(diffs) for _ in range(n))
    return means[int(0.025 * n) - 1], means[int(0.975 * n) - 1]


def main(path, arm_a, arm_b):
    with open(path) as f:
        rows = json.load(f)
    mismatched = [r["trial"] for r in rows if passes(r, "strict") != r["shipped_pass"]]
    print(f"strict re-run against the shipped trial verdicts: {len(mismatched)} differ")
    tasks = sorted({r["task"] for r in rows})
    for mode in MODES:
        counts = {}
        for task in tasks:
            a = [passes(r, mode) for r in rows if r["task"] == task and r["config"] == arm_a]
            b = [passes(r, mode) for r in rows if r["task"] == task and r["config"] == arm_b]
            counts[task] = (sum(a), sum(b), len(a))
        diffs = [(b - a) / n for a, b, n in counts.values()]
        low, high = bootstrap(diffs)
        total_a = sum(c[0] for c in counts.values())
        total_b = sum(c[1] for c in counts.values())
        trials = sum(c[2] for c in counts.values())
        print(
            f"{mode:8s} A {total_a}/{trials}  B {total_b}/{trials}  "
            f"B-A {100 * sum(diffs) / len(diffs):+.1f} ({100 * low:+.1f} to {100 * high:+.1f})  "
            f"sign-flip p={sign_flip_p(diffs):.4f}  tasks differing {sum(d != 0 for d in diffs)}"
        )


if __name__ == "__main__":
    main(*sys.argv[1:4])
