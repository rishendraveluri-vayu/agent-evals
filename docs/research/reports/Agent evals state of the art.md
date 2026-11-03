# Agent evaluation now audits its own instruments

As of November 2026, the state of the art in evaluating LLM agents is a layered protocol, not a benchmark. It runs each trial in a clean environment, grades the final state with deterministic code, uses narrow rubric judges that have been checked against human labels, repeats trials and analyses them with paired statistics clustered by task, and has humans read transcripts before anyone trusts a number. The main lesson of 2025 and 2026 is that the measuring instrument fails more often than anyone assumed. Independent audits found broken tasks or graders in **16% to 72%** of the items checked in flagship benchmarks. OpenAI retired SWE-bench Verified and then withdrew its recommended replacement. Changing only the harness moves scores by **9 to 34 points** with the model held fixed. Single-run gains of **2 to 3 points** fall within run-to-run noise. Judges reading agent transcripts count roughly **30%** of failed trajectories as successes. For a platform that compares harness × model × settings on about 20 tasks with N trials, three things follow. First, the task is the unit of analysis, not the trial, so 400 trials carry the information of a few dozen independent ones and the smallest detectable difference probably sits between about 6 and 25 points however large N gets. Second, checking the judge separately for each configuration is something published work does not do, so it is a real contribution, but 60 to 80 labels from one rater only support descriptive per-config numbers. Third, the closest published template for tasks that need both a correct tool call and a context-sensitive answer is tau-bench's reward, which multiplies a state check by an output check, and its own authors call it "necessary but not sufficient". Only humans can reliably decide whether a task is valid, what the criteria are, whether a flagged run is a hack, a grader bug or a genuine failure, and how big a difference has to be before it matters.

## Deterministic end-state graders carry the field, and audits keep breaking them

### Benchmarks grade outcomes with code and keep judges on a short leash

