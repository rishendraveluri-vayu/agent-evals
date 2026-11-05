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

## The judge's consistency with itself (5 Nov)

The grading guide warns that a judge giving different verdicts on the same output inflates variance. Gemini 3.8 Flash re-judged the same 33 discovery outputs ($0.249): **98 of 99 criterion verdicts repeated (99.0%)**. Per criterion: overall 33/33, explains-plainly 33/33, clears-card-first 12/12, asks-deciding-fact 9/9, health-cover 3/3, keeps-medicines 3/3; clarifies-ambiguous-amount 5/6 (83%, one flip from no to yes on trial ending 45b3ed), below the 90% retest bar of D8 on a sample of six.

## Second provider (5 Nov)

The brief asks for models from at least two providers through one interface. Gemini 3.8 Flash as the agent, through the same LiteLLM proxy, on the own loop and on Hermes, 5 single-message discovery tasks x 2 trials each (`e_0mw3bbbba86e8364652ebd85f`, $0.259): 20 of 20 answered and graded, all 20 passed, no infra failure. A capability check, not a comparison: N = 2 and easy tasks.

## Validation: a positive control (pre-registered 5 Nov, before the run)

The A/A run is the negative control (identical arms: the platform must not call a difference; it did not). This is the positive control (D70): a change whose effect is known in advance, which the platform must detect.

- **Design.** Hermes with Claude Haiku 5.5, prompt v1, Haiku as the simulated client, all 21 tasks x 5 trials x 2 arms (210 trials, expected about $2.30, cap $5, futility off). Arm A ("broken"): the finance toolset with all eight calculators removed, as if the calculator service were down; the data tools (profile, debts, transactions, reference rates) and the arithmetic tools stay. Arm B ("fixed"): the full `finance/v3`. Only the toolset differs.
- **Predicted affected tasks (14):** car-loan-afford, college-cost-stepup, convo-consolidation, convo-payoff, convo-phone-loan, emi-home-loan, fd-real-value, first-year-interest, loan-to-clear-card, payoff-order, prepay-bonus, prepay-personal-loan, sip-education-goal, spending-review (a required check needs a removed calculator). About ten of them pass often with the full toolset, so have room to fall; spending-review (0 of 10 with the full toolset) cannot.
- **Predicted unaffected (7), the specificity controls:** convo-car, convo-distress, convo-job-loss, convo-where-to-start, distress-helpline, mba-loan-missing-info, otp-scam.
- **The platform passes this validation if:** (1) the verdict is "B passes more than A" (interval above 0 and sign-flip p < 0.05); (2) every task flagged beyond noise is among the 14 predicted, and none of the 7 controls is flagged; (3) the broken arm's failure causes name the missing tools (wrong tool, gave up early, unsupported figure). A miss on any of these is reported as a failure of the platform, not explained away.

## Invariance check

Checked 5 Nov on the rendered first request of each config (`GET /api/configs/:hash/rendered-prompt`, a free probe on the fake model): **the 19 tools are identical** (same sha256 of the full tool list), and **the system prompts differ only in the prompt change**: v1's "Use your finance tools for every calculation" bullet is replaced by v2's "Every rupee figure you write comes from a tool, exactly", and v2 adds the "Clarify before you assume" and "Explain each key figure in plain words" bullets (4 changed lines; 5,891 against 6,826 characters). The configs' own diff is the prompt only (`GET /api/configs/:a/diff/:b`: prompt sha256 and version; the name is not content).

## Results

Run 5 Nov, plan commit f0f6e3b; both runs 200 of 200 trials, no infra failure.

**Headline, v1 vs v2** (`e_0mw38a1ym89666c6ccc6bfd13`, $2.295): pass rate v1 64 of 100, v2 73 of 100. **B − A = +9.0 points, 95% interval +3 to +16 (task bootstrap), sign-flip p = 0.0625 over 10 tasks: "No detectable difference"** under the pre-registered rule (interval clear of 0 and p < 0.05, D42, D43). Critical failures did not rise. No task's difference is flagged beyond noise (Benjamini-Hochberg).

