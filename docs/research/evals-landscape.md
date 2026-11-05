# How this platform compares with ten widely used eval frameworks (5 Nov 2026)

Asked by Rishi: "find 10 top evals codes out there ... and do a comparison of whether we are even in
the ballpark in terms of design and thoughts". Researched from each project's own docs and READMEs
on 5 Nov 2026 (and the code of OpenAI Evals' `metrics.py`, lm-eval's `metrics.py` and HELM's
`run.py`). "n/d" means not documented in the pages read, not proven absent.

**Why these ten:** model-benchmark harnesses (OpenAI Evals, lm-evaluation-harness, HELM), agent
benchmarks and frameworks (Inspect, τ-bench, SWE-bench), and the most used app-eval / LLMOps tools
(promptfoo, DeepEval, LangSmith with AgentEvals, Braintrust with autoevals). Ragas is RAG-only;
Phoenix, TruLens, Weave and MLflow are observability-first and overlap LangSmith and Braintrust.
Miller (2024) and Anthropic's agent-evals post are used as the measure of good practice.

## 1. Comparison

**Method**

| | Trials / pass@k | Statistics | A/B of two configs | LLM judge; validated against humans? | Deterministic graders | Failure categories |
|---|---|---|---|---|---|---|
| **Ours** | N per task (10) | task bootstrap CI, exact sign-flip, BH, ±10 equivalence, A/A, power simulation | paired verdict + critical guardrail | yes; κ, Se/Sp, per-arm false-pass gap, retest, trust bar, Rogan-Gladen (held-out not yet run) | tool numbers, tool args, required tools, figure provenance, unit tests | rule-based, 10 causes |
| OpenAI Evals | n/d | "bootstrap" std of accuracy | no (pairwise judge only) | yes; optional meta-eval, accuracy vs human choice labels | match, includes, fuzzy, JSON | n/d |
| lm-eval-harness | `repeats` | stderr (closed form or bootstrap) | n/d | n/d | exact match, acc | n/d |
| Inspect | epochs; pass@k, pass^k | stderr, clustered stderr, bootstrap, cluster bootstrap; no paired test | CI overlap only | yes, several grader models; validation n/d | match, includes, pattern, f1 | Scanners (LLM or grep) |
| promptfoo | `--repeat` | none documented | side-by-side matrix; PR before/after | yes (llm-rubric, g-eval); validation n/d | many, incl. tool args, tool sequence, cost, latency | n/d |
| DeepEval | `-r` | none documented | n/d | yes (G-Eval, DAG); validation n/d | DAG; ToolCorrectness | n/d |
| LangSmith + AgentEvals | `num_repetitions`, std | std only | regressions vs baseline | yes; Align Evals: % agreement with human labels | trajectory match | Insights (LLM clustering) |
| Braintrust + autoevals | trials grouped by input | none documented | deltas, regression counts | yes; validation n/d | Levenshtein, NumericDiff, JSONDiff | n/d |
| HELM | few-shot draws, not repeats | n/d | leaderboard | annotators; MedHELM jury ICC 0.47 vs clinicians | exact match, ROUGE | n/d |
| τ-bench | trials; pass^k | pass^k; no CI | leaderboard | NL-assertion judge (v2); validation n/d | database end state vs goal | LLM fault type |
| SWE-bench | n/d | resolved % | leaderboard | none | repository tests | infra / ambiguous / unresolved |

**Infrastructure**

| | Traces | Isolation | Cost / latency | Agents and tools | Reproducibility, caching |
|---|---|---|---|---|---|
| **Ours** | OpenTelemetry spans, trace UI | container per harness; fresh process and wiped folder per trial; read-only root; internal network; key and budget per trial | per trial from the proxy; paired intervals | 5 harnesses, one contract; MCP tools; simulated client | content hashes, pinned SHA; no response cache |
| OpenAI Evals | JSONL event log | n/d | n/d | Completion Function Protocol | registry in Git-LFS |
| lm-eval-harness | `--log_samples` | n/d | n/d | n/d | `--seed`; opt-in response cache |
| Inspect | log viewer | sandbox per sample; Docker `network_mode: none` | token, time, cost limits | agent bridge (Agents SDK, LangChain, Pydantic AI, Claude Code, Codex) | opt-in cache, scoped per epoch |
| promptfoo | OTLP receiver and viewer | n/d | cost and latency assertions | trajectory assertions | cache on by default, one namespace per repeat |
| DeepEval | `@observe` spans | n/d | n/d | task completion, tool and argument correctness | opt-in result cache |
| LangSmith | core feature | n/d | tokens and cost per trace | trajectory evaluators | n/d |
| Braintrust | trace views | n/d | duration, tokens, cost | via tracing | n/d |
| HELM | web UI | n/a | efficiency metrics | n/d | request cache on by default |
| τ-bench | `tau2 view` | n/d | n/d | LLM user simulator | frozen task sets |
| SWE-bench | build and eval logs | Docker per instance | n/d | grades patches from any agent | results cached by run_id |