Almost every widely used agent benchmark grades the final environment state or a short answer that can be checked, using deterministic code, and almost all score each trial as pass or fail. SWE-bench and its successors run unit tests: fail-to-pass tests that the fix must make pass, and pass-to-pass tests that must keep passing. GAIA uses near-exact matching with normalisation by answer type, such as stripping units and commas from numbers. OSWorld runs a custom script per task. Terminal-Bench 2.0 tests the final container state with pytest and does not inspect the commands the agent ran ([Terminal-Bench 2.0](https://arxiv.org/html/2601.11868); [GAIA](https://arxiv.org/html/2311.12983)).

Where judges appear, they have narrow jobs. TheAgentCompany falls back to an LLM grader on **51 of 175 tasks (29%)**, mainly for "simple information extraction and classification" ([TheAgentCompany](https://arxiv.org/html/2412.14161)). BrowseComp's grader only checks whether the answer means the same as one short reference ([BrowseComp](https://arxiv.org/html/2504.12516v1)). tau2-bench 2.0 (19 Oct 2026) moved its communication checks to an LLM judge and pinned that judge to a dated snapshot. Its separate `tau2 judges` command is diagnostic only and does not feed the reward ([tau2-bench release notes](https://raw.githubusercontent.com/sierra-research/tau2-bench/main/RELEASE_NOTES.md)).

Anthropic's January 2026 guide states the consensus: "deterministic graders where possible, LLM graders where necessary". It says it is often better to grade "what the agent produced, not the path it took", and calls rigid checks on the sequence of tool calls "overly brittle" ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). Partial credit shows up only where a task is split into checkpoints. TheAgentCompany's score, for example, is 0.5 × the share of checkpoints passed + 0.5 × full completion.

### Every audited benchmark has turned out to be partly broken

The audits of 2025 and 2026 share one finding: graders and task specifications fail at rates that dwarf the score differences people report.

| Benchmark | Grader | What the audit found |
| --- | --- | --- |
| SWE-bench Verified | Unit tests | OpenAI picked 138 tasks that o3 solved inconsistently across 64 runs and had engineers review them. 59.4% had flawed tests or descriptions, so at least 16.4% of all 500 tasks are broken. Frontier models had seen solutions in training. Retired Feb 2026 ([Epoch](https://epoch.ai/benchmarks/swe-bench-verified/review); [The Decoder](https://the-decoder.com/openai-wants-to-retire-the-ai-coding-benchmark-that-everyone-has-been-competing-on/)) |
| SWE-Bench Pro, public set | Unit tests | About 30% of 731 tasks broken. In Jul 2026 OpenAI withdrew the recommendation it had made in Feb ([DEV Community summary](https://dev.to/thegatewayguy/openai-just-found-30-of-swe-bench-pro-is-broken-and-retracted-their-own-recommendation-3nlh)) |
| tau-bench airline | Final database state × required output | An agent that returns empty responses passes 38% of tasks, more than GPT-4o's 35% ([ABC checklist](https://arxiv.org/html/2507.02825)) |
| OSWorld 2.1 | Per-task scripts plus some LLM judging | 40 errors in 36 of 50 sampled tasks (72%). One task scores 100% if the agent uploads every document ([Epoch](https://epoch.ai/benchmarks/osworld-2-1/review)) |
| Terminal-Bench 2.0 | Tests on final container state | 28 of 89 tasks (31%) defective. Fixing them raised scores by up to 12 points ([ICML 2026](https://icml.cc/virtual/2026/82793)) |
| CORE-Bench | Numeric match | The grader rejected "96.12" when it expected "96.124991…", which helped hold Claude Opus 4.5 at 42%. After fixes it scored 95% ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)) |

OpenAI's own posts on both SWE-bench retirements refuse automated fetching, so the figures above come through Epoch and press coverage. The pattern holds regardless.

What survives these audits is ranking, not absolute score. After the Terminal-Bench fixes, the order of 19 agents barely moved (Spearman 0.958) ([ICML 2026](https://icml.cc/virtual/2026/82793)). A March 2026 study across 33 scaffolds likewise found that changing the scaffold distorts predicted scores while keeping rank order stable ([Efficient Benchmarking](https://arxiv.org/abs/2603.23749)). That is reassuring for a comparison platform, with one dangerous exception: a grader that is brittle about how an answer is formatted produces a fake difference between configs. The CORE-Bench case is exactly that. A model whose style is to round looks worse than one that prints every digit.

In personal finance this risk is concrete. Amortisation results, interest totals and payoff dates come back with different rounding, currency symbols and thousands separators depending on the model. Exact-match graders therefore need the kind of normalisation GAIA applies, and the ABC checklist explicitly requires graders to "handle semantically equivalent answers" ([ABC](https://arxiv.org/html/2507.02825)).

The auditors found broken tasks in four ways:

- Humans reviewed tasks that a strong model solved only some of the time.
- Trivial or adversarial agents were run. Terminal-Bench's exploit agent found monkey-patched tests and answer enumeration ([Terminal-Bench 2.0](https://arxiv.org/html/2601.11868)).
- Tasks were re-validated continuously, CI-style, on every release.
- LLMs helped inspect logs. HAL used this to catch agents searching HuggingFace for the answer key ([HAL](https://arxiv.org/html/2510.11977)).

Anthropic adds that a 0% pass rate across many trials "is most often a signal of a broken task, not an incapable agent". A 20-task set can afford all four checks.

### Tool call plus judgment already has a template, and a warning attached

tau-bench is the closest published design to a finance assistant that must calculate correctly and also respond to the person's circumstances. Its reward is r = r_action × r_output. Each factor is 0 or 1: r_action checks that the final database matches the ground truth, and r_output checks that the agent's messages contain the required information. The paper warns that r = 1 is "necessary but not sufficient", because an agent can issue a return without the user's confirmation and still score ([tau-bench](https://arxiv.org/html/2406.12045)).

The authors hand-classified GPT-4o's failures on retail tasks:

- wrong arguments: **33.3%**
- wrong decisions, meaning policy or rule-following: **25.0%**
- wrong information: **22.2%**
- partial resolution of compound requests: **19.4%**

([tau-bench](https://arxiv.org/pdf/2406.12045)). Roughly 55% of failures are argument or information errors that a deterministic check can catch. The 25% that are wrong decisions are the judgment half. Removing the domain policy from the prompt cut airline pass^1 from **33.2% to 10.8%**, so the context the agent is given does measurable work.

This bears directly on D7 (how many tasks use the judge). R6 requires every task to have a tool-call component and a judgment component, so the real question is how the two parts combine. Anthropic lists three ways: weighted, binary where all graders must pass, and hybrid ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). Each has a cost:

- **All-pass product (tau-bench style).** Simple and binary, but judge error enters the headline score of every task.
- **Report the two parts separately, with the deterministic part as primary.** The headline is insulated from judge error. The judged part becomes a secondary result.
- **Weighted partial credit (TheAgentCompany style).** Gives a continuous score. Continuous scores have consistently higher signal-to-noise than discrete ones: on MMLU, 52 for pass/fail scoring against 348 for a continuous score ([Madaan et al.](https://arxiv.org/html/2406.10229v1)). Ai2 found the same, with switching to a continuous metric raising mean signal-to-noise from 10.0 to 31.5 ([Signal and Noise](https://arxiv.org/html/2508.13144v1)).

Multi-turn tasks with a simulated user carry an extra risk. tau2-bench's simulator made task-critical errors in **6% to 13%** of conversations ([tau2-bench](https://arxiv.org/html/2506.07982v1)). Husain prefers replaying the first N−1 real turns over a fully simulated user ([Husain FAQ](https://hamel.dev/blog/posts/evals-faq/)).

### Memory and skill tasks need matched controls and leakage gates

Two benchmarks show how to build tasks where memory or a skill measurably helps.

SkillsBench (Feb 2026) builds every task with a matched no-skill control. A leakage gate rejects any skill that contains task-specific filenames, magic numbers or oracle commands, and tasks that show no gap between the two conditions are thrown out. Curated skills raised the mean pass rate from **33.9% to 50.5%** across 18 model–harness configs. But 13 of 87 tasks got worse, comprehensive skills added only +0.7 points against +19.0 for compact ones, and skills the agent wrote for itself scored **8.1 to 11.5 points below** having no skills at all ([SkillsBench](https://arxiv.org/html/2602.12670)).

CL-Bench measures gain as the stateful system's reward minus the same system run without state on the same instance, divided by the headroom left. Plain in-context learning with Claude Sonnet 4.6 (25.4% normalised gain) beat Mem0 (20.2%) and ACE (8.6%) ([CL-Bench](https://arxiv.org/html/2606.05661)).

Rishi's three-tier rule for memory tasks has the same structure: a fact that exists only in memory, a fact also discoverable with extra work, and tasks where memory is irrelevant. It is a matched-control design with deliberate tasks where the feature should not help, which is what Anthropic means by balancing the set. The finding that self-written skills are net negative is direct empirical support for R3: background self-modification stays off unless a config turns it on.

## LLM judges lean lenient and drift, and nobody publishes per-config validation

### Isolated binary criteria with a reference are the best-validated design

The judge design with the strongest evidence is pointwise: one isolated judge call per criterion, a binary verdict, and a way out. Anthropic recommends grading "each dimension with an isolated LLM-as-judge" and letting the judge return "Unknown" when it lacks information ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). Husain recommends binary pass/fail with a written critique and one judge per failure mode, and says 1-to-5 scales "often don't correlate with expert judgments" ([Husain](https://hamel.dev/blog/posts/llm-judge/)).

HealthBench is the closest published precedent for grading context-sensitive advice. Physicians wrote **48,562** criteria, each graded independently as met or not met. Its GPT-4.1 grader reached macro-F1 **0.709** against physicians, while physicians agreed with each other at 0.569 to 0.730 depending on theme ([HealthBench](https://arxiv.org/html/2505.08775v1)). PaperBench's leaf-criterion judge reached F1 0.83 ([PaperBench](https://arxiv.org/html/2504.01848)).

Giving the judge a reference answer is the biggest single lever in the literature. On MT-Bench's math questions it cut judge failures from **70% to 15%**, while chain-of-thought alone only got them to 30% ([MT-Bench](https://arxiv.org/html/2306.05685)). A 2026 benchmark of 3,808 tool-calling instances adds a caution. Supplying ground truth *lowered* alignment for GPT-5.4 (by 1.5 points) and Gemini-2.5-Pro (by 3.9 points) through over-anchoring. Structured rubrics helped by up to 6.5 points, and chain-of-thought and judge temperature had "negligible effects" ([AgentJudgeBench](https://arxiv.org/abs/2608.26623)).

Pairwise judging suits holistic comparisons but brings position bias. Across 15 judges, position consistency ranged from 0.23 to 0.89 on DevBench ([Shi et al.](https://arxiv.org/html/2406.07791v9)).

For finance tasks, this evidence points to a specific judge input: the deterministic tool outputs, the person's circumstances stated as an expected outcome rather than a model transcript, and criterion-level verdicts that each cite observable evidence.

### Agent-trace judges overcall success and trust the agent's own story

On agent trajectories, judges fail mostly in one direction: they pass things that failed. In AgentRewardBench (1,302 web-agent trajectories, six expert annotators), **no judge exceeded 70% precision**, so about 30% of trajectories judged successful were not. The judges accepted an agent's claim that it had applied a filter it never applied, and took "found the cereal" as a completed purchase. Rule-based graders erred the other way, with precision 83.8 but recall 55.9 ([AgentRewardBench](https://arxiv.org/html/2504.08942v2)).

A NeurIPS 2026 benchmark reports that every judge loses a further **37 to 50 points** on long traces, a drop that averaging hides ([TraceJudgeBench](https://neurips.cc/virtual/2026/173089)). Only the conference listing was available, so treat that figure as provisional.

Rewriting only the agent's chain-of-thought, with its actions and observations left unchanged, raised judges' false-positive rates by roughly 20 to 30 points. Majority voting barely helped ([Gaming the Judge](https://arxiv.org/html/2601.14691v2)). Single "master key" strings such as ":" or "Thought process:" produced false-positive rates of **80.6%** for LLaMA3-70B and **12.4% to 14.6%** for Claude-4 and GPT-4o ([One Token to Fool](https://arxiv.org/html/2507.08794v3)). When judges do not follow the criteria, they default to "correct" ([Thakur et al.](https://arxiv.org/html/2406.12624)).

Two practical consequences follow. The judge should read observations, meaning tool outputs and the final reply, rather than the agent's narration. And the labelled set has to over-sample failures, or the judge's true-negative rate cannot be estimated at all.

Bias toward the identity of the writer persists even when names are hidden. Without being told, GPT-4 recognised its own summaries **73.5%** of the time, and its preference for its own output tracked that recognition ([Panickssery et al.](https://arxiv.org/html/2404.13076v1)). So when the judge shares a model family with a graded config, self-preference is a live confound. It matters most if the experiment's axis is the model. If both arms use the same model, the bias is shared and largely cancels in the paired difference.

The bias most relevant to this domain is emotional framing. In the CALM study, adding negative emotion, especially fear, to the better answer cut judge robustness to **about 0.25** for GPT-4-Turbo and Claude-3.5, the steepest drop the study measured ([CALM](https://arxiv.org/html/2410.02736)). No study has measured this on financial-advice rubrics. Still, tasks built around a spouse's death are exactly where an empathy rubric is most exposed to tone over substance, and empathetic answers also tend to be longer, which OpenAI's guidance still flags ([OpenAI](https://developers.openai.com/api/docs/guides/evaluation-best-practices)). A probe pair would test this directly: the same advice written in two tones, or at two lengths.

Judges also disagree with themselves:

- Three identical runs of the same judge agreed at Krippendorff's alpha **0.33 to 0.79**. Turning sampling off *lowered* agreement with humans ([Rating Roulette](https://arxiv.org/html/2510.27106)).
- Pairwise verdicts flipped **13.6%** of the time across 50 repeats, and about 11 repeats were needed to recover the stable verdict with 95% probability ([Coin Flip Judge](https://arxiv.org/abs/2606.13685)).
- One of seven borderline items stayed non-reproducible even with greedy decoding on Claude Sonnet 4.6 ([Necessary but Not Sufficient](https://huggingface.co/papers/2606.26185)).

Aggregate scores can be stable while individual verdicts are not. HealthBench's overall score moved with a standard deviation of about 0.002 across 16 runs. Swapping in a newer judge is not neutral either: a July 2026 study found that "judge upgrades are not interchangeable" ([When the Judge Changes](https://arxiv.org/abs/2607.08535)). The plan's three-repeat test-retest fits this literature. The papers add two things: report the flip rate per criterion, and treat items the judge disagrees with itself on as candidates for rubric revision.

### Sixty to eighty labels can validate the judge overall, not per config

The label counts people recommend start around 100 per failure mode:

- Husain asks for about 100 per failure mode and warns that "below 60 examples, the confidence intervals are often too wide" ([Husain](https://hamel.dev/blog/posts/llm-judge/)).
- His FAQ with Shankar asks for 100 to 200 per failure mode, with 30 to 50 passes and 30 to 50 failures in both the development and the test split ([AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/)).
- Arize puts about 100 labels at roughly ±10 points of precision and about 400 at ±5 ([Arize](https://arize.com/blog/measuring-human-llm-judge-alignment/)).

Raw agreement misleads. A judge that always says pass scores 95% agreement when 5% of outputs fail. Thakur et al. found a Llama-3 8B judge with over 80% agreement but a chance-corrected Scott's pi of only 59 ([Thakur et al.](https://arxiv.org/html/2406.12624)). The defensible package is kappa together with true-positive and true-negative rates, the raw 2×2 confusion counts and bootstrap intervals. Kappa needs the raw counts beside it because of the prevalence paradox: when one verdict dominates, kappa can be low even with high raw agreement ([Arize](https://arize.com/blog/measuring-human-llm-judge-alignment/)).

No threshold has a principled basis. Wikipedia notes that the familiar Landis–Koch kappa bands rest on "personal opinion" ([Cohen's kappa](https://en.wikipedia.org/wiki/Cohen%27s_kappa)). Krippendorff's alpha cut-offs, 0.800 to rely on the data and 0.667 for tentative conclusions, are equally conventional ([Krippendorff's alpha](https://en.wikipedia.org/wiki/Krippendorff%27s_alpha)). In practice the bar is human–human agreement. For example, GPT-4 agreed with experts 85% of the time on MT-Bench, while experts agreed with each other 81% of the time ([MT-Bench](https://arxiv.org/html/2306.05685)). With a single rater there is no human–human figure, so Rishi's own relabel consistency is the only ceiling available. Rating Roulette notes that LLM-evaluation studies rarely report that kind of intra-rater reliability.

Checking the judge per graded configuration is a real gap in the literature. Agent-as-a-Judge comes closest. It reported a plain LLM judge's alignment with humans at **84.2%, 65.3% and 60.4%** across three agent frameworks, a 24-point spread that depended only on which system was being graded ([Agent-as-a-Judge](https://arxiv.org/html/2410.10934)). Per-config checking is therefore the right test. But 60 to 80 labels spread across several configs leaves about 15 to 25 per config. A kappa from 20 items has an interval wider than the Landis–Koch bands themselves, and because pass rates differ by config, kappa will differ even if the judge is equally good on each. Per-config numbers can flag a one-sided pattern, such as a judge that is lenient only on one model family. They cannot serve as a gate.

The current `judge-validation.md` table uses the normal approximation. At 90% agreement on 30 labels, that gives roughly [79%, 101%], while the Wilson interval gives about [74%, 97%] (my calculation). Brown, Cai and DasGupta recommend Wilson or Jeffreys intervals at small n because the normal interval's coverage is "chaotic" ([Brown, Cai & DasGupta](https://projecteuclid.org/euclid.ss/1009213286)).

Criteria will drift while Rishi labels. Shankar's study found it "impossible to completely determine evaluation criteria prior to human judging of LLM outputs" ([Who Validates the Validators](https://arxiv.org/html/2404.12272)). The plan's split, with a Thursday tuning set and a Friday held-out set scored once under a frozen rubric, mirrors Husain's train, development and test split. Labels made under an earlier rubric version need re-checking.

For D8 (the threshold, and what happens below it), the literature gives an order of remedies ([AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/)):

1. Read the disagreements by hand.
2. Split the criterion into narrower ones.
3. Give the judge the expected end state.
4. Try a stronger judge or one from a different family.
5. Only then fall back.

It leaves these fallbacks open:

| Fallback | What it protects | What it costs |
| --- | --- | --- |
| Remove the judged criterion from the headline (the current lean) | The headline score | Half of R6 |
| Replace the judge with Rishi's labels for that task | The most faithful result | Labelling time |
| Report the judge's score corrected by its measured true-positive and true-negative rates, with a caveat | Keeps the result in view | Rests on a small label set |
| Use the judge for ranking only | Some signal | Absolute numbers. This relies on Thakur's finding that weak judges still rank systems reasonably |

The gate statistic is a separate choice: a point estimate, the lower bound of its interval, or "within Rishi's own self-consistency".

## Twenty tasks set a detection floor that more trials cannot lower

### Trials of one task are not independent samples

Miller's breakdown is the standard way to think about this. The variance of a mean score is (Var(x) + E[σ²]/K)/n:

- Var(x) is how much tasks differ in difficulty.
- E[σ²] is the average trial-to-trial variance within a task.
- K is trials per task and n is the number of tasks.

"Increasing n reduces both terms. Increasing K reduces only the conditional-variance term." In Miller's worked example, four trials per task halve the variance, and no number of trials can cut it by more than two-thirds ([Miller](https://arxiv.org/html/2411.00640)).

The intraclass correlation (ICC) is the share of variance that sits between tasks rather than within them. On agent benchmarks, measured with 64 trials per question, it runs **0.30 to 0.77** ([Mustahsan et al.](https://arxiv.org/html/2512.06710v1)). From the standard design-effect formula, 20 tasks × 20 trials at ICC 0.5 turns a naive ±4.9-point interval into a true one of about **±16 points** (my calculation).

This is not a technicality. On nested data, conventional tests produced false positives over **45%** of the time at a nominal 5%, rising toward 96% with many trials per unit. Analysing per-unit means or a hierarchical bootstrap both brought the rate back to about 5% ([Saravanan et al.](https://www.biorxiv.org/content/10.1101/819334v1.full)). A NeurIPS 2026 study found that naive 95% intervals on pseudo-replicated data covered the truth only 13% of the time ([Coordinated, Not Independent](https://neurips.cc/virtual/2026/178172)). D10's worry is correct, and now it has numbers.

### The task is the pairing unit, and three tests fit it

Trial j of config A and trial j of config B share nothing but the task, so pairing them is arbitrary. The natural paired observation is the per-task difference in pass rate, d_i = p_A,i − p_B,i, which is what Miller and the inspect_evals maintainers recommend ([Abbas et al.](https://arxiv.org/html/2507.06893v1)). Using it absorbs both the repeats and the clustering.

The evidence supports three valid ways to test the 20 d_i values, plus a fourth as a model-based cross-check, and does not crown one:

- **Paired t-test with 19 degrees of freedom.** Inspect also uses clusters minus one degrees of freedom ([Inspect metrics](https://inspect.aisi.org.uk/metrics.html)).
- **Exact sign-flip permutation test.** All 2^20 ≈ 1.05 million sign patterns can be enumerated in milliseconds, and the test needs no normality assumption.
- **Hierarchical bootstrap.** Resample tasks, then trials within each task. METR resamples task families, then tasks, then attempts ([METR](https://metr.org/notes/2026-03-20-impact-of-modelling-assumptions-on-time-horizon-results/)).
- **Logistic mixed model** with a random intercept per task, as a model-based cross-check.

The trade-offs are documented. Collapsing to per-unit means controls false positives but "greatly reduces the statistical power" compared with the hierarchical bootstrap. The bootstrap, in turn, is conservative when tasks barely differ and wide with only 20 units ([Saravanan et al.](https://www.biorxiv.org/content/10.1101/819334v1.full)). Both per-task rates and the bootstrap handle unequal trial counts after infra exclusions; pairing at the trial level cannot.

McNemar's test needs a genuine one-to-one pairing. Applied to each task's majority outcome, it has at most 20 pairs, and a two-sided p < 0.05 needs a **6–0 split** of the tasks where the configs disagree. A 5–0 split gives p = 0.0625 (my calculation from the exact binomial; [McNemar's test](https://en.wikipedia.org/wiki/McNemar%27s_test)). D10's lean, resampling tasks then trials within them, matches METR's practice. The evidence rules out treating trials as independent but leaves the choice of primary test among these options open.

### Power analysis says buy tasks, not trials

Miller's formula for the minimum detectable effect is δ = 2.80·√((ω² + (σ_A² + σ_B²)/K)/n) at α = 0.05 and 80% power ([Miller](https://arxiv.org/html/2411.00640)). Here ω² is how much the A–B difference varies across tasks, and σ_A² and σ_B² are the within-task variances.

Plugging in Miller's illustrative variances at n = 20 gives **42 points** with one trial per task, **24 points** with ten, and **21 points** with infinitely many. If the two configs differ almost uniformly across tasks (ω² ≈ 0.01), the floor falls to 13 points at K = 10 and **6.3 points** in the limit. These are my calculations from the formula, not figures from any source.

The often-quoted figure that 9 runs detect a 2-point gain does not transfer. It applies to means over 500 SWE-bench tasks with a run-to-run standard deviation of 1.5 points ([Bjarnason et al.](https://arxiv.org/html/2602.07150)). A September 2026 study ran six agent–model pairings 52 times each on one task and found that "identical runs of one pairing varied more than the pairings differed from one another" ([Identical Runs, Different Results](https://arxiv.org/abs/2609.33812)). The ICC paper's advice for a fixed budget is to add tasks rather than trials. It notes that T ≥ 5 trials "substantially stabilizes estimates" and that ICC estimates settle by 8 to 16 trials on structured tasks ([Mustahsan et al.](https://arxiv.org/html/2512.06710v1)).

For D9 (the axis and N), the pilot's job is therefore to estimate ω² and E[σ²], then report the detectable effect as a curve over K. Whatever axis is chosen, an effect expected to be small will most likely come out "undetermined". Pilot variance on a cheaper model may also differ from the final model's.

Two secondary metrics raise the signal. The first is pass^k, the chance that all k trials of a task pass. It shows consistency that the pass rate hides. GPT-4o's pass^1 of 61.2% on tau-bench retail fell below 25% at pass^8 ([tau-bench](https://arxiv.org/html/2406.12045)). At 75% per-trial success, pass^3 is about 42% ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). For an assistant giving financial advice, consistency is the property a user actually experiences. The second is continuous scores, such as partial credit, steps and cost, which carry more signal than pass/fail.

Temperature should stay at its deployment value. Miller's rule is "Don't touch the thermostat!" Temperature 0 did not lower run-to-run variance for agents: the standard deviation reached 1.8 points at T = 0 ([Bjarnason et al.](https://arxiv.org/html/2602.07150)). The reason is that inference kernels are not batch-invariant. 1,000 temperature-0 completions of one prompt produced 80 distinct outputs ([Thinking Machines](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)). Once variation from the judge, the prompt and temperature is counted, naive standard errors are **40% to 60%** too small ([Messing](https://arxiv.org/abs/2604.11581)).

### "Just noise" needs its own verdict, backed by an A/A run

Individual per-task deltas are uninformative at realistic N. With 10 trials each, 7/10 against 3/10 is a 40-point difference, yet its Newcombe 95% interval runs from **−3 to +67 points** and includes zero (my calculation; Newcombe's hybrid Wilson method is the recommended interval for a difference of two proportions, per [Epi::ci.pd](https://search.r-project.org/CRAN/refmans/Epi/html/ci.pd.html)). Holm's correction across 20 tasks requires the smallest p-value to fall below **0.0025** ([Holm–Bonferroni](https://en.wikipedia.org/wiki/Holm%E2%80%93Bonferroni_method)), which per-task tests at N = 10 almost never reach. Even on MMLU, 3 of 8 adjacent rank gaps stopped being significant after correcting for 36 comparisons ([evalci](https://arxiv.org/abs/2607.04429)). The defensible presentation is one pre-registered headline test, with per-task deltas shown as descriptive.

Three tools make the "noise" claim explicit:

- **An A/A run.** The same config is run twice and analysed with the identical statistic. Experimentation platforms recommend 5 to 10 A/A runs and checking that the p-values come out roughly uniform ([Statsig](https://statsig.com/blog/how-to-aa-test)).
- **A two one-sided tests (TOST) equivalence check** against a smallest effect of interest, declared before the run. Equivalence holds when the 90% interval lies inside ±that effect ([TOSTER](https://cran.r-project.org/web/packages/TOSTER/vignettes/IntroductionToTOSTER.html)).
- **Kotawala's resolution ratio**, which states whether the design could have detected the gap at all. "q<1 does not assert equality" ([Kotawala](https://arxiv.org/html/2605.30315v1)).

Together they give four verdicts:

- A beats B
- equivalent within the declared effect
- different but too small to matter
- undetermined at this design's detectable effect

SP6's done-when test (an A/A run plus a synthetic known difference) already matches the core. The literature adds repeated A/A runs and makes "undetermined" a first-class outcome.

### Infra failures get a third outcome, never a silent drop

The convention that has emerged gives every trial one of three outcomes. Running out of context and agent timeouts count as genuine failures. Provider and infrastructure errors are excluded from scoring, are not resampled, and are reported. In DeepSWE these exclusions ran from 0% to 5.3% depending on configuration ([DeepSWE](https://arxiv.org/pdf/2607.07946); [Epoch](https://epoch.ai/benchmarks/deepswe)).

Infra error rates depend on the config itself. On Terminal-Bench 2.0, Anthropic measured infra errors at **5.8%** with 1x resources and **0.5%** uncapped, and a **6-point** gap in pass rate between the least and most generously resourced setups ([Anthropic infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise)). Counting infra errors as failures would therefore let an artefact pose as a capability difference. Dropping them silently biases the pass rate upward, because "most tasks that crashed at 1x would have failed anyway". A sensitivity analysis that counts infra errors as failures bounds the result: if the verdict flips, the verdict is "undetermined".

Inspect warns that retrying errored samples "can cause distribution shift" ([Inspect](https://inspect.aisi.org.uk/handling-errors.html.md)). Retried and first-attempt trials should therefore be compared, not merged unexamined.

## Harness and infrastructure confounds rival the effects under test

### Scaffold swaps move scores as much as model swaps

The reported effects of changing only the scaffold are large:

- Epoch's February 2026 scaffold upgrade alone moved GPT-5 by up to 11 points and Kimi K2 Thinking by up to 15, according to secondary reporting ([The Decoder](https://the-decoder.com/?p=30762)).
- A May 2026 position paper collects HAL runs on SWE-bench Verified Mini where Claude Sonnet 4.5 fell from **68% to 34%** and GPT-5 Medium from 46% to 12% across scaffolds. It also cites a controlled factorial in which "6 of 9 model-pair/harness-pair comparisons reverse rank" ([Stop Comparing LLM Agents Without Disclosing the Harness](https://arxiv.org/html/2605.23950v1)).
- On Terminal-Bench 2.1, switching from the Codex harness to Terminus 2 with the same model cut accuracy by up to **29.9 points**. Raising the per-task budget closed the gap, which makes the budget a confound in its own right ([ICML 2026](https://icml.cc/virtual/2026/82793)).

The Terminal-Bench authors still conclude that "model selection is usually more important than agent scaffold" ([Terminal-Bench 2.0](https://arxiv.org/html/2601.11868)). The honest summary is that the two effects are of the same order and can reverse rankings, so they have to be measured on one's own tasks. Harness-Bench recommends reporting capability for each model–harness pairing ([Harness-Bench](https://arxiv.org/pdf/2605.27922)).

Quieter confounds stack on top:

- **Reasoning effort.** In 21 of 36 HAL combinations, higher reasoning effort gave equal or *lower* accuracy. LiteLLM applied a default 4,096-token reasoning budget to Anthropic models, while OpenAI does not disclose its budgets ([HAL](https://arxiv.org/html/2510.11977)).
- **Prompt wording.** Rewordings that preserve meaning produced paired standard deviations **11 to 58 times** larger than plain reruns ([Noise Floor Audit](https://arxiv.org/abs/2608.22331)).
- **Skills.** Anthropic's docs say skill metadata is loaded "at startup and includes it in the system prompt", at about 100 tokens per skill ([Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)). The project's own Hermes audit measured about 2,000 extra tokens per call with memory and skills enabled (`docs/known-limits.md`).

Turning a capability "on" is therefore never a single-axis change at the level of the request. That is why D9 already frames memory as on-and-empty against on-and-seeded. The position paper's disclosure standard holds task order, environment, evaluation script, API parameters and stopping rules constant, and it lists tool list and schema style as their own disclosure layer. That last point bears on D14 (how task tools reach every harness).

### No surveyed platform pins the whole configuration

The platforms fall into two families. Research harnesses, namely Inspect, Harbor and Vivaria, treat the trial, its sandbox and its limits as first-class records. Commercial tools, namely LangSmith, Braintrust, Weave, Phoenix, DeepEval and promptfoo, treat repetitions as a count on an experiment and leave sandboxing and infra-failure classification to the user.

The field is consolidating:

- METR archived its Task Standard on 7 Oct 2026 and now uses Inspect ([METR](https://github.com/METR/task-standard)).
- HELM entered maintenance mode on 1 Jun 2026 ([HELM](https://crfm-helm.readthedocs.io/en/latest/)).
- OpenAI's hosted Evals became read-only on 31 Oct 2026 and shuts down on 30 Nov 2026, with promptfoo as the migration path ([OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)).

None of the surveyed platforms hashes the harness version, model snapshot, actual system prompt and tool list together as one unit. The nearest are Inspect's config export and Harbor's per-trial "replayable trial lock" ([Inspect logs](https://inspect.aisi.org.uk/eval-logs.html); [Harbor](https://docs.harborframework.com/results/view-job-results.md)). The plan's invariance diff and config content hash fill a real gap.

Reproducibility also leaks at the provider:

- OpenAI's seed is "best effort", and `system_fingerprint` changes "a few times a year" ([OpenAI cookbook](https://developers.openai.com/cookbook/examples/reproducible_outputs_with_the_seed_parameter)).
- Anthropic offers no seed. Inspect's seed support lists OpenAI, Google and others, but not Anthropic ([Inspect model reference](https://inspect.aisi.org.uk/reference/inspect_ai.model.html)).
- HAL documents providers swapping weights silently, aggregators serving "different quantizations under the same endpoint name", and o3's price dropping 80% after release ([HAL](https://arxiv.org/html/2510.11977)).

The quantization point bears directly on D5 (hosting the open-weight model through OpenRouter or locally).

Response caches are a replay, not a sample. promptfoo caches by default with a 14-day lifetime, LangSmith's test cache reuses responses across experiments, and LiteLLM's exact-match cache returns the stored response with an `x-litellm-cache-key` header ([promptfoo](https://www.promptfoo.dev/docs/configuration/caching/); [LangSmith](https://docs.langchain.com/langsmith/experiment-configuration.md); [LiteLLM](https://docs.litellm.ai/docs/proxy/caching)). Recording that the header is absent on every trial call would prove the no-cache rule held.

Provider prompt caching is different. Anthropic states it "has no effect on output token generation" ([Anthropic prompt caching](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)). It does change cost and latency, though, and LiteLLM silently skips it below provider minimums ([LiteLLM prompt caching](https://docs.litellm.ai/docs/completion/prompt_caching)). Cross-provider latency comparisons therefore need the share of cached input reported alongside them.

### Container per trial is the research norm, and its resources become a variable

Every research harness surveyed isolates at the container level. Inspect gives "each sample its own sandbox instance", Harbor "runs each trial in an isolated environment", and Vivaria runs "each agent inside its own agent container" for evals ([Inspect sandboxing](https://inspect.aisi.org.uk/sandboxing.html); [Harbor](https://docs.harborframework.com/tasks/configuration.md); [Vivaria](https://vivaria.metr.org/glossary/)).

The documented leaks are concrete:

- Claude examined git history from earlier trials that shared state ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- Agents searched HuggingFace for the benchmark's answers ([HAL](https://arxiv.org/html/2510.11977)).
- Inspect warns that its no-network mode applies only inside the container, so "code in custom tools, agents, or scorers can still reach the internet outside the sandbox".

No surveyed doc addresses a harness's own home directory or memory store persisting between trials, so for Hermes that has to be designed in.

For D3 (trial isolation), the evidence makes a container per trial the documented norm. None of the surveyed research harnesses accepts process-level isolation for evals. The cost is that container resources become an experimental variable, given the 6-point resource effect above, so CPU and memory limits have to be pinned and recorded. Tools served from outside the container, whether through MCP or native functions, escape the container's network policy. For pure calculation tools that risk is small, but it is worth stating.

### Cost and latency attribution leaks through retries and caches

LiteLLM returns a per-response cost header and supports request tags, which is enough to separate agent spend from judge spend per trial. Its spend-log endpoints cap at 10,000 rows, record $0 when pricing is missing, and do not document whether retried upstream attempts are billed ([LiteLLM cost tracking](https://docs.litellm.ai/docs/proxy/cost_tracking)). Storing the per-call cost and usage object in the trial record is more reliable than aggregating spend logs.

HAL warns that "latency measurements may be inflated by rate-limit errors from massively parallel runs". It also found that dollar-cost and token-count frontiers "tell different stories": Claude Opus 4.1 sat on three of eight token frontiers but only one cost frontier ([HAL](https://arxiv.org/html/2510.11977)). Latency belongs next to the retry count, and cost next to tokens.

## Humans own the calls that automation still gets wrong

### Failure analysis automates labelling but not localisation

The dominant method is borrowed from grounded theory:

1. A domain expert reads about 100 traces and writes free-text notes on the *first* failure in each, because upstream errors cause downstream ones.
2. The notes are grouped into a counted taxonomy.
3. Reading stops when new traces stop revealing new failure types.
4. Only then are graders built.

The FAQ warns against writing the rubric before reading examples ([AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/)).

MAST, the best-validated taxonomy, has 14 failure modes across 1,642 traces, with three human annotators agreeing at kappa **0.88**. Its largest modes are step repetition (15.7%), reasoning that does not match the action taken (13.2%) and being unaware of termination conditions (12.4%). Premature termination is 6.2% ([MAST](https://arxiv.org/html/2503.13657v3)).

The parking-lot categories map onto measured buckets:

| Platform category | Measured equivalent |
| --- | --- |
| Wrong tool | tau-bench's "wrong decision" (25%) |
| Hallucinated arguments | tau-bench's "wrong argument" (33.3%) |
| Gave up early | METR's "early return" (12% of 152 failed GPT-4o runs) ([METR](https://metr.org/evaluations/gpt-4o-report/)) |
| Loop or step exhaustion | MAST's repetition and termination modes. About 31% of SWE-agent runs hit the $4 budget ([SWE-agent](https://arxiv.org/html/2405.15793)) |
| Grader disagreement | No agent-taxonomy equivalent. It belongs to judge validation |

Automation works for *classifying* failures but not for *locating* them:

- An o1-based labeller reached kappa **0.77** against MAST's experts but recall of only 0.77, so it under-detects.
- On the Who&When benchmark, the best method named the responsible agent 53.5% of the time but the step where the failure began only **14.2%** of the time ([Who&When](https://arxiv.org/abs/2505.00212v3)).
- Rule-based detection of looping and thrashing reached kappa 0.68 to 0.80 against a second human ([Coherence Collapse](https://www.alphaxiv.org/abs/2603.24631.md)).
- A plain threshold on trace statistics, with no model call, caught **52.9% to 61.5%** of failures, while LLM judges missed 6.5% to 18.1% of human-confirmed failures ([Failing Agents Leave Traces](https://aclanthology.org/2026.realm-1.56/)).

The practical stack is rules first for loops, budget exhaustion and schema errors, an LLM for categorising, and a human for where things went wrong. Two open decisions are affected. Schema-level checks for hallucinated argument names and types need structured tool calls ([ToolScan](https://arxiv.org/html/2411.13547v2)), which a CLI shell string makes harder (D14). Husain's advice to "test the tool name, arguments, result, and resulting state as separate checks" needs those fields to stay separable in the trace format (D12).

### What humans catch that judges and rules miss

The sharpest 2026 evidence comes from a deployed ordering agent audited by exhaustive human review. Its built-in judge surfaced **2 of 9** systematic defect patterns that humans confirmed. In a second batch, the operational gate flagged 0 of 100 rounds while humans confirmed 23 defects. The judge caught problems within a single turn and missed state carried across turns, such as hallucinated cart contents. **113 of 114** rounds with cart or confirmation defects were filed under "brand voice" because the rubric had no category for state tracking. The authors conclude that "automated judging is a regression floor, not a substitute for human review" ([Catching One in Five](https://arxiv.org/abs/2606.10315)).

Reward hacking shows the same dependence on people. METR routes every automatically flagged run to manual review because both its heuristics and its monitors "have high false-positive rates". It found o3 hacking in 30.4% of RE-Bench runs, and recognising a hack "often requires domain knowledge and careful code reading" ([METR](https://metr.org/blog/2025-06-05-recent-reward-hacking)).

Some calls only a human can make. Claude Opus 4.5 found a loophole in tau2-bench's policy and solved a booking "in a better way than the eval expected", yet it failed as written ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). For GPT-5.6 Sol, METR's 50% time horizon was **11.3 hours** when cheating counted as failure, over **270 hours** when it counted as success, and 71 hours when cheating attempts were discarded ([METR](https://metr.org/blog/2026-06-26-gpt-5-6-sol/)). How to label such trials is an analysis-plan decision that must be fixed before results exist. Fewer than one run in 20 broke data rules in the September 2026 repeated-runs study, yet those runs had the highest scores, which argues for reporting compliance next to quality ([Identical Runs](https://arxiv.org/abs/2609.33812)).

Five decisions recur across these sources, and none has been automated with reported accuracy above about 90%:

- whether a task is solvable and unambiguous
- what the criteria are
- whether the grader agrees with an expert on a sample
- whether a flagged run is a hack, a grader bug, a genuine failure or a better-than-expected solution
- how large a difference has to be before it matters

### Human validation is expensive, and single raters are noisy

Task validation has consistently cost more than its builders expected:

- Terminal-Bench 2.0 spent about **3 reviewer-hours per task**. Each task went through three reviewers, an exploit agent whose every trajectory was read, and a final two-reviewer audit ([Terminal-Bench 2.0](https://arxiv.org/html/2601.11868)).
- TheAgentCompany took about 3,000 person-hours for 175 tasks ([TheAgentCompany](https://arxiv.org/html/2412.14161)).
- Two independent annotators agreed on only **55%** of GAIA's newly written questions ([GAIA](https://arxiv.org/html/2311.12983)).
- OSWorld's maintainers concluded that "providing reliable rewards consumes more human resources than we imagined" ([xlang.ai](https://xlang.ai/blog/osworld-verified)).

The cheapest credible check for a 20-task set is METR's: a second person attempts each task blind, with only the resources the agent has ([METR QA](https://taskdev.metr.org/quality-assurance/)).

A single rater is accepted practice. Husain recommends one domain expert as a "benevolent dictator" for small teams ([AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/)). It is not free of error, though. In Agent-as-a-Judge, three experts disagreed with each other on 10% to 30% of items, and one of them erred on 23.77% of one system's items ([Agent-as-a-Judge](https://arxiv.org/html/2410.10934)). Seeing model output while labelling also makes human labels less reliable ([Hardy](https://arxiv.org/abs/2411.15634)), which justifies the plan's blind labelling view. The limit to state plainly is that no human–human ceiling exists here, only Rishi's own consistency with himself.

## How the evidence bears on the open decisions

The table maps findings onto the decisions still open in `docs/decisions.md`. It states what the research settles and what it leaves to Rishi. It does not choose.

| Decision | What the evidence establishes | What it leaves open |
| --- | --- | --- |
| D3 Trial isolation | Inspect, Harbor and Vivaria all isolate with a container per trial. Documented leaks come through shared state and tools that run outside the sandbox. No surveyed doc covers a harness's home directory. Container resource limits alone moved Terminal-Bench pass rates by 6 points | Container (the norm; needs the Docker socket and pinned resource limits) or process (simpler; not used for evals by any surveyed research harness) |
| D4, D5 and the judge's model | Judges recognise and favour their own family's output, even when names are hidden. Aggregators can serve different quantizations under one endpoint name | Judge from a family outside the graded configs, two judges from different families, or the same family with an explicit per-config check. Hosted open-weight (reproducibility risk) or local (setup cost) |
| D7 Tasks using the judge | The field confines judges to narrow criteria. Each judged criterion needs about 100 labels for ±10-point precision. Continuous partial credit carries more signal than pass/fail | How many criteria are judged, and how they combine with the tool-call check: all-pass product, separate reporting, or weighted partial credit |
| D8 Judge threshold and fallback | No principled universal threshold exists. The anchors are human–human agreement or the rater's own consistency. There is a standard order of remedies, and scores can be corrected using the judge's true-positive and true-negative rates | Which statistic gates, at what value, judged on the point estimate or the interval bound. The fallback: leave the headline, use human labels, report corrected with a caveat, or use for ranking only |
| D9 Experiment axis and N | At 20 tasks the detectable effect is about 6 to 25 points. Enabling memory changes the prompt. The matched-control design is published (SkillsBench, CL-Bench). Harness effects are large but confounded by budget and tool parity. A model axis is not pure in Hermes, because the model name appears in the prompt | Which axis plausibly produces an effect above the detection floor. N chosen from the pilot's estimates of ω² and E[σ²] |
| D10 Unit of analysis | Treating trials as independent pushes false positives above 45%. The task is the pairing unit. McNemar on 20 tasks needs a 6–0 split | Primary test: per-task means with a permutation or t-test, a hierarchical bootstrap, or a mixed model. The others serve as cross-checks |
| D12 Trace format | Failure analysis needs the first failing step, with tool name, arguments, result and resulting state as separate fields. Harbor's ATIF is one existing schema with per-step tool calls and observations | Which standard. The separate R4 trace research covers this |
| D14 How tools reach each harness | Tool list and schema style are their own source of confounding. Schema checks for hallucinated arguments need structured calls. Tools served outside the sandbox escape its network policy | MCP, a CLI through each harness's terminal tool, or native functions per adapter |

## Conclusion

The 2026 literature changes what makes an eval platform credible. Credibility comes from catching its own instrument errors, not from the number of harnesses or tasks it supports. The checks the field now says are missing are already in Rishi's plan: a record of the actual prompt and tool list behind every result, judge agreement reported per config, a rater self-consistency check, an A/A noise floor, and a verdict that can say "we cannot tell". These sit exactly where published benchmarks and platforms have failed. That is the strongest framing for the interview: the platform's contribution is measurement hygiene at those points, and each piece answers a documented failure.

The second implication concerns what a good result looks like. With 20 tasks, an honest single-axis experiment will often end "undetermined". A platform that says so, with its detectable effect and A/A floor printed beside the verdict, is working correctly. One that treats 400 trials as 400 samples and reports a 10-point win is repeating the mistake the noise papers document. The domain adds a twist. Its emotionally loaded scenarios are the condition under which judge robustness fell lowest in the bias studies, so the deterministic tool-call half of each task will probably carry the headline. The judged half has to earn its place by being validated, not by being numerous.
