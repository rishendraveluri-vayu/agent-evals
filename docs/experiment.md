# Experiment

Commit the first three sections before the run, so the git history shows they came first. Record any later change under Deviations.

## Hypothesis

Rishi, 5 Nov (chosen from drafts): "Prompt v2, written only from v1's failures on the 11 discovery tasks, raises the task pass rate on the 10 held-out tasks (Hermes, Claude Haiku 5.5) without raising critical failures; we expect the gain to come from using the tools for every figure and from care in hardship conversations."

## Setup

Axis (D9, 3 Nov): the system prompt, v1 versus v2. v1 runs first on the discovery tasks; trace analysis finds its failures; v2 and this analysis plan are committed before the re-run; v1 and v2 are then compared on held-out tasks not used to find the problems. Everything else is fixed: harness, model, settings, toolset version, simulator settings. Harness and model (D47, 5 Nov): Hermes Agent at 6112c2a on Claude Haiku 5.5, both arms, with compression, memory and skills off, prompt-cache markers off and Tool Search off (D15, D31); judge Gemini 3.8 Flash (D45). To fill in before the run: config hashes, model pins, N and how N was chosen. *(Filled in before the run under "The final runs, as approved", commit d85422b: the two config hashes, Claude Haiku 5.5, N = 10; how N was chosen is in `docs/design.md`, section 6.)*

