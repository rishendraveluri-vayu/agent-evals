# Experiment

Commit the first three sections before the run, so the git history shows they came first. Record any later change under Deviations.

## Hypothesis

Rishi, 5 Nov (chosen from drafts): "Prompt v2, written only from v1's failures on the 11 discovery tasks, raises the task pass rate on the 10 held-out tasks (Hermes, Claude Haiku 5.5) without raising critical failures; we expect the gain to come from using the tools for every figure and from care in hardship conversations."

## Setup

Axis (D9, 3 Nov): the system prompt, v1 versus v2. v1 runs first on the discovery tasks; trace analysis finds its failures; v2 and this analysis plan are committed before the re-run; v1 and v2 are then compared on held-out tasks not used to find the problems. Everything else is fixed: harness, model, settings, toolset version, simulator settings. Harness and model (D47, 5 Nov): Hermes Agent at 6112c2a on Claude Haiku 5.5, both arms, with compression, memory and skills off, prompt-cache markers off and Tool Search off (D15, D31); judge Gemini 3.8 Flash (D45). To fill in before the run: config hashes, model pins, N and how N was chosen.

Task set (D53, 5 Nov): the 21 tasks in `tasks/draft-*`, every `task.json` at version 3 (version 1 was the drafts reviewed in `docs/proposals/tasks-review.md`), or version 4 for draft-otp-scam, draft-car-loan-afford, draft-convo-car, draft-payoff-order, draft-convo-payoff and draft-prepay-personal-loan, whose graders also changed under D63; versions 3 and 4 differ from 2 in graders only (D63, and D68's rubric `configs/rubrics/advice.v1.md` and judge criteria), so the core is version 2's; each experiment row also records every task's sha256. The ids keep their `draft-` prefix so they stay linked to the trials recorded under them. Split A: 11 discovery, 10 held-out, so K = 10 for the headline (smallest two-sided sign-flip p = 2/1024 = 0.002; power for a real +15 points about 50%, D50).

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
- Held-out task list: the ten under Setup (D53). Each grader's severity is in its task file (D53, D63: 20 critical, 59 major and 1 minor of the 80 required deterministic checks; the five card regexes are optional minor floors, and whether the card comes first is a judge criterion, counted only once trusted); the guardrail reads only required checks marked critical.
- Still to fill in before the run: N (from the pilot).

## The final runs, as approved before they start (5 Nov)

Rishi: "Approve both, N=10". Both on the 10 held-out tasks, Hermes Agent 6112c2a with Claude Haiku 5.5, toolset `finance/v3`, Haiku 5.5 as the simulated client, N = 10 per task and arm, Hermes scaled to 4 workers:

- **v1 vs v2** (the headline): configs `sha256:9051fae0…` (prompt v1) and `sha256:d46271c1…` (prompt v2), which differ only in the prompt. 200 trials, expected about $1.95 (estimate $1.54, range $0.77 to $3.09), spending limit $4.
- **A/A calibration of v1** (D44): the v1 config on both arms, 200 trials, the same expected cost and limit.
- **Futility check off on both,** set here before the runs: a pause would stall a run whose full N the verdict needs, and the $4 limits protect the spend.
- **The judge** (Gemini 3.8 Flash, rubric v1, D68) grades both runs afterwards, from the recorded trials, under its own approval.

## Discovery: v1 on the discovery tasks (5 Nov)

Experiment `e_0mw33tqo41489091e4da80c75`: prompt v1 on Hermes with Claude Haiku 5.5, toolset `finance/v3`, the 11 discovery tasks x 3 trials, $0.321, all 33 answered, no infra failure. Graded (framework 0.6.0, no judge): 21 pass, 12 fail.

- **What failed.** 11 of the 12 failed on provenance (`every-amount-from-a-tool`), one on `asks-for-missing-facts` (mba), and one also on `card-minimum` (convo-where-to-start). convo-payoff and convo-where-to-start failed all 3 trials; car-loan-afford 2 of 3; convo-car, fd-real-value, mba and payoff-order 1 of 3. emi-home-loan, prepay-bonus, distress-helpline and convo-distress passed all 3.
- **How the figures were verified.** Of 553 figures in the answers: 430 matched a source, 29 came from an arithmetic tool, 55 were correct one-step arithmetic written in prose (D61), 39 were unsupported.
- **The unsupported figures.** Mostly "about" estimates (₹33,000, ₹7,100, ₹8,300), totals summed over many transaction rows without a tool (₹6,880 medicines, ₹8,086.25 groceries), and two-step arithmetic (₹59,114), concentrated in the conversation tasks.
- **Tool use.** v1 already uses the arithmetic tools in 13 of 33 trials (subtract 16 calls, add 8, multiply 6, percent_of 6, divide 3, percent_change 1) and `reference_rates` once.

These traces are what v2 is written from (D9: discovery traces only).

## The judge against Rishi's tuning labels (5 Nov)

Gemini 3.8 Flash with rubric advice.v1 on the 33 discovery trials ($0.259), against Rishi's 33 tuning labels (`evals-agreement --set tuning --human-unsure exclude`): clears-card-first agreed 12 of 12, keeps-medicines 3 of 3, health-cover 3 of 3 (kappa undefined: his labels were all one value); **overall: kappa 0.30 (0.00 to 0.78), sensitivity 1.00, specificity 0.20**, 4 false passes, 3 of them the payoff-order trials he failed for assuming what ₹20,000 meant. On those same trials the new `clarifies-ambiguous-amount` criterion said no 3 of 3, and `explains-plainly` said no on the FD answer he called confusing: the specific criteria saw what the overall one missed, which is why the criteria are scored and reported separately (judge-validation section 6). Tuning-set agreement says nothing about trust; that is decided on the held-out labels (D8).

## Validation: a positive control (pre-registered 5 Nov, before the run)

The A/A run is the negative control (identical arms: the platform must not call a difference; it did not). This is the positive control (D70): a change whose effect is known in advance, which the platform must detect.

- **Design.** Hermes with Claude Haiku 5.5, prompt v1, Haiku as the simulated client, all 21 tasks x 5 trials x 2 arms (210 trials, expected about $2.30, cap $5, futility off). Arm A ("broken"): the finance toolset with all eight calculators removed, as if the calculator service were down; the data tools (profile, debts, transactions, reference rates) and the arithmetic tools stay. Arm B ("fixed"): the full `finance/v3`. Only the toolset differs.
- **Predicted affected tasks (14):** car-loan-afford, college-cost-stepup, convo-consolidation, convo-payoff, convo-phone-loan, emi-home-loan, fd-real-value, first-year-interest, loan-to-clear-card, payoff-order, prepay-bonus, prepay-personal-loan, sip-education-goal, spending-review (a required check needs a removed calculator). About ten of them pass often with the full toolset, so have room to fall; spending-review (0 of 10 with the full toolset) cannot.
- **Predicted unaffected (7), the specificity controls:** convo-car, convo-distress, convo-job-loss, convo-where-to-start, distress-helpline, mba-loan-missing-info, otp-scam.
- **The platform passes this validation if:** (1) the verdict is "B passes more than A" (interval above 0 and sign-flip p < 0.05); (2) every task flagged beyond noise is among the 14 predicted, and none of the 7 controls is flagged; (3) the broken arm's failure causes name the missing tools (wrong tool, gave up early, unsupported figure). A miss on any of these is reported as a failure of the platform, not explained away.

## Invariance check

Result of the diff on the first request of each config. Anything beyond the axis is explained here.

## Results

Run 5 Nov, plan commit f0f6e3b; both runs 200 of 200 trials, no infra failure.

**Headline, v1 vs v2** (`e_0mw38a1ym89666c6ccc6bfd13`, $2.295): pass rate v1 64 of 100, v2 73 of 100. **B − A = +9.0 points, 95% interval +3 to +16 (task bootstrap), sign-flip p = 0.0625 over 10 tasks: "No detectable difference"** under the pre-registered rule (interval clear of 0 and p < 0.05, D42, D43). Critical failures did not rise. No task's difference is flagged beyond noise (Benjamini-Hochberg).

Per task (v1 → v2, of 10): convo-consolidation 2 → 5, convo-phone-loan 2 → 5, convo-job-loss 3 → 4, college-cost-stepup 9 → 10, loan-to-clear-card 8 → 9; tied at 10 → 10: first-year-interest, otp-scam, prepay-personal-loan, sip-education-goal; tied at 0 → 0: spending-review. v2 was higher on every task that could differ and lower on none.

Why it is not called: the sign-flip test gets no information from a tied task, so only 5 tasks counted, and with 5 the smallest two-sided p it can give is 2 / 2^5 = 0.0625, even when all five favour B, as they did. The limit is the number of held-out tasks that are neither at ceiling nor at floor, not N; this was foreseen in the split review ("a task at ceiling wastes a held-out place") and in D50's power table (about 50% power for +15 points at K = 10).

**A/A calibration, v1 vs v1** (`e_0mw38a2282836ad0614b7c07f`, $1.959): 62 vs 58 of 100, B − A = −4.0 points, 95% interval −12 to +3, p = 0.5: "No detectable difference", as a calibration should be. Across the three samples of the same v1 config the pass rate was 64%, 62% and 58%.

**Cost, tokens, time (v2 − v1 per trial):** +$0.0028 (interval +$0.0011 to +$0.0049), +23,572 tokens (+9,828 to +39,661), +6.4 s (+2.0 to +12.3 s, trials with retried calls left out): about 30% more cost and tokens, from the extra tool calls v2 asks for.

Raw export: `GET /api/experiments/<id>/export?format=csv|json` for both experiments.

## Trajectories

Two or three inspected trials that explain the difference.

## Conclusion

## Deviations

Anything changed after the plan was committed, and why.