## 2. Where we are in the ballpark

- **Repeated trials per task** are standard (Inspect, promptfoo, LangSmith, DeepEval, lm-eval, τ-bench); Anthropic says to run several trials.
- **Deterministic checks first, the judge for meaning:** the layered stack of promptfoo, DeepEval, Braintrust and Inspect, and Anthropic's code / model / human grader types. Our D63 rule writes it down.
- **Tool calls checked with their arguments:** promptfoo `trajectory:tool-args-match`, DeepEval ToolCorrectness, AgentEvals trajectory match.
- **One proxy as the choke point, many harnesses behind one contract:** Inspect's agent bridge does the same; good company, not novel.
- **Container per unit, network off:** Inspect (`network_mode: none` per sample), SWE-bench (Docker per instance).
- **Simulated user and end-state grading:** τ-bench.
- **Infra failures kept apart from agent failures:** SWE-bench reports likely infrastructure failures separately.
- **Statistics with Miller's structure:** average each task's resamples, infer on paired per-task differences, tasks treated as drawn from a population.

## 3. Where we go beyond common practice

(None of the ten documents these; weaker than proof that none has them.)

- **A paired significance test that gives a verdict.** LangSmith and Braintrust show deltas and regression counts; Inspect's `ci()` is pitched as checking whether two intervals overlap, the unpaired comparison Miller recommends replacing. We add an equivalence margin, a "not ruled out" bound, Benjamini-Hochberg per-task flags and a critical-failure guardrail. Clustered statistics are not unique (Inspect has them).
- **Judge validation in depth.** Others report raw accuracy (OpenAI Evals meta-eval), percent agreement (LangSmith Align Evals) or ICC (MedHELM). None documents κ with an interval, sensitivity and specificity, a per-arm false-pass gap, test-retest, a trust bar set in advance or a judge-error correction. Caveat: held-out validation has not run; on the tuning set the overall criterion scored κ 0.30, specificity 0.20, so far the process has caught a lenient judge, not certified a good one.
- **A/A calibration, a pre-registered positive control and a frozen analysis plan.**
- **Intervals on cost, token and time differences,** with retried trials left out of latency.
- **Failure causes from rules,** free and deterministic (τ-bench, Inspect Scanners and LangSmith Insights use models; τ-bench warns its LLM fault labels may be inaccurate). Only as good as the rules.
- **A provenance check on every figure:** nothing comparable found.

## 4. Where we fall short or are unusual

