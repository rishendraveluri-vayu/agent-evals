# Proposal: how we compare A and B and say how sure we are (SP6, D10)

Status: **proposal, 4 Nov 2026 night, for Rishi** (SP6 is **[Rishi designs]**; D10 is open). It
answers the brief's core question: did the agent get better, worse or stay the same, and how sure
are we. It pairs with `docs/proposals/judge-validation.md` for judge-graded criteria.

## The idea in one paragraph

Both arms run the same tasks, N trials each. Trials of one task are not independent, so **the task
is the unit**: each task gives one paired difference (B's pass rate minus A's on that task), and the
headline is the mean of those differences. Its interval comes from a **bootstrap that resamples
tasks** (D10 revision): each task's observed difference already carries its trial-to-trial noise,
so resampling tasks carries both "which tasks we happened to pick" and that noise. (The first
version also resampled trials inside each task, which counted the trial noise twice.) A **sign-flip permutation test** on the task differences gives the paired
p-value. The verdict is one of three, **better, worse or no detectable difference**, and a "no
difference" always says how big a difference could still be hiding.

## 1. Unit of analysis (D10)

- Per task t and arm: pass rate = trials that passed / trials with an agent outcome (infra failures
  re-run under D16 and, if still failed, reported and left out of that cell, never counted as a fail).
- Per task difference: d(t) = pass rate B(t) - pass rate A(t).
- **Headline: the mean of d(t) over tasks**, each task weighted equally. We generalise to "tasks like
  these", so tasks, not trials, are what we sample.
- Why not 2 x N x K trials as independent samples: 10 trials of one task share the task's
  difficulty; treating them as independent overstates confidence (D10's own note).

## 2. The interval: a bootstrap over tasks (revised 5 Nov)

10,000 resamples: draw K tasks with replacement, keeping each drawn task's observed difference;
compute the mean d. (Resampling the trials within each drawn task as well, the first version,
counted the trial noise twice: in simulation it gave 1.5% false alarms instead of 5% and 69% power
instead of 85% for +15 points at K = 20, N = 10; D10 revision in `docs/decisions.md`.) The 2.5th and 97.5th percentiles are the 95% interval.
With about 12 held-out tasks the interval will be wide; that is the honest answer, and §6 says how to
narrow it.

## 3. The paired test: sign-flip permutation

Under "no difference", A and B are exchangeable within a task, so each d(t) is as likely positive as
negative. Flip the signs of the K differences in every combination (exact for K up to about 20 as proposed; as built, exact up to 30,
2^K flips), and the p-value is the share of flipped means at least as far from zero as the observed
one. No normality assumption, and the pairing is by task. (McNemar needs one trial per task and arm,
so it does not fit N > 1; a mixed-effects logistic model is the heavier alternative.)

## 4. Per-task differences, without fooling ourselves

- Every task's d(t) is shown with its own interval (two independent proportions, Newcombe's method).
- With 12 to 20 tasks at 5%, about one task will look different by chance. So a task is only flagged
  "differs" after a **Benjamini-Hochberg correction** across tasks (q = 0.05, D41); the rest are
  shown as within noise. The per-task view is for finding what to inspect, not a second set of
  conclusions: every task where B dropped is listed, flagged or not.

## 5. The verdict, including "it's just noise"

| Verdict | When |
| --- | --- |
| B is better | interval above 0 and permutation p < 0.05 |
| B is worse | interval below 0 and p < 0.05 |
| No detectable difference | otherwise, with the sentence "a difference smaller than X points could exist undetected", X from §6 |
| Practically equivalent | the whole interval inside +/- 10 points of pass rate (D42), checked before "no detectable difference" |

**Calibration, every time:** an A/A run (the same config twice) must come out "no detectable
difference", and its interval width shows the setup's own noise. The Compare screen draws it under
the A/B interval (as in the approved design).

## 6. Choosing N and K before the run

From the pilot: the spread of pass rates between tasks and within tasks. Simulating the bootstrap
for candidate N (trials per task) and K (tasks) gives the **smallest difference detectable 8 times in
10**, shown on the Run screen before anything starts. Expect diminishing returns: past N of about 5,
more trials help little when tasks differ a lot from each other; more tasks help more.

## 7. Tests (SP6's done-when)

- Simulated A/A data, 1,000 times: the method calls "better" or "worse" about 5% of the time, no more.
- Simulated data with a known +15 point effect: the interval covers +15 about 95% of the time, and
  the verdict is "better" at the planned N and K most of the time (that rate is the power).
- An A/A run on real data before the experiment.

## 8. Cost, latency and tokens next to quality

The same paired, task-level method for cost per trial, wall time and tokens, from LiteLLM's records
(R10.9): a mean per-task difference with a bootstrap interval over tasks. No verdict on these, only
the difference and its interval, so "v2 is better and costs 6% more" reads in one line.

## 9. Pre-registered, then frozen

The metric, the unit, the test, alpha 0.05, the correction, the margin (if any), N and K, the
held-out task list and the handling of infra failures go into `docs/experiment.md` before the run.
Any change after seeing results is recorded there as a deviation (CLAUDE.md).

## Decisions for Rishi

1. **Settled 5 Nov (D10), revised the same day:** the task as the unit, a bootstrap that resamples
   tasks only (the two-level version counted trial noise twice; measurements under D10 revision in
   `docs/decisions.md`), plus the sign-flip test.
2. **Settled 5 Nov (D10):** the task pass rate is the headline, with a critical-failure guardrail
   and a regression list beside it (below).
   - Each grader carries a severity (critical, major, minor) in its task file, set by Rishi. B is
     called better only when its critical-failure rate did not rise beyond noise: the paired
     interval of B minus A on critical failures, computed the same way, must not lie above zero.
   - Where B regressed (per-task difference below zero, or a check that flipped from pass to fail),
     the comparison lists the checks that flipped, critical first, and each failed trial's cause:
     wrong tool, made-up tool arguments, gave up early, ran out of steps, or grader disagrees with
     the human label (the brief's stretch item 7). Causes come from rules over the trace, written
     per harness where a harness reports a failure its own way.
3. **Settled 5 Nov (D41):** Benjamini-Hochberg at q = 0.05 for the per-task flags; the trade-off is
   written out under D41 in `docs/decisions.md`. Holm was the first proposal; it was dropped because
   at N = 5 to 10 trials per task it cannot flag a task, and a flag here means "look here".
4. **Settled 5 Nov (D42):** an equivalence margin of +/- 10 points of pass rate, fixed in the
   analysis plan before the run.
5. **Settled 5 Nov (D43):** alpha 0.05 and 95% intervals, for the verdict, the critical guardrail,
   the equivalence check and the BH flags (q = 0.05).
