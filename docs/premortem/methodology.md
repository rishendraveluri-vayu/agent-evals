# Pre-mortem: methodology

Tue 3 Nov. "My calc" marks my derivations.

## 1. Verdict

The headline is significant only because tier 1 puts the answer in the prompt: true by construction. Hermes memory is just prompt injection, and tiers 2 and 3 sit near ceiling with about seven tasks each.

## 2. Breaks

**B1. Tier 1 carries the headline by construction.** Friday: p < 0.01, tier 1 at +90 points, the rest near zero.
- Evidence: memory is read only as a frozen prompt snapshot (Hermes audit). Seven tasks at +0.9 give sign-flip p ≈ 0.008 alone (my calc). Author-written seeds may hold the graded number (SkillsBench leakage gate).
- High likelihood, high impact.
- Test by Wed: script flagging graded numbers in seeds. Render a seeded prompt; check entries are not `[BLOCKED]`.
- Mitigation: pre-register tier 1 as a manipulation check outside the headline. Give tier-3 seeded tasks an equal-size seed (1.5 h).
- Decision: does "asks for the missing fact" pass in the empty arm? Does memory stay the axis? D9 is due Friday, tier tasks Wednesday.

**B2. Ceiling in tiers 2 and 3.** Tools do the maths, so strong models pass 90%+ in both arms when inputs are reachable. Tier 2's real effect is extra ledger calls, which pass rate cannot see.
- Evidence: 7 tasks, N = 5, pass near 85% gives a detectable effect of about 28 to 34 points (my calc, Miller's formula). So "undetermined"; the judge carries what is left.
- High likelihood, high impact.
- Test: pilot pass rate per tier; flag tasks above 90% in both arms.
- Mitigation: tier 2 primary = tool calls, tokens, cost (continuous). Tier 3 = non-inferiority test with a declared margin (1 h).
- Decision: the margin and each tier's primary metric.

**B3. Judge and rater share a bias toward the seeded arm.** Seeded replies say "since your husband passed", so neither labeller nor judge is blind to arm.
- Evidence: judges are weakest on emotional framing (CALM, robustness about 0.25) and lean lenient (AgentRewardBench, precision under 70%). Rishi wrote the tasks and holds the hypothesis, so high kappa may mean shared bias. Tier-3 over-personalisation may score well.
- High likelihood, high impact.
- Test by Wed: five tone-swap and five substance-swap pairs through the draft judge. Cents; needs go-ahead.
- Mitigation: criteria as observable substance checks, written before seeing outputs. Tier-3 criterion "does not raise irrelevant circumstances". Agreement reported per arm (2 h).
- Decision: D8 threshold; whether judged criteria enter the headline.

**B4. Exits and cost track the arm.** The empty arm takes more steps, hitting `max_iterations` and compression more.
- Evidence: Hermes omits the cap's summary call from token totals and returns no tokens on early exits, so empty-arm cost is undercounted. Compression rebuilds the prompt from disk, picking up mid-trial memory writes. Running A then B ties rate limits to arm (Gemini).
- Medium likelihood, high impact.
- Test: pilot cap-exit and `session:compress` rates per arm.
- Mitigation: tokens from LiteLLM proxy; random interleaved order; cap exits are failures, with a sensitivity check excluding them; infra errors excluded, reported per arm, bounded by recounting as failures (3 h).
- Decision: D15 compression, same in both arms.

**B5. The pilot tests a different pipeline.** A `gpt-5*` pilot takes Hermes's Responses API path. Cache markers appear only for Claude via a `litellm` host. Weak models trip the MCP breaker. Pilot variance, cost and 40 held-out labels describe the wrong model.
- Medium likelihood, medium impact.
- Test: diff first requests of pilot and final configs.
- Mitigation: pilot on the final family's cheaper model; pin API mode; set N from budget, report the effect-by-N curve (1 h).
- Decision: D9's "N from pilot".

**B6. A/A and pre-registration do not fit.** At an assumed 120k input tokens per trial and about $3 per million, 20 tasks × 2 arms × N = 5 costs about $80, so a Claude A/A does not fit (my calc; check `cost.md`). `experiment.md` is blank, D8 to D10 are open, and the directory is not a git repo, so commit order is unprovable.
- Medium likelihood, high impact.
- Test: proxy cost of five smoke trials.
- Mitigation: split-half A/A within one arm (free), one cheap-model A/A for the pipeline, `git init` today (0.5 h).
- Decision: who writes the plan, by Thursday.

**B7. Judge noise and truncation.** Non-determinism widens variance but, contrary to Gemini, does not invalidate the task-level paired test. It bites when re-analysis re-rolls verdicts. Truncation bites only if the judge reads the whole trace.
- Medium likelihood, low impact.
- Test: judge ten labels thrice.
- Mitigation: judge only final reply, tool outputs, circumstances. Cache verdicts by trial, criterion and judge hash. Three repeats on labels for flip rates (1 h).

## 3. The one change today

Rishi settles D9 today and commits the analysis plan before tier tasks exist. Tier 1 is a manipulation check, tier 2 is measured on steps and cost, tier 3 is non-inferiority. If memory fails that, the alternative axis is Hermes versus own loop, one model.

## 4. Checked versus assumed

Checked: brief; report lines 64-218; `experiment.md` (blank); greps of decisions, SPEC and the Hermes memory audit. Not read: `cost.md`, `judge-validation.md`, `design.md`, report lines 219+.

Assumed: ~7 tasks per tier; single-turn, no simulated user; one seed per task; a Sonnet-class final model; near-ceiling tool maths; the per-trial cost.
