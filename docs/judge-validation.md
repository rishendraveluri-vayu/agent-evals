# Judge validation

Required by the brief: show how the judge was checked for trustworthiness, for example agreement with a small set of human-labelled examples.

The main risk is not overall accuracy. It's bias that differs by config: if the judge favours long answers and one model writes longer, the result is a fake win.

## Proposed plan

Pending D7, D8 and D10.

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

## Results

Fill in during SP5 and SP8.

| Measure | Value |
| --- | --- |
| Cohen's kappa, held-out + audit | |
| False positive rate | |
| False negative rate | |
| Agreement, config A | |
| Agreement, config B | |
| Test-retest, 3 repeats | |
| Rishi's self-consistency | |

## Limits to state

- Single human rater.
- Small label set, so wide intervals.
- Pilot trials may run on a cheaper model than the experiment.