- **Scale.** Miller suggests at least 1,000 questions for a new eval; τ-bench has 50 tasks per domain; our headline rests on 10 held-out tasks, 5 of which tied (4 at 10 of 10, one at 0 of 10), so the exact sign-flip test could not go below p = 2/2⁵ = 0.0625.
- **The test choice decides the call.** Miller's recipe (paired differences, CLT, t) on our per-task differences (+30, +30, +10, +10, +10 and five zeros): mean 9.0, SE 3.79, t(9) = 2.38, **p = 0.041**, t interval +0.4 to +17.6, which would read "better". Our pre-registered exact test gives 0.0625. Miller calls bootstrapping unnecessary unless sampling is complicated, but assumes many questions; an exact test at K = 10 is defensible. Our percentile interval is narrower than the t interval and covers about 90.5% at K = 10 in our own simulation, so the interval leans anti-conservative while the test is conservative; the verdict needs both, so the test decides.
- **Clustering above the task.** Most client-file tasks share Meera's file; Miller says to cluster on shared material. Not addressed.
- **Power analysis.** A simulated power table (about 50% at K = 10) but no pre-run "smallest detectable difference" from the pilot's spread.
- **We grade the route as well as the result.** Anthropic advises grading outcomes, not paths; our required-tools and provenance checks are partly path checks (deliberate, D54), so the headline measures "used the tools" as much as "gave good advice".
- **Isolation.** Inspect and SWE-bench start a fresh container per sample; we start a fresh process in a fresh folder in a per-harness container (D3).
- **Features mature tools have and we do not:** CI regression gates (promptfoo's PR before/after action), annotation queues (LangSmith), pass^k (Inspect, τ-bench), several grader models or a jury (Inspect, MedHELM), wider model coverage, a development cache that keeps repeats independent (Inspect's per-epoch scope, promptfoo's per-repeat namespaces), production trace analysis.

## 5. Cheap lessons, ranked

1. Add Miller's paired SE and t interval as a labelled sensitivity analysis beside the pre-registered verdict, recorded under Deviations; do not change the verdict.
2. Report pass^k per task and arm from the existing N = 10 (C(c,k)/C(n,k)): "works every time" matters for a finance assistant.
3. For the next experiment, rebuild the held-out set for power: replace ceiling and floor tasks, increase K, treat shared client files as clusters, and compute a pre-run smallest detectable difference.
4. Pre-register a better-covering interval (BCa, bootstrap-t or t) for future runs.
5. A no-spend CI gate: re-grade the shipped example and recorded trials on every PR and fail when grades or statistics drift.

## Sources

OpenAI Evals: https://github.com/openai/evals, https://github.com/openai/evals/blob/main/docs/eval-templates.md, https://github.com/openai/evals/blob/main/docs/build-eval.md, https://github.com/openai/evals/blob/main/evals/metrics.py.
lm-evaluation-harness: https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/interface.md, https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/task_guide.md, https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/api/metrics.py.
Inspect: https://inspect.aisi.org.uk/metrics.html, https://inspect.aisi.org.uk/scorers.html, https://inspect.aisi.org.uk/sandboxing.html, https://inspect.aisi.org.uk/caching.html, https://inspect.aisi.org.uk/agent-bridge.html, https://inspect.aisi.org.uk/setting-limits.html, https://inspect.aisi.org.uk/scanners.html, https://inspect.aisi.org.uk/log-viewer.html.
promptfoo: https://www.promptfoo.dev/docs/configuration/expected-outputs/, https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/, https://www.promptfoo.dev/docs/configuration/caching/, https://www.promptfoo.dev/docs/usage/command-line/, https://www.promptfoo.dev/docs/tracing/, https://www.promptfoo.dev/docs/integrations/github-action/.
DeepEval: https://deepeval.com/docs/evaluation-flags-and-configs, https://deepeval.com/docs/metrics-introduction, https://deepeval.com/docs/metrics-tool-correctness, https://deepeval.com/docs/evaluation-llm-tracing.
LangSmith and AgentEvals: https://docs.langchain.com/langsmith/repetition, https://docs.langchain.com/langsmith/compare-experiment-results, https://docs.langchain.com/langsmith/improve-judge-evaluator-feedback, https://docs.langchain.com/langsmith/cost-tracking, https://docs.langchain.com/langsmith/insights, https://github.com/langchain-ai/agentevals.
Braintrust and autoevals: https://docs.braintrust.dev/evaluate/compare-experiments, https://docs.braintrust.dev/guides/evals/interpret, https://github.com/braintrustdata/autoevals.
HELM: https://github.com/stanford-crfm/helm, https://github.com/stanford-crfm/helm/blob/main/src/helm/benchmark/run.py, https://github.com/stanford-crfm/helm/blob/main/docs/medhelm.md, https://arxiv.org/abs/2505.23802.
τ-bench: https://github.com/sierra-research/tau-bench, https://arxiv.org/abs/2406.12045, https://github.com/sierra-research/tau2-bench.
SWE-bench: https://github.com/SWE-bench/SWE-bench, https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/evaluation.md.
Miller (2024), Adding Error Bars to Evals: https://arxiv.org/html/2411.00640, https://www.anthropic.com/research/statistical-approach-to-model-evals.
Anthropic, Demystifying evals for AI agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents.