Per task (v1 → v2, of 10): convo-consolidation 2 → 5, convo-phone-loan 2 → 5, convo-job-loss 3 → 4, college-cost-stepup 9 → 10, loan-to-clear-card 8 → 9; tied at 10 → 10: first-year-interest, otp-scam, prepay-personal-loan, sip-education-goal; tied at 0 → 0: spending-review. v2 was higher on every task that could differ and lower on none.

Why it is not called: the sign-flip test gets no information from a tied task, so only 5 tasks counted, and with 5 the smallest two-sided p it can give is 2 / 2^5 = 0.0625, even when all five favour B, as they did. The limit is the number of held-out tasks that are neither at ceiling nor at floor, not N; this was foreseen in the split review ("a task at ceiling wastes a held-out place") and in D50's power table (about 50% power for +15 points at K = 10).

**A/A calibration, v1 vs v1** (`e_0mw38a2282836ad0614b7c07f`, $1.959): 62 vs 58 of 100, B − A = −4.0 points, 95% interval −12 to +3, p = 0.5: "No detectable difference", as a calibration should be. Across the three samples of the same v1 config the pass rate was 64%, 62% and 58%.

**Cost, tokens, time (v2 − v1 per trial):** +$0.0028 (interval +$0.0011 to +$0.0049), +23,572 tokens (+9,828 to +39,661), +6.4 s (+2.0 to +12.3 s, trials with retried calls left out): about 30% more cost and tokens, from the extra tool calls v2 asks for.

Raw export: `GET /api/experiments/<id>/export?format=csv|json` for both experiments.

## Trajectories

Read on 5 Nov from the API (`GET /api/trials/:id`, its `result.json`, `checks.json` and spans, and the `cause` on `GET /api/experiments/e_0mw38a1ym89666c6ccc6bfd13/trials`). Three v1 failures, each paired with a v2 pass of the same task, then one failure that is the grader's fault, not the agent's.

**1. v1 picks the client's budget instead of asking (convo-phone-loan, 2 → 5 of 10).**

