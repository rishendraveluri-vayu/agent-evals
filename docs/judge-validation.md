# Judge validation

Required by the brief: show how the judge was checked for trustworthiness, for example agreement with a small set of human-labelled examples.

The main risk is not overall accuracy. It's bias that differs by config: if the judge favours long answers and one model writes longer, the result is a fake win.

## Plan (settled 5 Nov)

The full method is `docs/proposals/judge-validation.md`; the decisions are D8 (trust bar: kappa >= 0.6 with its interval's lower end >= 0.4, no false-pass gap between arms, retest >= 90%), D45 (judge: Gemini 3.8 Flash), D46 ("not sure" gets a second look), D48 (20 / 40 / 20 labels), D49 (pooled error rates), D52 (label sets follow the task split) and D68 (rubric v1 and its criteria). D7 (which judge criteria become required once trusted) stays open. The table below is the original sketch.

| Set | Size | Source | Used for |
| --- | --- | --- | --- |
| Tuning | ~20 | Smoke trials, Thu | Tuning the rubric. Not reported as agreement. |
| Held-out | ~40 | Pilot trials, Fri | Reported agreement |
| Audit | ~20 | Real experiment, Fri | Reported agreement on real outputs |
| Self-check | ~10 relabelled | From the above | Rishi's own consistency |

95% CI at 90% observed agreement, Wilson score interval:

| Labels | CI |
| --- | --- |
| 30 | 74% to 97% |
| 60 | 80% to 95% |
| 100 | 83% to 95% |

Corrected on 3 Nov. The earlier table used the normal approximation, which at 30 labels gives an upper bound of 101%. Wilson stays inside 0 to 100% and is the recommended interval at small n.

Time estimate: about 80 labels at an assumed 1.5 minutes each, about 2 hours.

## Rules

- Label blind: hide the judge's verdict and the config.
- Sample stratified across configs and likely pass or fail, not at random.
- Only Rishi writes labels. Synthetic cases stay in a separate marked set and never count as human agreement.
- Set the threshold (D8) before seeing held-out results.

## Results (5 Nov)

Judge: Gemini 3.8 Flash, rubric `configs/rubrics/advice.v1.md`, on the 33 trials of the v1 discovery run. Human: Rishi's 33 tuning labels (51 criterion labels, blind; no "not sure"). Numbers from `evals-agreement --set tuning --human-unsure exclude` and `docs/experiment.md`.

| Measure | Value |
| --- | --- |
| Agreement, tuning set, "overall" (n = 33) | kappa 0.30 (95% interval 0.00 to 0.78); sensitivity 1.00, specificity 0.20: 4 false passes, 0 false fails |
| Agreement, tuning set, specific criteria | clears-card-first 12/12, keeps-medicines 3/3, health-cover 3/3 (kappa undefined: Rishi's labels on each were all one value) |
| What the specific criteria caught that "overall" missed | `clarifies-ambiguous-amount` said no on 3 of 3 payoff-order trials Rishi failed for assuming what ₹20,000 meant; `explains-plainly` said no on the FD answer he called confusing |
| Test-retest (the same 33 outputs judged twice) | 98 of 99 verdicts repeated (99.0%); clarifies-ambiguous-amount 5/6 (83%), every other criterion 100% |
| Held-out agreement (40 labels) | **not run**: no held-out labels yet |
| Per-arm false-pass gap | not measurable without held-out labels on both arms |
| Rishi's self-consistency | not run (no relabels) |

What this means: no judge criterion has met the trust bar, because the bar is measured on held-out labels, which do not exist yet. So **no judge criterion counts in the headline pass rate**; the headline rests on the required deterministic checks only, and the judge's verdicts are shown in each trial and reported, never gated. On the tuning set the specific criteria agree with Rishi where measurable and the whole-conversation "overall" criterion is lenient, which is why criteria are scored separately (D69 kept rubric v1 unchanged rather than tune it mid-experiment).

## Limits to state

- Single human rater.
- Small label set, so wide intervals.
- The tuning labels come from the agent's own v1 discovery run on the same model as the experiment (Claude Haiku 5.5), not a cheaper one.
- The judge (Gemini) is from a different family than the agent (Claude), so self-preference cannot tilt a Claude-vs-Claude comparison; it could in a Gemini-agent comparison.