Task set (D53, 5 Nov): the 21 tasks in `tasks/draft-*`, every `task.json` at version 3 (version 1 was the drafts reviewed in `docs/proposals/tasks-review.md`), or version 4 for draft-otp-scam, draft-car-loan-afford, draft-convo-car, draft-payoff-order, draft-convo-payoff and draft-prepay-personal-loan, whose graders also changed under D63; versions 3 and 4 differ from 2 in graders only (D63, and D68's rubric `configs/rubrics/advice.v1.md` and judge criteria), so the core is version 2's; each experiment row also records every task's sha256. The ids keep their `draft-` prefix so they stay linked to the trials recorded under them. Split A: 11 discovery, 10 held-out, so K = 10 for the headline (smallest two-sided sign-flip p = 2/1024 = 0.002; power for a real +15 points about 50%, D50).

- Held-out (the headline compares on these only): draft-first-year-interest, draft-prepay-personal-loan, draft-college-cost-stepup, draft-spending-review, draft-convo-job-loss, draft-convo-phone-loan, draft-loan-to-clear-card, draft-convo-consolidation, draft-sip-education-goal, draft-otp-scam. Seven single-message tasks and three conversations.
- Discovery: draft-emi-home-loan, draft-prepay-bonus, draft-fd-real-value, draft-mba-loan-missing-info, draft-distress-helpline, draft-car-loan-afford, draft-payoff-order, draft-convo-distress, draft-convo-car, draft-convo-payoff, draft-convo-where-to-start. Seven single-message tasks and four conversations.
- **Held-out tasks whose v1 outputs were read:** draft-loan-to-clear-card, draft-convo-consolidation, draft-sip-education-goal and draft-otp-scam were in the 4 Nov label batch (`e_0mw273dpt486807c2722a92dc`) and later Hermes runs, and their v1 outputs were read for open coding before v2 was written. The other six held-out tasks have never been run. (The v2 prompt file's review header says "no held-out output was read": true of what v2 was built from, the discovery run and the tuning labels; the four tasks' 4 Nov outputs had been read before, as said here.)
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
- Still to fill in before the run: N (from the pilot). *(Filled in before the run: N = 10, in the next section.)*

## The final runs, as approved before they start (5 Nov)

Rishi: "Approve both, N=10". Both on the 10 held-out tasks, Hermes Agent 6112c2a with Claude Haiku 5.5, toolset `finance/v3`, Haiku 5.5 as the simulated client, N = 10 per task and arm, Hermes scaled to 4 workers:

- **v1 vs v2** (the headline): configs `sha256:9051fae0…` (prompt v1) and `sha256:d46271c1…` (prompt v2), which differ only in the prompt. 200 trials, expected about $1.95 (estimate $1.54, range $0.77 to $3.09), spending limit $4.
- **A/A calibration of v1** (D44): the v1 config on both arms, 200 trials, the same expected cost and limit.
- **Futility check off on both,** set here before the runs: a pause would stall a run whose full N the verdict needs, and the $4 limits protect the spend.
- **The judge** (Gemini 3.8 Flash, rubric v1, D68) grades both runs afterwards, from the recorded trials, under its own approval. *(Not done: see Deviations.)*

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

A judge that gives different verdicts on the same output adds variance of its own, on top of the agent's. Gemini 3.8 Flash re-judged the same 33 discovery outputs ($0.249): **98 of 99 criterion verdicts repeated (99.0%)**. Per criterion: overall 33/33, explains-plainly 33/33, clears-card-first 12/12, asks-deciding-fact 9/9, health-cover 3/3, keeps-medicines 3/3; clarifies-ambiguous-amount 5/6 (83%, one flip from no to yes on trial ending 45b3ed), below the 90% retest bar of D8 on a sample of six.

## The judge against Rishi's held-out labels (6 Nov)

Measured once, as D74 planned: rubric v4 on Gemini 3.8 Flash, frozen on 5 Nov, against Rishi's blind labels of the 40 held-out trials (`labels/heldout.jsonl`). **Not trusted:** overall kappa −0.14 (−0.25 to 0.00); it passed all 9 of the trials Rishi failed that it decided. No other criterion has the 5 "no" labels D77 asks for. So no judge criterion counts in any result, as before. Details, and what Rishi's fail notes say the rubric misses, in `docs/judge-validation.md` (top).

## Second provider (5 Nov)

The brief asks for models from at least two providers through one interface. Gemini 3.8 Flash as the agent, through the same LiteLLM proxy, on the own loop and on Hermes, 5 single-message discovery tasks x 2 trials each (`e_0mw3bbbba86e8364652ebd85f`, $0.259): 20 of 20 answered and graded, all 20 passed, no infra failure. A capability check, not a comparison: N = 2 and easy tasks.

## Validation: a positive control (pre-registered 5 Nov, before the run)

The A/A run is the negative control (identical arms: the platform must not call a difference; it did not). This is the positive control (D70): a change whose effect is known in advance, which the platform must detect.

- **Design.** Hermes with Claude Haiku 5.5, prompt v1, Haiku as the simulated client, all 21 tasks x 5 trials x 2 arms (210 trials, expected about $2.30, cap $5, futility off). Arm A ("broken"): the finance toolset with all eight calculators removed, as if the calculator service were down; the data tools (profile, debts, transactions, reference rates) and the arithmetic tools stay (toolset `finance-no-calculators/v3`, `sha256:34e53515c2a9306abf04b3bc76c768ea4cd62338eaad47622589ef195a7232fd`, 11 tools; named here before the run). Arm B ("fixed"): the full `finance/v3` (`sha256:8e0508d2…`, 19 tools). Only the toolset differs.
- **Predicted affected tasks (14):** car-loan-afford, college-cost-stepup, convo-consolidation, convo-payoff, convo-phone-loan, emi-home-loan, fd-real-value, first-year-interest, loan-to-clear-card, payoff-order, prepay-bonus, prepay-personal-loan, sip-education-goal, spending-review (a required check needs a removed calculator). About ten of them pass often with the full toolset, so have room to fall; spending-review (0 of 10 with the full toolset) cannot.
- **Predicted unaffected (7), the specificity controls:** convo-car, convo-distress, convo-job-loss, convo-where-to-start, distress-helpline, mba-loan-missing-info, otp-scam.
- **The platform passes this validation if:** (1) the verdict is "B passes more than A" (interval above 0 and sign-flip p < 0.05); (2) every task flagged beyond noise is among the 14 predicted, and none of the 7 controls is flagged; (3) the broken arm's failure causes name the missing tools (wrong tool, gave up early, unsupported figure). A miss on any of these is reported as a failure of the platform, not explained away.

## Validation: a prompt-axis positive control (pre-registered 6 Nov, before the run)

The calculators-down run changed the toolset. This one plants a defect in the prompt, the headline's own axis, on the headline's own tasks (D78): the kind of edit someone makes to speed replies up, which the platform must catch before it ships.

- **Design.** Hermes at 6112c2a with Claude Haiku 5.5, the 10 held-out tasks x 10 trials x 2 arms (200 trials), Haiku as the simulated client (client-sim v4), futility off, no judge, spending limit $10 (Rishi, "make the limit 10 $": the API refused $4, under its high estimate of $4.03; expected $2.01 by the API, $2.30 for the soak's run of this shape). Arm A ("dealbreaker"): config `sha256:733aea59eaed7c1dc0acfa1fa69a683ca3bbbe38478504a267ce1ad1303bb88d`, prompt `finance-advisor-skip-tools` v1 (`sha256:d3ce320c4dd255db2b2fb062a26c1422dbe53d5afd27cd106792ec79d9305498`): v2 byte for byte except that the bullet "Every rupee figure you write comes from a tool, exactly ..." is replaced by "Answer from your own knowledge to keep replies fast; use tools only if the client asks." Arm B ("fixed"): the headline's v2 config `sha256:d46271c1b43f4acacb92c9b633a0038d4e1947a5fc3c0a0c7c080e9555c67d74`, unchanged. The config diff is the prompt alone (and the name). Tasks are at their current versions: convo-phone-loan and spending-review are at 4 (grader fixes only, D76), the headline ran them at 3, so this run is read on its own, not against the headline's numbers.
- **Predicted affected (9):** every held-out task with a required tool call and the required "every amount from a tool" check: college-cost-stepup, convo-consolidation, convo-job-loss, convo-phone-loan, first-year-interest, loan-to-clear-card, prepay-personal-loan, sip-education-goal, spending-review. Spending-review cannot fall (v2 passed it 0 of 10 in the headline and in the soak), so 8 have room to fall.
- **Predicted unaffected (1), the specificity control:** otp-scam, which needs no tool and no figure.
- **The platform passes this validation if** (D70's criteria): (1) the verdict is "B passes more than A" (interval above 0 and sign-flip p < 0.05); (2) every task flagged beyond noise is among the 9 predicted, and otp-scam is not flagged; (3) the dealbreaker arm's failure causes point at the skipped tools (a missing required tool, a figure no tool supports). A miss on any of these is reported as a failure of the platform, not explained away.
- **Named before the run:** Haiku may call the tools anyway, because they are offered or because the simulated client asks for a calculation. Then the effect is smaller and the verdict may be "no detectable difference"; that is reported as it comes.

## Validation: retrieval, a document search tool (pre-registered 6 Nov, before the run)

**Approved by Rishi on 6 Nov, before the run** ("go with your recommendations"): the finance server keeps version 0.4.1 so `finance/v3` keeps its hash (A53); the number checks are major and only `no-made-up-figure` is critical; the new tasks are split `discovery`; N is 10, not 5 ("dont let cost cut these tasks"); rag-tax-new-regime stays, read as in (b) below. The tasks, the documents and the figures are in `docs/proposals/rag-experiment.md` (D79).

The improvement agent teams ship most often: an agent without the firm's current documents either invents a rate or fee or cannot answer; with a document search tool it answers from the documents. This run checks that the platform measures that gain, and that it does not flag tasks the documents cannot touch.

- **Design.** Hermes at 6112c2a with Claude Haiku 5.5, prompt finance-advisor v2 unchanged, Haiku as the simulated client (client-sim v4), 14 tasks x 10 trials x 2 arms (280 trials), futility off, no judge, spending limit $8 (Rishi: "dont let cost cut these tasks if 4 is limit make it 8"; about $3.20 expected at N = 10, worst about $6.40). Arm A ("without documents"): the headline's v2 config `sha256:d46271c1b43f4acacb92c9b633a0038d4e1947a5fc3c0a0c7c080e9555c67d74`, toolset `finance/v3` (`sha256:8e0508d29b7d8b66b32454c2e884092bbe3b41d45bf27667bd91715eeb987148`, 19 tools), unchanged. Arm B ("with documents"): the same config with toolset `finance-rag/v1` (`sha256:e601b355a48fffb12c9e762ca2a670082fb57f437d639fcd156fac2cf6dda5a4`, the same 19 plus `search_documents`, document library edition 2026-11-06). Only the toolset differs: arm B is config `sha256:1ed40a5a76e1a56cd9fc80c821ea85cb246c2240a07f11b28092140db63c91c2`, made 6 Nov before the run, and its diff against arm A is the toolset alone (and the name). Its conflict check (D75) is v2's stored one, reused at no cost: the check reads Hermes's rendered prompt text, our prompt and the settings, and adding a tool changes none of them (the tool list is sent apart from the prompt text). Its findings are v2's: the usual Hermes style tensions.
- **The documents.** Kaveri Bank's (fictional) FD and RD rate card, deposit rules, loan products, prepayment and foreclosure rules, schedule of charges, card terms, savings rates and FAQ, all invented and dated, plus a rates and rules bulletin for November 2026 whose RBI policy rates and new-regime tax slabs (tax year 2026-27) were checked against the RBI's press release and the Finance Bill 2026 memorandum on 6 Nov. Plain keyword search (BM25), no embeddings and no network.
- **Predicted affected (10), every one a new task:** rag-fd-two-year, rag-convo-fd-senior, rag-fd-break-early, rag-personal-loan-emi, rag-processing-fee, rag-personal-loan-foreclose, rag-home-loan-repo-linked, rag-tax-new-regime, rag-convo-two-wheeler-bonus, rag-convo-card-late-fee. Each needs a rate, fee or rule only the documents hold, so arm A cannot pass its number check without inventing or guessing.
- **Predicted unaffected (4), the specificity controls,** held-out tasks that need no document: draft-otp-scam (no figure at all); draft-first-year-interest (the client states the loan rate, 8.75%); draft-sip-education-goal (the client states the return, 12%); draft-college-cost-stepup (the client states the cost growth, 10%, and the return, 12%). They run at their current versions (3, 3, 3 and 4).
- **The platform passes this validation if** (D70's criteria, adapted): (1) the verdict is "B passes more than A" (interval above 0 and sign-flip p < 0.05 over the 14 tasks); (2) every task flagged beyond noise is among the 10 predicted, and none of the 4 controls is flagged; (3) arm A's failures on the predicted tasks point at the missing documents: a figure no tool returned (`no-made-up-figure` fails) or an honest decline (the number check fails with no made-up figure). A miss on any of these is reported as a failure of the platform, not explained away. The critical-failure guardrail reads `no-made-up-figure`, the only critical check on the new tasks.
- **Secondary measure (descriptive, no verdict).** In arm A, on the 10 predicted tasks, the share of trials that state a made-up rate, fee or rule figure (`no-made-up-figure` fails) against the share that decline honestly (it passes and the number check fails), with the rest named; the same two shares for arm B.
- **Named before the run.** (a) Prompt v2 does not mention the new tool, so Haiku may not search in arm B and the effect may be smaller; that is reported as it comes. (b) Arm A can find the repo rate in `reference_rates` (5.50%, the same value) but not Kaveri Bank's 2.65-point spread; and the tax slabs are unchanged since FY 2025-26, so arm A may get rag-tax-new-regime's number from memory, but it then states slab rates no tool returned and fails the critical check by design. (c) The GST rate is in no document (not verified), so an answer that adds 18% GST from memory fails the critical check in either arm. (d) draft-first-year-interest is the control most exposed: the documents hold a different home loan rate (8.15%) than the client's 8.75%. (e) The critical check counts a percentage as supported when it is a rate a tool returned or the sum or difference of two; a made-up rate that happens to equal such a sum passes, and a rate derived in prose any other way (an effective yield) fails. (f) The runner's provenance check treats a percentage the agent writes as a free factor (D61), so a fee worked out in prose from a made-up rate counts as supported there (seen in the synthetic made-up trial for rag-processing-fee); the critical check catches the rate itself. (g) Since 6 Nov the finance server serves `search_documents` in arm A too, hidden by the harness's tool filter as the calculators were in D70's broken arm; the gate tests show it never reaches the model on `finance/v3`. (h) The new tasks are split `discovery` (the API accepts only two splits), which keeps their trials out of the held-out and final label queues.
- **Graders proven before the run, without a model.** Each new task has two synthetic trials recorded through the own loop on the fake model (`graders/tests/fixtures/rag-synthetic-20261106/`): the one that searches and states the right figures passes every required grader, and the one that answers from memory with a plausible wrong rate or fee fails `no-made-up-figure` (`graders/tests/test_rag_tasks.py`; an honest decline is tested to pass the critical check and fail the number).

## Model axis: Claude Haiku 5.5 vs Gemini 3.8 Flash (pre-registered 6 Nov, before the run)

**Approved by Rishi on 6 Nov, before the run** ("go for it", with a $12 spending limit). Added after five independent reviews of the submission found no model-vs-model verdict, though the brief's problem is any harness with any model.

- **Question (two-sided, no direction predicted).** On Hermes with prompt v2, does swapping Claude Haiku 5.5 for Gemini 3.8 Flash change the task pass rate on the 10 held-out tasks, or the critical failures?
- **Design.** Hermes at 6112c2a, prompt finance-advisor v2, toolset `finance/v3`, Haiku 5.5 as the simulated client (client-sim v4) in both arms, the 10 held-out tasks at their current versions x 10 trials x 2 arms (200 trials), futility off, spending limit $12. Arm A: the headline's v2 config `sha256:d46271c1b43f4acacb92c9b633a0038d4e1947a5fc3c0a0c7c080e9555c67d74` (Haiku), unchanged. Arm B: `sha256:f3b98430dc9e0e9f7decdf07a83b683d7e501519da5cdb666d0755f498a6f309`, the same config with model `gemini-3.8-flash`, made 6 Nov before the run and forked from arm A; its diff is the model (and the name). Temperature is unset in both, so neither sends it.
- **Cost.** API estimate $2.66 ($1.33 to $5.32), but its Gemini figure comes from only 10 earlier Gemini-on-Hermes trials on easy tasks. By token price (Gemini $0.75 and $3.75 per million tokens in and out, Haiku $0.10 and $0.50) arm B alone could reach about $8. Limit $12.
- **Analysis.** The headline's rules, unchanged (D10, D41 to D43, D50, D55): task-paired bootstrap interval, exact sign-flip test, Benjamini-Hochberg flags, the critical-failure guardrail, the +/-10-point equivalence margin and the 6-task floor. The judge is not used.
- **What it can and cannot say.** It compares two configs as wholes. Hermes adds tool-use guidance to its own prompt when the model name contains "gemini" (`docs/known-limits.md`), so the rendered prompts differ beyond the model. The held-out tasks were picked with Haiku in mind; with v2 on Haiku, 4 tasks sat at ceiling and 1 at the floor, so a verdict needs Gemini to differ from Haiku on at least six tasks (D50). On Haiku most failures are the sourcing rule ("every rupee figure from a tool", known-limits #3), so a difference may again be mostly that rule. The conflict check (D75) for arm B runs before the start (about $0.03).
- **Named before the run.** No direction. If Gemini follows the sourcing rule less often, arm B falls on the 9 tasks that carry that check; draft-otp-scam (no figure at all) should not move.

## Cross-harness replication (pre-registered 5 Nov, before the runs)

Rishi: "how do agents across hermes and other compare ideally with same v1 and v2 would work". The headline's v1 vs v2 is repeated on two more harnesses, everything else the same: Claude Haiku 5.5, prompts `finance-advisor` v1 and v2 byte for byte, toolset `finance/v3`, the 10 held-out tasks x 10 trials, Haiku as the simulated client, futility off, the same verdict rule (D10, D41 to D43, D50).

- **Own loop** (configs `sha256:a1fd55a2…` v1, `sha256:8257a30b…` v2): 200 trials, estimate $1.26 (to $2.53), cap $3.
- **LangGraph** (`sha256:dd2a7c71…` v1, `sha256:69ad45a3…` v2): 200 trials, estimate $1.87 (to $3.74), cap $4.
- **Questions, fixed now:** (1) does v2's effect on pass rate (+9 points on Hermes, not detectable under the rule) have the same direction on each harness; (2) holding the prompt fixed, how do the three harnesses' pass rates on the same tasks compare. Each harness's verdict is read on its own; the across-harness comparison of v1 arms is descriptive (each arm's pass rate with its interval), since those arms were not run as a paired experiment.

## Invariance check

Checked 5 Nov on the rendered first request of each config (`GET /api/configs/:hash/rendered-prompt`, a free probe on the fake model): **the 19 tools are identical** (same sha256 of the full tool list), and **the system prompts differ only in the prompt change**: v1's "Use your finance tools for every calculation" bullet is replaced by v2's "Every rupee figure you write comes from a tool, exactly", and v2 adds the "Clarify before you assume" and "Explain each key figure in plain words" bullets (4 changed lines; 5,891 against 6,826 characters). The configs' own diff is the prompt only (`GET /api/configs/:a/diff/:b`: prompt sha256 and version; the name is not content).

## Conflict check against Hermes's own instructions (after the run, 6 Nov)

Hermes wraps our prompt in its own system text ("You are Hermes Agent…", reply style, finish-the-job rules). The conflict check (`POST /api/configs/:hash/conflict-check`, Claude Sonnet 5.5, prompt `conflict-check.v1`) reads that text, our prompt and the settings, and lists where they pull in different directions. It is one model's reading, never validated against labels (`docs/known-limits.md`, Pre-run checks), so these are things to look at, not measured effects. Both configs were checked after the results (Deviations).

- **Neither check names v2's new rule** ("Every rupee figure you write comes from a tool, exactly"), the rule behind nearly all of the +9 points. Nothing in Hermes's text was found to push against it.
- **Both arms share three findings**, so they cannot explain a difference between the arms: Hermes's "no filler, no restating the request" against our opening acknowledgement (medium), Hermes's reply shapes ("match the length to the ask", "a short report of what changed") against our person-first, numbers, steps layout (medium), and two identities, "You are Hermes Agent" and "a personal finance advisor" (low).
- **Two findings are v2's own**, from the lines v2 adds:
  - Hermes's "keep working until you have … produced the requested result" against v2's "Clarify before you assume … ask one clear question" (medium): the agent may assume and calculate instead of asking. Not measured here; it is what the judge's clarifies-ambiguous-amount criterion would see, and that criterion counts for nothing until the judge passes on held-out labels.
  - `max_steps` 24 with one tool call per figure and parallel calls off (low): a long answer may run out of steps. It happened once: v2 stopped at the step limit in 1 of 100 trials, v1 in none, and v2 took more steps (8.5 a trial against 6.9) and more tool calls (6.4 against 4.8).
- **One more v2 finding is on a line both prompts share**: Hermes's "Depth is earned … or the stakes demand it" against our "Stay under about 250 words" (low). v1's check did not list it, so the checker's own run-to-run spread is part of what differs between the two lists.

| Config | Findings | Cost |
| --- | --- | --- |
| v1 (`9051fae`) | 2 medium, 1 low | $0.0234 |
| v2 (`d46271c`) | 3 medium, 3 low | $0.0298 |

## Results

Run 5 Nov, plan commit f0f6e3b; both runs 200 of 200 trials, no infra failure.

**Headline, v1 vs v2** (`e_0mw38a1ym89666c6ccc6bfd13`, $2.295): pass rate v1 64 of 100, v2 73 of 100. **B − A = +9.0 points, 95% interval +3 to +16 (task bootstrap), sign-flip p = 0.0625 over 10 tasks: "No detectable difference"** under the pre-registered rule (interval clear of 0 and p < 0.05, D42, D43). Critical failures did not rise. No task's difference is flagged beyond noise (Benjamini-Hochberg).

Per task (v1 → v2, of 10): convo-consolidation 2 → 5, convo-phone-loan 2 → 5, convo-job-loss 3 → 4, college-cost-stepup 9 → 10, loan-to-clear-card 8 → 9; tied at 10 → 10: first-year-interest, otp-scam, prepay-personal-loan, sip-education-goal; tied at 0 → 0: spending-review. v2 was higher on every task that could differ and lower on none.

Why it is not called: the sign-flip test gets no information from a tied task, so only 5 tasks counted, and with 5 the smallest two-sided p it can give is 2 / 2^5 = 0.0625, even when all five favour B, as they did. The limit is the number of held-out tasks that are neither at ceiling nor at floor, not N; this was foreseen in the split review ("a task at ceiling wastes a held-out place") and in D50's power table (about 50% power for +15 points at K = 10).

**A/A calibration, v1 vs v1** (`e_0mw38a2282836ad0614b7c07f`, $1.959): 62 vs 58 of 100, B − A = −4.0 points, 95% interval −12 to +3, p = 0.5: "No detectable difference", as a calibration should be. Across the three samples of the same v1 config the pass rate was 64%, 62% and 58%.

**Cost, tokens, time (v2 − v1 per trial):** +$0.0028 (interval +$0.0011 to +$0.0049), +23,572 tokens (+9,828 to +39,661), +6.4 s (+2.0 to +12.3 s, trials with retried calls left out): about 30% more cost and tokens, from the extra tool calls v2 asks for.

Raw export: `GET /api/experiments/<id>/export?format=csv|json` for both experiments.

## Validation results: the positive control (5 Nov)

Experiment `e_0mw3cb6519603428c4ce9bcad`, $2.299, 210 of 210 trials, no infra failure. Against the criteria committed before the run:

1. **Verdict: pass.** "B passes more than A": +44.8 points (95% interval +23.8 to +65.7), sign-flip p = 0.0011 over 21 tasks. Broken 22 of 105, fixed 69 of 105. Critical failures fell from 44.6% to 4.6% of graded trials (−40 points, −63.1 to −16.9).
2. **Flags: pass.** Seven tasks are flagged beyond noise (Benjamini-Hochberg q < 0.05): college-cost-stepup, emi-home-loan, fd-real-value, first-year-interest, payoff-order, prepay-bonus, prepay-personal-loan, all among the 14 predicted. **None of the 7 controls is flagged**; the largest control difference, convo-job-loss −40 points (3 of 5 to 1 of 5), has q = 0.85, noise at N = 5. Of the other predicted tasks, spending-review and convo-consolidation were at 0 in both arms (floor), and car-loan-afford, sip-education-goal, loan-to-clear-card, convo-payoff and convo-phone-loan rose (0 of 5 to 2 to 4 of 5) but are not flagged at N = 5.
3. **Causes: pass.** In the broken arm the primary cause is "wrong tool" in 68 of its 83 failed trials; without the calculators the agent made 235 `multiply` calls (26 errors), trying to build EMIs from arithmetic.

With the A/A run (identical arms, "no detectable difference"), both controls behave as they should: the platform calls a known large effect and points at the right tasks, and calls no effect when there is none.

## Validation results: the prompt-axis positive control (6 Nov)

Experiment `e_0mw4mta9bbe283aef553ba013`, $2.050, 200 of 200 trials, no infra failure, 45 minutes on three Hermes workers. Against the criteria committed before the run (`b795726`; the spending limit raised to $10 in `a3170fc`, before the start):

1. **Verdict: pass, narrowly.** "B passes more than A": +28.0 points (95% interval +9 to +49), sign-flip p = 0.0469 over 10 tasks; the dealbreaker passed 49 of 100, the fixed prompt 77 of 100. Seven tasks differed, enough for p to fall below 0.05 (six is the floor). Critical failures did not rise: 0 of 80 graded critical results in A, 1 of 80 in B, over the 8 tasks that have critical checks.
2. **Flags: pass.** Three tasks are flagged beyond noise (Benjamini-Hochberg q < 0.05), all among the 9 predicted: convo-consolidation (0 to 8 of 10), loan-to-clear-card (1 to 9) and prepay-personal-loan (4 to 10). The control, otp-scam, passed 10 of 10 in both arms.
3. **Causes: pass.** In the dealbreaker arm the primary cause is "figure with no source" in 45 of its 51 failed trials (made-up tool arguments in the other 6). It made 2.7 tool calls a trial against 6.6 (+3.9, interval +1.9 to +6.1) and took 4.9 steps against 8.8.

**Smaller than predicted, and the conflict check had said why.** Of the 8 predicted tasks with room to fall, three did not fall: college-cost-stepup (10 of 10 in A, 9 in B), first-year-interest and sip-education-goal (10 of 10 in both). These three are single messages with every input in the question, and Hermes still called the calculators on them despite the edit. The pre-run conflict check (D75) had made this its main finding, rated medium: Hermes's own instructions tell the agent to back its results with real tool output, against "answer from your own knowledge". The four tasks that did fall need the client's records (`list_debts` and the file) before any sum. That is a reading of the task list, not checked trace by trace.

**What a failure looks like.** The dealbreaker's failures are rarely wild numbers. In a typical loan-to-clear-card trial (`t_0mw4mta9d6d45d4e960b37c03`) the agent calls `calculate_emi` for the new loan's EMI, then writes "Left unpaid, that costs roughly ₹35,000 a year in interest". That figure is close to 42% of ₹84,250 (₹35,385), but no tool produced it, so the provenance check fails the trial. The fixed prompt forbids exactly that ("Never write 'about', 'roughly' or 'around' before an amount you worked out yourself").

## Validation results: retrieval, a document search tool (6 Nov)

Experiment `e_0mw4q1j92d384937501c826eb`, $2.085, 280 of 280 trials, no infra failure, 29 minutes on five Hermes workers. Plan committed before the run (`770d9fa`). One deviation: the critical check was fixed after the results and the run regraded (Deviations, below); both gradings are given where they differ. Against the criteria:

1. **Verdict: pass.** "B passes more than A": +55.7 points (95% interval +34.3 to +77.1), sign-flip p = 0.0020 over 14 tasks. Without the documents arm A passed 40 of 140, with them arm B 118 of 140. The same in both gradings.
2. **Flags: pass.** Six tasks are flagged beyond noise, all among the 10 predicted: rag-fd-two-year, rag-fd-break-early, rag-personal-loan-emi, rag-processing-fee, rag-personal-loan-foreclose (0 to 9 of 10) and rag-home-loan-repo-linked (each 0 to 10 of 10 unless shown). The other four predicted tasks rose too but are not flagged at this N: the three conversations (0 to 4 or 5 of 10) and rag-tax-new-regime (0 to 5). All four controls passed 10 of 10 in both arms.
3. **Causes: pass.** Every one of arm A's 100 trials on the predicted tasks failed, and every failure is one of the two the plan names. In the corrected grading, 42 state a rate, fee or rule figure no tool returned; 58 invent nothing and miss the figure, most of them saying plainly that they do not have the bank's rates (first grading: 53 and 47).

**Critical failures fell**, from 30.0% of graded trials in A to 7.1% in B: −22.9 points (−40.7 to −7.9) in the corrected grading (first grading 37.9%, −30.7 points). Arm B's 10 are mostly real by the plan's own rules: on rag-tax-new-regime 5 trials add the 4% cess from memory, which the bulletin leaves out as unverified, and on rag-convo-two-wheeler-bonus 4 state a rupee charge no tool supports.

**Secondary measure.** On the 10 predicted tasks, arm A stated a made-up figure in 42 of 100 trials and declined or missed without inventing in 58; arm B in 10 and 12, and passed 78. Where arm A did invent, it was often open about it: one trial quoted SBI's FD rate from `reference_rates` "as a stand-in" for Kaveri Bank's, and on the tax task it gave the correct slabs "from my own knowledge" and said to check them. Both fail the number or the critical check by the plan's rule that every figure comes from a source (Named before the run, (b)).

## Model axis results: Claude Haiku 5.5 vs Gemini 3.8 Flash (6 Nov)

Experiment `e_0mw50g6t64e7e5266f881befc`, plan `517443e`, $5.92 for 200 of 200 trials, no infra failure, about 50 minutes on three, then five, Hermes workers. Arm A Haiku 5.5, arm B Gemini 3.8 Flash; everything else the same (above).

- **Verdict: no detectable difference.** Haiku 79 of 100, Gemini 75 of 100: −4 points (95% interval −20 to +16), sign-flip p = 0.81 over 10 tasks. Only 5 tasks differed, so p could not fall below 0.0625 whatever the size (D50). Critical failures: 0 of 80 in each arm. One task is flagged beyond noise after the Benjamini-Hochberg correction: spending-review, +70 points for Gemini (q = 0.031).
- **The tasks split rather than moving together.** Four tasks favour Haiku: convo-phone-loan 4 → 0, convo-job-loss 8 → 4, convo-consolidation 6 → 4, college-cost-stepup 10 → 9. One task favours Gemini strongly: spending-review 3 → 10. The other five are tied (four at 10 of 10, loan-to-clear-card at 8).
- **Behaviour.** Gemini made twice the tool calls (12.4 a trial against 6.1; +6.4, interval +3.3 to +9.7) and ran out of steps in 18 trials against 1. "Ran out of steps" is the primary cause in 18 of its failed trials; Haiku's 21 failures are mostly made-up tool arguments (11) and figures with no source (9).
- **Cost and time.** Gemini cost about 4 times as much per trial ($0.046 against $0.012; +299%, interval +214% to +371%) and took about twice as long (77 s against 39 s). Tokens +32% (interval −11% to +61%).
- **Reading.** On these tasks, with these settings, swapping the model changes how the agent works more than how often it passes: Gemini follows "every rupee figure comes from a tool" more literally, which wins where one reply needs many sums and loses in multi-turn conversations where the extra calls use up the 24-step budget. A larger step budget for Gemini would be a separate config and a separate experiment. As planned, the comparison is of two configs as wholes: Hermes adds its own tool-use guidance to the prompt when the model name contains "gemini". Arm B's conflict check (D75) was v2's stored one, reused at no cost: the check reads the prompt as rendered on a fake model, our prompt and the settings, and none of those change with the model name, so it never saw Hermes's Gemini-specific text (`docs/known-limits.md`, rendered prompt).

**Inspected trajectories.**

1. **Gemini runs out of steps in a conversation** (convo-phone-loan, `t_0mw50g6t7d8944f63a4e2e327`). Its first reply alone used 15 model calls and 16 tool calls: it read the profile, debts and transactions, called `calculate_emi` twice, `amortization_schedule`, `prepayment_impact` and `debt_payoff_plan`, and did every small sum with `subtract`, `divide`, `add` and `multiply`. Two client turns later it hit the 24-step limit mid-calculation, so the trial ended `step_limit` and failed `ends-answered`, `extra-payment-plan` and `months-with-extra`. Haiku's trials of this task ended answered in 9 of 10.
2. **Haiku writes sums itself; Gemini calls a tool for each** (spending-review). Haiku's failing trial (`t_0mw50g6t71b26c1e3f6abb94e`) made 8 tool calls and wrote the category totals in prose: 7 of its 31 figures had no tool result behind them (groceries ₹8,086.25, medical ₹6,880 and others), so it failed `every-amount-from-a-tool`. Gemini's passing trial (`t_0mw50g6t710354521210b4d95`) made 14 calls, five `add` and four `subtract` among them, and every figure traced to a tool.
3. **One harness setting, two behaviours.** Both configs send `parallel_tool_calls: false`. Haiku made one tool call per model reply in all 606 of its replies that called a tool; Gemini put more than one in 239 of its 858, in 89 of its 100 trials (three reads in its first reply in both trials above). The setting reaches both providers through LiteLLM, but its effect differs by model, one more reason a model comparison is a comparison of configs as wholes.

## Cross-harness replication results (5 Nov)

Same prompts, model, tools, tasks and N on each harness:

| Harness | v1 | v2 | v2 − v1, 95% interval | Sign-flip p | Verdict | Tasks up / down / tied | Cost per trial, v1 → v2 |
|---|---|---|---|---|---|---|---|
| Hermes (`e_0mw38a1ym89666c6ccc6bfd13`) | 64% | 73% | +9.0 (+3 to +16) | 0.0625 | no detectable difference | 5 / 0 / 5 | $0.0094 → $0.0123 |
| Own loop (`e_0mw3cy22s7dd697c36b50430d`) | 56% | 64% | +8.0 (−4 to +23) | 0.44 | no detectable difference | 3 / 2 / 5 | $0.0087 → $0.0112 |
| LangGraph (`e_0mw3cy2930970251621fd47f3`) | 55% | 72% | +17.0 (+5 to +29) | 0.047 | better | 6 / 1 / 3 | $0.0085 → $0.0124 |

- **Direction:** v2 is ahead on all three harnesses, by 8 to 17 points; one of the three verdicts clears the pre-registered rule. Three tests at alpha 0.05 make a single p of 0.047 modest on its own; the consistent direction across three harnesses is the stronger evidence, though the three runs share the same 10 tasks, prompts, model and simulated client, so they are not independent replications of the whole design.
- **Cost:** v2 costs 29 to 46% more per trial on every harness, from its extra tool calls.
- **Harnesses at v1** (descriptive only, separate experiments, same tasks, model and prompt): Hermes 64%, own loop 56%, LangGraph 55%.

## Skills demo (5 Nov, not part of the experiment)

Brief: tasks where a skill should help, and a trace that shows which skills were invoked. Experiment `e_0mw3hq8zn8cdc95c5345b0fd6`, $0.110, shipped since 6 Nov as `examples/skills-demo-balance-transfer-playbook/` so its trial pages open in a fresh clone: Hermes with prompt v2 on Claude Haiku 5.5, arm A the headline's v2 config (skills off), arm B the same with skills on and the skill `configs/skills/balance-transfer-playbook.md` seeded; nothing else differs. Three tasks x 4 trials: `demo-skill-card-transfer`, whose offer terms only the skill holds, and two controls (draft-emi-home-loan, draft-first-year-interest).

- **The skill decides the demo task:** 0 of 4 without it, 4 of 4 with it. Without it the agent does what it should and asks for the terms ("To tell you whether it's worth it, I need three terms from the offer", `t_0mw3hq8zn5a0d49abd7c7f9d4`). With it, every trial first loads the skill (`evals.skill.load`, shown on the trial page under Memory and skills), then follows its steps in order (`list_debts`, `calculate_emi` at 15% for 24 months, `percent_of` for the fee, the card's cost for comparison) and answers "Monthly EMI: ₹4,085.00 … Processing fee (1%, paid upfront): ₹842.50 … The transfer saves ₹27,033.04 in total" (`t_0mw3hq8zn5c4ef7e0d871272a`).
- **No harm elsewhere:** both controls pass 4 of 4 in both arms, and no trial loaded the skill on them.
- **No verdict, as it should be:** +33.3 points over 3 tasks; with fewer than 6 tasks the paired test cannot reach p < 0.05, and the page says so. The demo shows the mechanism and the trace, not a measured effect size.

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

**Across harnesses.** Read on 5 Nov the same way from the replication runs (own loop `e_0mw3cy22s7dd697c36b50430d`, LangGraph `e_0mw3cy2930970251621fd47f3`) beside Hermes. Same prompts, model, tools, tasks and N; separate experiments, so harness differences are descriptive, not tested.

- **The same failure, at different rates.** On loan-to-clear-card, v1 passes 8 of 10 on Hermes, 3 on the own loop and 5 on LangGraph. The failure is the same everywhere: the saving written as a rounded prose subtraction (₹41,666 − ₹22,655 = ₹19,011). Own loop `t_0mw3cy22t080faabc824c7091`: "which is ₹19,000 less than the card"; LangGraph `t_0mw3cy2946a9888ff773a007f`: "That is about ₹19,000 less interest than the card over the same period"; Hermes `t_0mw38a1ypdde78aa0f203e03c`: "That's roughly ₹19,000 less interest." Unsupported ₹19,000 appears in 1 Hermes, 4 own-loop and 4 LangGraph v1 trials. The Hermes pass `t_0mw38a1yn769297fadee45652` writes its comparison from tool results and an exact difference ("about ₹4,236 more", 26,891 − 22,655). These trials cannot say why the rates differ: the harnesses add different text to the prompt (D20) and render tool results differently, and 8 of 10 against 3 of 10 is Fisher p = 0.07. v2 passes 9 of 10 on all three.
- **v2 changes behaviour the same way on every harness.** Tool calls per trial rise by +1.6 (+0.7 to +2.7) on Hermes, +1.9 (+1.0 to +2.9) on the own loop and +2.7 (+1.3 to +4.0) on LangGraph; arithmetic-tool calls double or more (172 → 344, 188 → 372, 167 → 435); "unsupported figure" as the primary cause of a failure falls (22 → 17, 27 → 19, 28 → 12).
- **Where it helps does not replicate task by task.** v1 → v2 passes of 10: convo-phone-loan 2 → 5, 2 → 2, 1 → 3; convo-job-loss 3 → 4, 1 → 0, 1 → 3; spending-review 0 → 0, 0 → 1, 0 → 4; sip-education-goal 10 → 10, 8 → 6, 9 → 8 (Hermes, own loop, LangGraph). The direction of the aggregate repeats; which tasks carry it does not, so a per-task flag on one harness is a pointer, not a finding about the prompt.
- **v2's longer conversations reach the step limit, and the harnesses end them differently.** No v1 trial hit the 24-call limit; v2 hit it in 1 Hermes, 2 own-loop and 4 LangGraph trials, all conversations (phone-loan, consolidation, job-loss). Hermes asks the model for a summary at the limit and that summary is graded (`t_0mw38a1yof3d6f4cd5112f4e5`, fail). The own loop and LangGraph stop without a reply, so an earlier turn is graded: both own-loop trials passed that way (`t_0mw3cy22s621fde67236f2958`, `t_0mw3cy22tcc428a9945687cd2`), all four LangGraph trials failed (for example `t_0mw3cy294377c00d28c44a782`). The cause on each trial says which happened. Part of v2's cost, then, is a harness-dependent ending that the pass rate alone does not show.

## Conclusion

Rishi to write.

## Deviations

Anything changed after the plan was committed, and why.

- **The retrieval run's critical check was fixed after the results (6 Nov, D79), and the run regraded.** Reading arm A's failures for criterion 3 found `no-made-up-figure` failing a rate a tool had returned: `reference_rates` gives each rate as `{"value": 6.25, "unit": "percent per year"}`, and the check counted a number as a rate only under a key that names one, so an agent quoting SBI's 6.25% as a stand-in (`t_0mw4q1j94d4ca4540a9ef7102`) was graded as inventing it. The check now also counts a `value` whose sibling `unit` is a percentage (a test pins both cases); the ten tasks went to version 2, graders only, and the experiment was regraded (no trial re-run, no model call). Both gradings are reported in the results. No other part of the plan changed.
- **Statistics rules tightened after the results (6 Nov, destructive review), no result changed.** The critical-failure guardrail now needs the paired test and the 6-task floor, as "better" and "worse" do, not the interval alone (S1); "practically equivalent" needs 6 tasks with a nonzero difference (S7); the verdict rules read unrounded intervals. The judge-agreement check (D8) now tests the signed false-pass gap between arms, and reports an interval as undefined when most resamples have no value (S2, S3); no held-out label existed when this changed. Every shipped verdict, interval, p-value and sentence recomputes exactly as before (`apps/api/src/stats/shipped-examples.spec.ts`).
- **N did not come from a pilot.** The plan says N comes "from the pilot"; no separate pilot ran, and N = 10 was set from the simulated power table and the cost before the run (`docs/design.md` section 6, which also reads the discovery run as the pilot it effectively was).

- **The conflict check ran after the results (6 Nov), not before the run.** The check of our prompt and settings against Hermes's own instructions (D33, D38) ran on 4 Nov on an earlier v1 config only; neither headline config had been checked when the runs started. Both were checked after the results, on Rishi's request ($0.053 on Claude Sonnet 5.5, `docs/cost.md`, System calls). It changes nothing in the analysis or the verdict; what it found is below, under "Conflict check against Hermes's own instructions".

- **The judge did not grade the final runs when they ran.** The plan above says it would, under its own approval; that approval was not given before the results, so each trial's judge grade in both runs was a `not_implemented` placeholder and nothing was spent on it. On 6 Nov, after the results, the headline run was regraded with the judge (Gemini 3.8 Flash, rubric v4; D83, $2.09) so the platform could show its trust live: those grades are new versions beside the old ones, the judge came out not trusted (kappa 0.00 on the 40 held-out labels), and no verdict changed. No outcome changes: every judge criterion is optional until it meets the trust bar on held-out labels (D8), and none had been tested there, so a judge grade could not have counted. (Tested since, on 6 Nov: rubric v4 failed the bar; see "The judge against Rishi's held-out labels".) The headline is decided by the deterministic checks alone.

- **A lenient-sourcing sensitivity analysis, added after the results (6 Nov), not a change to any verdict.** Prompted by outside reviews ("a correct figure rounded in prose fails"). The runner's sourcing check was re-run on the stored trials of two runs with its one documented switch turned on: `DERIVE_COARSE` (`workers/adapterlib/src/evals_adapter/checks.py`), which lets a figure derived in prose match after the same coarse rounding a sourced figure already gets (trailing zeros, within 1%). It was left off on purpose (A44): within 1% nearly any round figure is some sum or share of the numbers in an answer, so it also accepts some wrong figures. The strict re-run reproduces every shipped trial verdict (200 of 200 in each run). Intervals below are from a Python re-implementation of the task bootstrap (10,000 resamples), within a point of the platform's; the sign-flip p is exact. Scripts: `scripts/analysis/sourcing_recheck.py`, `sourcing_compare.py`; no model calls.

  | Run, grading | A | B | B minus A (95% interval) | Sign-flip p | Tasks differing |
  | --- | --- | --- | --- | --- | --- |
  | Headline v1 vs v2, strict (as shipped) | 64/100 | 73/100 | +9 (+3 to +17) | 0.0625 | 5 |
  | Headline, lenient | 70/100 | 80/100 | +10 (+1 to +23) | 0.125 | 4 |
  | Headline, sourcing check removed | 95/100 | 97/100 | +2 (−3 to +9) | 1.0 | 2 |
  | Planted defect vs v2, strict (as shipped) | 49/100 | 77/100 | +28 (+9 to +50) | 0.047 | 7 |
  | Planted defect, lenient | 57/100 | 79/100 | +22 (+5 to +41) | 0.094 | 6 |
  | Planted defect, sourcing check removed | 95/100 | 93/100 | −2 (−8 to +4) | 0.75 | 4 |

  Intervals here come from this analysis's own task bootstrap (`scripts/analysis/sourcing_compare.py`, 10,000 resamples, its own seed), so an end can differ by a point from the platform's: the strict headline row reads +3 to +17 here and +3 to +16 in the platform and everywhere else in these docs.

  What it says: the headline stays "no detectable difference" under any of the three gradings. The planted defect is caught only by the strict rule: loosened, the verdict falls short of p < 0.05; removed, the defect is invisible, because its harm is exactly figures no tool produced. The strict rule is the platform's sensitivity to unverified numbers, and its cost is failing correct rounding.

- **An agreement check of the code checks, added after the results (6 Nov), not a change to the verdict.** Prompted by outside reviews of the submission: each held-out trial's pass on its required checks against Rishi's blind overall label, on the 40 trials he labelled. They agree on 21 of 40 (kappa −0.23); the checks passed 9 of the 10 he failed and failed 10 of the 30 he passed, 8 on the sourcing check alone. It changes no verdict; it changes what the headline means: the pass rate measures facts and sourcing, not advice quality (`docs/known-limits.md`, #3; `docs/judge-validation.md`, top).

- **A sensitivity analysis added after the results (5 Nov), not a change to the verdict.** Prompted by the survey of other eval tools (`docs/research/evals-landscape.md`), the per-task differences were also tested the way Miller (2024, "Adding Error Bars to Evals") recommends, with a paired t-test on the task differences (+30, +30, +10, +10, +10 and five zeros): mean +9.0 points, standard error 3.79, t(9) = 2.38, two-sided p = 0.041, 95% t interval +0.4 to +17.6. Under that test the result would read "better"; under the pre-registered exact sign-flip test it is p = 0.0625, "no detectable difference". The pre-registered verdict stands. The two tests disagree because the exact test treats the five tied tasks as carrying no information and cannot go below 2/2^5 with five informative tasks, while the t-test uses the size of the differences and leans on a normal approximation with ten tasks. Both say the same about direction and size; they differ only on whether 1 in 16 or 1 in 24 counts as rare enough.
