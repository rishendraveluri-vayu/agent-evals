# Experiment

Commit the first three sections before the run, so the git history shows they came first. Record any later change under Deviations.

## Hypothesis

Rishi to write.

## Setup

Axis (D9, 3 Nov): the system prompt, v1 versus v2. v1 runs first on the discovery tasks; trace analysis finds its failures; v2 and this analysis plan are committed before the re-run; v1 and v2 are then compared on held-out tasks not used to find the problems. Everything else is fixed: harness, model, settings, toolset version, simulator settings. Harness and model (D47, 5 Nov): Hermes Agent at 6112c2a on Claude Haiku 5.5, both arms, with compression, memory and skills off, prompt-cache markers off and Tool Search off (D15, D31); judge Gemini 3.8 Flash (D45). To fill in before the run: config hashes, model pins, N and how N was chosen.

Task set (D53, 5 Nov): the 21 tasks in `tasks/draft-*`, every `task.json` at version 2 (version 1 was the drafts reviewed in `docs/proposals/tasks-review.md`); each experiment row also records every task's sha256. The ids keep their `draft-` prefix so they stay linked to the trials recorded under them. Split A: 11 discovery, 10 held-out, so K = 10 for the headline (smallest two-sided sign-flip p = 2/1024 = 0.002; power for a real +15 points about 50%, D50).

- Held-out (the headline compares on these only): draft-first-year-interest, draft-prepay-personal-loan, draft-college-cost-stepup, draft-spending-review, draft-convo-job-loss, draft-convo-phone-loan, draft-loan-to-clear-card, draft-convo-consolidation, draft-sip-education-goal, draft-otp-scam. Seven single-message tasks and three conversations.
- Discovery: draft-emi-home-loan, draft-prepay-bonus, draft-fd-real-value, draft-mba-loan-missing-info, draft-distress-helpline, draft-car-loan-afford, draft-payoff-order, draft-convo-distress, draft-convo-car, draft-convo-payoff, draft-convo-where-to-start. Seven single-message tasks and four conversations.
- **Held-out tasks whose v1 outputs were read:** draft-loan-to-clear-card, draft-convo-consolidation, draft-sip-education-goal and draft-otp-scam were in the 4 Nov label batch (`e_0mw273dpt486807c2722a92dc`) and later Hermes runs, and their v1 outputs were read for open coding before v2 was written. The other six held-out tasks have never been run.
- **v2 is written from discovery traces only.** No held-out trial is read to write or change v2; the four tasks above were read before this rule and before the split existed.
- **Labels.** The 4 Nov trials of those four tasks ran on their version 1 task rows, which say `discovery`. Since 5 Nov the label queue and `POST /labels` go by each task's split in `tasks/` today (D52), so they are offered for the held-out and final sets only, never for tuning.

## Analysis plan

Settled 5 Nov (D10, D41 to D44, D8, D46; details in `docs/proposals/stats.md` and `docs/proposals/judge-validation.md`):

- Unit: the task. Metric: the task pass rate (every required grader passes; a trial with no outcome is counted apart).
- Interval: bootstrap resampling tasks only (D10 revision), 95%. Test: sign-flip permutation on per-task differences, alpha 0.05.
- Verdict: better, worse, practically equivalent (the whole interval within +/- 10 points), or no detectable difference.
- Guardrail: B is not called better if its critical-failure rate rose beyond noise (each grader's severity set by Rishi in its task).
- Per-task flags: Benjamini-Hochberg at q = 0.05; every task where B dropped is listed with what got worse and why.
- Calibration: an A/A run of the v1 config, marked as calibration.
- Judge: a criterion counts only if, on the held-out labels, kappa >= 0.6 (lower bound >= 0.4), no false-pass gap between arms, retest >= 90%; "not sure" labels get one second look, then are excluded.
- Infra failures: labelled, reported, never counted as agent failures and never dropped silently.
- Held-out task list: the ten under Setup (D53). Each grader's severity is in its task file (D53: 20 critical, 64 major and 1 minor of the 85 required deterministic checks); the guardrail reads only required checks marked critical.
- Still to fill in before the run: N (from the pilot).

## Invariance check

Result of the diff on the first request of each config. Anything beyond the axis is explained here.

## Results

Quality with CIs, per-task deltas, cost, latency and tokens. Raw export: `experiments/<id>/`.

## Trajectories

Two or three inspected trials that explain the difference.

## Conclusion

## Deviations

Anything changed after the plan was committed, and why.
