# Panel pre-mortem

## 1. Verdict

Five harnesses eat Wednesday and Thursday, leaving judge validation, statistics and the experiment to Friday. The submission then headlines a memory "win" that Hermes's prompt injection makes true by construction, on too few tasks, and the panel takes it apart in ten minutes.

## 2. Breaks

**B1. Breadth crowds out depth.** Thursday night, SDK adapters half-work and SP5 has no tuning labels. Panel: "Your experiment uses only Hermes. What did four more adapters buy? State the adapter contract. What does `memory: on` mean for the own loop?"
- Evidence: brief: Docker unusable, Hermes install blocked, an hour lost today. Friday holds freeze, pilot, 60 labels, N, run, export. Brief and Gemini rank design over feature count.
- Likelihood/impact: high/high.
- Check: by Wed noon, one task through Hermes in a container on the fake LLM.
- Mitigation: Rishi fixes Docker today; dated cut gate; adapters declare capabilities and reject unsupported settings loudly. 1 h.
- Decision: the gate (section 3).

**B2. Memory experiment true by construction.** Hermes reads memory only as a frozen system-prompt snapshot, so "seeded vs empty" means "client facts in the prompt or not". Tier 1 passes only when seeded; pooled, it gives a big "significant" effect. Panel: "What did you learn that you didn't know before?" Threat-pattern matches silently become `[BLOCKED]`, so seeded facts may never land.
- Evidence: `docs/research/hermes/context_and_self_improvement.md` lines 189-190; `experiment.md` hypothesis blank.
- Likelihood/impact: high/high.
- Check: render the seeded prompt on the fake LLM; grep every fact.
- Mitigation: pre-register tier 1 as manipulation check, tier 3 as negative control, tier 2 as the hypothesis, with most tasks and a deterministic primary metric. 2 h.
- Decision: primary metric, tier allocation, naming it "pre-loaded client context".

**B3. Underpowered or mis-specified statistics.** An exact sign-flip test on k task deltas has a smallest two-sided p of 2/2^k: 0.0625 at five tasks (my arithmetic). A five-task tier never passes, whatever N. "Why this N?" Tasks set the floor (6 to 25 points at 20 tasks), budget sets N, and cheap-model pilot variance may not transfer. Newcombe on the headline contradicts "task is the unit". Full A/A breaks the budget: 400 Sonnet trials are about $61 (cost.md), so run plus A/A is about $122 against $100.
- Likelihood/impact: high/high.
- Check: SP6 simulation at 4, 8, 12 tasks with known effects, Wednesday.
- Mitigation: one pre-registered task-level test, bootstrap cross-check, per-task deltas descriptive, MDE curve beside the verdict. 1.5 h.
- Decision: D9, D10; A/A on a cheap model, as split halves of a 2N arm, or on fewer tasks.

**B4. Judge claims outrun 80 labels.** D8 gates per task, but 6 to 8 judged tasks leave about 10 labels each. "What can one rater's kappa show?" Agreement with Rishi beyond chance, in a wide interval. Not expert truth, not per-config fairness, not rubric ambiguity versus judge error. Emotional framing, the domain's crux, is where judges are weakest. Thursday tuning labels will slip into Friday and blur with held-out.
- Likelihood/impact: high/medium-high.
- Check: time Rishi on five smoke traces Wednesday.
- Mitigation: git-tag the rubric before held-out labelling; label per criterion; report 2×2 counts with kappa; set D8 now. 1 h plus labelling.
- Decision: D7, D8, and whether judged scores enter the primary metric.

**B5. Isolation asserted, not proven.** Containers isolate Hermes's home, but one shared MCP server holds the ledger outside them, so concurrent trials collide. "As of today" tasks change exact answers daily.
- Likelihood/impact: medium/high.
- Check: canary test on the fake LLM. One trial writes markers to ledger, memory, skills, files, `config.yaml`; concurrent and later trials find none.
- Mitigation: ledger per trial (stdio MCP in the container, or keyed by trial); fixed as-of dates. 2 h.
- Decision: D14 variant, D3.

**B6. Cost and failures don't reconcile.** Seeded memory adds tokens, so arm B hits rate limits more, skewing retries, latency and failures. Hermes omits tokens on early exits and the `max_iterations` summary. The formula omits caching, judge repeats, pilot and A/A.
- Likelihood/impact: medium/medium.
- Check: one approved cheap smoke trial; compare LiteLLM log, console, Hermes totals.
- Mitigation: cost from per-trial LiteLLM keys; infra-failure rate per arm; interleave arms; latency beside retries. 1.5 h.
- Decision: retry to success, or exclude and report.

**B7. Video stalls.** A live run cannot finish in ten minutes.
- Likelihood/impact: medium/medium.
- Check: scripted dry run on the fake LLM, Thursday.
- Mitigation: form writes a hashed config; two-task live run; cut to the finished experiment; open a failed tier-2 trial (snapshot, tool calls, grader reasoning). Say what was pre-run. 1 h.
- Decision: real model live or not.

Would impress: the invariance diff, A/A floor, "undetermined" verdicts, per-config judge numbers. The diff and A/A are likeliest cut.

## 3. The one change today

My one challenge to R5: build Hermes and the own loop to SP1's done-when, then go straight to SP3 to SP6 on the fake LLM. Start LangGraph and the SDKs only after SP6 passes. D6 says one extra harness shows an adapter exists; a README walkthrough answers R2's "Claude Agent SDK tomorrow" test. Rishi's call.

## 4. Checked versus assumed

Checked: the brief; SPEC, decisions, experiment, judge-validation, cost, known-limits; greps of the evals report and Hermes memory audit.

Assumed: tasks per tier, a stateful shared ledger, Sonnet as experiment model, current environment facts. Arithmetic is mine. Nothing was run.