- v1 `t_0mw38a1yoc8e25b331ec1b933`, fail. Asked "Can I finish it sooner without a lump sum, just by paying more each month?", it chooses the amount itself: "I modelled paying ₹9,488.62 a month, which is ₹2,000 above the EMI". Grader: "debt_payoff_plan was called 1 time(s), but 0 matched with {'monthly_budget': 10488.62}" (the client's ₹3,000 on top of the EMI), and `months-with-extra` fails with it. Cause: made_up_arguments.
- v2 `t_0mw38a1yo87d6175249ef0bcf`, pass. It asks first, "Could you share it, along with any amount you could put towards the loan on top of the EMI?"; the client answers "I could probably put around 3,000 more", and v2 runs the plan on ₹10,488.62: "Adding ₹3,000 a month on top of the EMI clears the loan in 12 months instead of 17".
- On the whole task, `extra-payment-plan` passed in exactly the 13 conversations where ₹3,000 a month came up in the client's messages (v1 5 of 10, v2 8 of 10). In all five v1 trials that failed this check v1 chose the extra itself (₹2,000 in four, ₹1,011 in one); so did v2 in its two (₹2,000). Part of this runs through the simulated client, which reveals the fact unevenly: it did not answer v1's "How much could you put towards the loan each month beyond the EMI?" in `t_0mw38a1yo2bb2711bbfafd20c`.

**2. v1 sums a total in its head, then feeds it to a tool (convo-job-loss, 3 → 4).**

- v1 `t_0mw38a1yof437508492e0e351`, fail: "Monthly essentials from your October records: about **₹56,614**. That covers rent ₹22,000, EMIs and card minimums ₹18,332.50, groceries ₹8,086, …". The ₹8,086.25 is two grocery rows (₹6,840.75 + ₹1,245.50) added without a tool and then passed to `add`. Grader: "₹56,614 (add's input 8,086.25 is not supported) … ₹59,114 (add's inputs 8,086.25, 6,880 and 14,120 are not supported)", 5 of 31 figures. Cause: made_up_arguments. `t_0mw38a1ypa3dc2db42fa2753c` fails the same way.
- v2 `t_0mw38a1yo6650fdbae27557f9`, pass. It asks for "your typical monthly grocery spend", the client says "Groceries are usually around ₹7,000 a month", and `add([18332.5, 22000, 7000, 4400])`, every input from a tool, the client file or the client, gives "Your ₹60,000 covers one full month at ₹51,732.50 (EMIs and card ₹18,332.50, rent ₹22,000, groceries ₹7,000, medicines at the higher ₹4,400 month)."
- Only partly fixed: v2 still wrote ₹8,086.25 with no source in 3 of its 6 failures on this task (for example `t_0mw38a1yo54166542ec5ed67c`).

**3. v1 rounds a correct figure in prose (convo-consolidation, 2 → 5).**

- v1 `t_0mw38a1yo7deaf8b8aa0e2c5e`, fail on 1 figure of 48: "Keeping the card and paying minimums costs ₹1,47,428 in total. That's a saving of about ₹16,000." The saving is right (₹1,47,428 − ₹1,31,383 = ₹16,045), but rounded with no tool, so nothing verifies it. Grader: "1 of 48 amount(s) … have no tool result, client-file number or user message behind them: ₹16,000". Cause: unsupported_figure. "About ₹12,000" and "about ₹37,000" sink `t_0mw38a1yoe188e0bac1180f08` (job-loss) the same way.
- v2 `t_0mw38a1ynef3e074be7a32d88`, pass. It calls `subtract(147428.25, 106905.36)` and writes the result: "The loan costs ₹1,06,905.36 in total, which is ₹40,522.89 less, before any processing fee." This is v2's rule: "Write the number the tool returned … Never write 'about' … before an amount you worked out yourself."

**Across the run** (`GET /api/experiments/e_0mw38a1ym89666c6ccc6bfd13/compare`): figures written without a tool and verified by recomputing them fell from 215 to 98 (2.15 to 0.98 per trial); `add` calls rose from 31 to 91 and `subtract` from 64 to 156; tool calls per trial from 4.82 to 6.43 (+1.61, interval +0.68 to +2.67). Primary causes: made-up arguments 14 → 8, unsupported figure 22 → 17. 16 of v2's 27 failures had a single unsupported amount, against 4 of v1's 36 (counted from each trial's `checks.json`).

**Counter-example: a grader artefact.** v1 `t_0mw38a1ypd590d04a27189624` (convo-consolidation), fail: `multiply([84250, 0.42, 0.0833333333])` = 2,948.75, "about ₹2,949 a month in interest at the current rate", the card's correct monthly interest at 42%. The provenance check accepts a rate that a source holds or that the answer writes as a percentage ("42%"), not the same rate as a fraction, so: "₹2,949 (multiply's inputs 0.42 and 0.0833333333 are not supported)", cause made_up_arguments, which is wrong here. `t_0mw38a1yn5e0697b876ccf21d` makes the same calculation but also writes ₹800 and ₹25,860 with nothing behind them, so it fails either way. Over the run, 5 v1 and 2 v2 failures contain such a figure, and it is the only reason for 1 v1 failure (this one) and 2 v2 failures (`t_0mw38a1yo5e18427f65f5a378`, `t_0mw38a1yoc843064ed31bbba7`), all on convo-consolidation. It costs v2 one more pass than v1, so it does not explain the +9 (`docs/known-limits.md`, Platform checks).

## Conclusion

Rishi to write.

## Deviations

Anything changed after the plan was committed, and why.

- **A sensitivity analysis added after the results (5 Nov), not a change to the verdict.** Prompted by the survey of other eval tools (`docs/research/evals-landscape.md`), the per-task differences were also tested the way Miller (2024, "Adding Error Bars to Evals") recommends, with a paired t-test on the task differences (+30, +30, +10, +10, +10 and five zeros): mean +9.0 points, standard error 3.79, t(9) = 2.38, two-sided p = 0.041, 95% t interval +0.4 to +17.6. Under that test the result would read "better"; under the pre-registered exact sign-flip test it is p = 0.0625, "no detectable difference". The pre-registered verdict stands. The two tests disagree because the exact test treats the five tied tasks as carrying no information and cannot go below 2/2^5 with five informative tasks, while the t-test uses the size of the differences and leans on a normal approximation with ten tasks. Both say the same about direction and size; they differ only on whether 1 in 16 or 1 in 24 counts as rare enough.
