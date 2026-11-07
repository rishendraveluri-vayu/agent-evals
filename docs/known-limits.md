# Known limits

Where this platform's conclusions should not be trusted: the short version first, then an index into the full log. Add a line the moment one turns up. Remove a line only if it's actually fixed and tested.

## The six that matter most

1. **Few tasks decide the headline.** It has 10 held-out tasks, and 5 scored the same in both arms
   (4 always passed, 1 always failed). Over the 5 left, the paired test cannot go below
   p = 0.0625, so the headline could not be called "better" whatever its size. More tasks between
   the ceiling and the floor would settle it; more trials would not ([Statistics](known-limits-log.md#statistics-sp6-5-nov), in the full log).
2. **The LLM judge is built and calibrated, but it failed the bar on my held-out labels, so it's
   shown and not counted.** The frozen rubric v4 on Gemini 3.8 Flash reached kappa 0.63 on a
   29-trial dev set (interval −0.05 to 1.00), then −0.14 on the 40 held-out trials I labelled
   blind: it passed all 9 answers I failed that it graded. Most of my fails name things the
   rubric never asks for (tax on the gains, moving to debt as a goal nears); two are for a missing
   question the rubric says is not a fail on its own. Every verdict rests on the deterministic
   checks (`docs/judge-validation.md`, top).
3. **The headline mostly measures one rule.** 31 of v1's 36 failures and 24 of v2's 27 fail only
   the check that every rupee figure comes from a tool; without it the arms pass 95 and 97 of 100.
   That check is strict: a correct figure rounded in prose fails it ([Platform checks](known-limits-log.md#platform-checks-checksjson-4-nov), in the full log).
   Against my 40 blind held-out labels the code checks agree on 21 (kappa −0.23, worse than the
   judge that was rejected): they passed 9 of the 10 answers I failed and failed 10 I passed, 8
   on the sourcing check alone. So the pass rate measures facts and sourcing, not advice quality
   (`docs/judge-validation.md`, top). Loosening the rule to accept rounded derived figures leaves the
   headline undecided (+10, p = 0.125) and loses the planted defect (+22, p = 0.094); removing it
   hides the defect entirely (`docs/experiment.md`, Deviations).
4. **Models are named by alias.** `claude-haiku-5-5` is the provider's name, not a dated snapshot,
   so a provider update behind it changes results between runs. Each call records the model id the
   provider served (`gen_ai.response.model` on its span), but the config's hash does not cover it.
   In practice that id is LiteLLM's route name (`anthropic/claude-haiku-5-5`), not a dated
   snapshot, so it would not show a provider swapping the model behind the alias either.
5. **Conversations run on a simulated client.** Claude Haiku plays the client from a brief with
   hidden facts and a synthetic client file. How it reveals a fact changes outcomes (trajectory 1
   in `docs/experiment.md`), so conversation results describe this simulator, not real clients
   ([Simulated client](known-limits-log.md#simulated-client-d22), in the full log).
6. **Harnesses differ in what they add and how they end.** Hermes adds its own prompt text and,
   at the step limit, answers with a summary; the own loop and LangGraph stop without one. A
   comparison across harnesses includes these differences (`docs/harness-guide.md`).

## Topics the brief names

- **Task-set size:** with 21 tasks, results may not generalise to other work. The headline compares the 10 held-out tasks only (D53), where the comparison finds a real +15 point improvement only about half the time ([Statistics](known-limits-log.md#statistics-sp6-5-nov), in the full log). In the real run 5 of the 10 tied (4 at 10 of 10 in both arms, 1 at 0 of 10), so only 5 tasks carried the test and p could not go below 0.0625 (`docs/experiment.md`, Results).
- **Judge bias:** measured on my tuning labels, the D74 dev set and, on 6 Nov, my 40 held-out labels, where rubric v4 failed D8 (kappa −0.14, specificity 0.00; `docs/judge-validation.md`, top). The figures below are rubric v1's on the tuning labels (33 discovery trials, one rater; `docs/experiment.md`, "The judge against my tuning labels"). The specific criteria agreed with me (clears-card-first 12 of 12, keeps-medicines and health-cover 3 of 3 each, where kappa is undefined because my labels were all one value); the overall verdict is lenient (kappa 0.30, interval 0.00 to 0.78; specificity 0.20, 4 false passes). On the held-out labels rubric v4 is not trusted (the panel's kappa −0.14; the platform's regrade of the headline on 6 Nov, D83, kappa 0.00 with a false-pass gap of +0.17 between arms), so no judge criterion counts in the headline: every judge check there is optional. Judge retest: see `docs/experiment.md`.
- **Contamination:**
  - **Between trials: none by design, and tested.** Each trial gets a fresh Hermes home and trial folder at a fixed path, wiped and checked empty between trials with leftover processes killed, on a read-only root with no host mounts (`docs/design.md` section 4). The netcheck (`docker compose --profile smoke run --rm netcheck`, `workers/base/netcheck.py`) checks a worker reaches the API, LiteLLM and the fake model but not the internet, on a read-only root with `/trial` writable. The image leak tests (`workers/adapterlib/tests/test_images.py`) run two trials in one container, the first writing markers everywhere it can and leaving processes behind, and check the second sees none of it and cannot reach the first one's stored files; CI runs them on every push since 6 Nov (compose-smoke, on the images compose built), and locally they need `EVALS_IMAGE_TESTS=1`. LiteLLM's response cache is off (`cache: false`, enforced by `scripts/check_litellm_config.py`), so no answer is replayed. What the tests do not cover: SysV IPC and POSIX message queues are not cleared, and the leak test looks at known paths (both below).
  - **Tasks seen before the comparison.** 4 of the 10 held-out tasks (convo-consolidation, loan-to-clear-card, sip-education-goal, otp-scam) had v1 outputs read on 4 Nov, before v2 was written and before the split existed (`docs/experiment.md`, Setup), so v2 may carry what was seen there. Of the 5 tasks where the arms differed, 2 were among them (convo-consolidation 2 → 5, loan-to-clear-card 8 → 9); the 3 never run before v2 also favoured v2 (convo-phone-loan 2 → 5, convo-job-loss 3 → 4, college-cost-stepup 9 → 10).
  - **Model training data.** The tasks, client files and personas are new, synthetic and not public. The model may still know standard EMI formulas and Indian product facts (FDs, PPF, SIPs, RBI rules) from training. Unmeasured. Both arms use the same model, so in the prompt experiment this moves both pass rates alike; in a model-vs-model comparison it would not cancel.
  - **The simulated client (D22).** Its replies are cached by exact conversation state, scoped by task, simulator model, prompt and settings but not by agent config, so both arms meet the same client: same persona, hidden facts, model and prompt, and the same reply whenever two conversations are identical so far. This is allowed: it fixes the environment and never touches the agent's calls. It makes a recorded conversation repeatable, not the client deterministic. The simulator runs Haiku 5.5 at its default temperature (D27), and in the headline's 60 conversation trials all 60 first agent replies differed, so no two trials shared a state after the opening message and every client reply was a fresh sample. The client's own variation is part of each trial's noise in both arms: on convo-phone-loan it did not answer v1's direct question about the extra it could pay (`t_0mw38a1yo2bb2711bbfafd20c`), and it volunteered its ₹3,000 to v2 without being asked for an amount (`t_0mw38a1yod9dd291f21e1b63c`).
- **Harness-specific quirks:** see Hermes and other harnesses under [Everything else, by area](#everything-else-by-area) below.

## Everything else, by area

The full record of every limit, as each was found from 3 Nov on, is in [`docs/known-limits-log.md`](known-limits-log.md), kept word for word. By area:

- **Hermes and other harnesses:** [Hermes-specific, from notes so far](known-limits-log.md#hermes-specific-from-notes-so-far); [Hermes, from the SP1 probes (3 Nov)](known-limits-log.md#hermes-from-the-sp1-probes-3-nov); [Hermes, from the adapter's gate tests (3 Nov)](known-limits-log.md#hermes-from-the-adapters-gate-tests-3-nov); [Hermes memory (D39, 4 Nov)](known-limits-log.md#hermes-memory-d39-4-nov); [Harness capabilities (7 Nov)](known-limits-log.md#harness-capabilities-7-nov); [Open-weight model (local Qwen, 5 Nov)](known-limits-log.md#open-weight-model-local-qwen-5-nov)
- **Isolation, the engine and reproducibility:** [Trial isolation (D3)](known-limits-log.md#trial-isolation-d3); [Run screen and engine (fresh-clone QA fixes, 4 Nov night)](known-limits-log.md#run-screen-and-engine-fresh-clone-qa-fixes-4-nov-night); [Host folders the API writes (clean-machine test, 5 Nov)](known-limits-log.md#host-folders-the-api-writes-clean-machine-test-5-nov); [After the soak test (6 Nov)](known-limits-log.md#after-the-soak-test-6-nov); [Which adapter code ran a trial (D85, 7 Nov)](known-limits-log.md#which-adapter-code-ran-a-trial-d85-7-nov); [Robustness run and review of the new code (7 Nov)](known-limits-log.md#robustness-run-and-review-of-the-new-code-7-nov)
- **Cost and the model proxy:** [Cost tracking](known-limits-log.md#cost-tracking); [LiteLLM records (checked 3 Nov, v1.99.4)](known-limits-log.md#litellm-records-checked-3-nov-v1994); [LiteLLM retries (D16, checked 4 Nov on v1.99.4 against the fake)](known-limits-log.md#litellm-retries-d16-checked-4-nov-on-v1994-against-the-fake); [Cost comparisons (4 Nov night)](known-limits-log.md#cost-comparisons-4-nov-night)
- **Before a run:** [Pre-run checks: rendered prompt and conflict check (D33, D38)](known-limits-log.md#pre-run-checks-rendered-prompt-and-conflict-check-d33-d38); [Invariance diff](known-limits-log.md#invariance-diff); [Names and what differs (fresh-clone QA round 3, 5 Nov)](known-limits-log.md#names-and-what-differs-fresh-clone-qa-round-3-5-nov)
- **The task environment:** [Platform checks (checks.json, 4 Nov)](known-limits-log.md#platform-checks-checksjson-4-nov); [Simulated client (D22)](known-limits-log.md#simulated-client-d22); [Fake model server (tests and CI only)](known-limits-log.md#fake-model-server-tests-and-ci-only); [Finance tools (services/finance-mcp)](known-limits-log.md#finance-tools-servicesfinance-mcp)
- **Grading and the judge:** [Deterministic graders (SP4, 4 Nov)](known-limits-log.md#deterministic-graders-sp4-4-nov); [The judge's plumbing (SP4, 4 Nov night)](known-limits-log.md#the-judges-plumbing-sp4-4-nov-night); [LLM judge approval (SP4, R8)](known-limits-log.md#llm-judge-approval-sp4-r8); [Trial page judge evidence (7 Nov)](known-limits-log.md#trial-page-judge-evidence-7-nov); [Found in the v1 discovery run, kept as findings (D65 freeze)](known-limits-log.md#found-in-the-v1-discovery-run-kept-as-findings-d65-freeze); [Labelling UI (SP7)](known-limits-log.md#labelling-ui-sp7)
- **Statistics and verdicts:** [Statistics (SP6, 5 Nov)](known-limits-log.md#statistics-sp6-5-nov); [Arms graded alike (D72, 5 Nov)](known-limits-log.md#arms-graded-alike-d72-5-nov); [Failure causes and behaviour (D64, 5 Nov)](known-limits-log.md#failure-causes-and-behaviour-d64-5-nov)
- **Screens and shipped examples:** [Shipped examples (SP7, 4 Nov)](known-limits-log.md#shipped-examples-sp7-4-nov); [Found by browser QA (7 Nov), left as they are](known-limits-log.md#found-by-browser-qa-7-nov-left-as-they-are); [Final browser pass (7 Nov), left as they are](known-limits-log.md#final-browser-pass-7-nov-left-as-they-are)
- **Reviews and research:** [From the 3 Nov research](known-limits-log.md#from-the-3-nov-research); [After the destructive review (6 Nov)](known-limits-log.md#after-the-destructive-review-6-nov); [Open checks](known-limits-log.md#open-checks)
