# Agent Evals Platform: build spec

Deadline: Saturday 7 Nov 2026. Platform freeze: Friday 6 Nov, morning.
Working rules for Claude Code are in `CLAUDE.md`. Decision status is in `docs/decisions.md`.

## Goal

Build a platform that evaluates any harness running with any model, and answers one question with evidence: did the agent get better, worse or stay the same, and how sure are we?

The target is the eval system, not the agent. Harnesses are things it plugs in. Their internals matter only so far as they can invalidate a comparison, so when one setting changes, nothing else may change unnoticed.

The brief's rubric: eval methodology, abstraction, observability, engineering quality, judgment. The brief says it cares "more about sound evaluation design than about feature count".

## Fixed constraints

- API: NestJS with TypeScript. UI: Vue 3 with TypeScript. A functional UI is enough.
- Harness workers may be Python. Hermes needs Python 3.14.
- Runs locally with one command, for example `docker compose up`, with keys from `.env`.
- Models go through LiteLLM.
- Hermes is used as it comes, at pinned SHA `6112c2adb9e11f69734a29be9d2696f345ffa06a`.
- LLM budget: about $100 on the Claude API, about $50 on OpenAI or Gemini, plus a small OpenRouter top-up if D5 goes hosted.

## Out of scope

Auth, multi-user, multi-node workers, live streaming (polling is fine), and rich config or task editors. Configs and tasks are files in git, plus a simple form for the video. Add each cut to `docs/assumptions.md` with its reason.

## Proposed repo layout

To confirm in SP0. It may change with D1 and D2.

```text
CLAUDE.md
README.md
docker-compose.yml
.env.example
apps/api/          NestJS control plane
apps/ui/           Vue 3 UI
workers/           Python harness workers and adapters
tasks/             Task set, one folder per task
configs/           Versioned configs
labels/            Rishi's hand labels only
experiments/       Exported results for the real experiment
docs/              See the docs register
```

## Docs register

These are the documents we need so nothing gets lost. **Required** means the brief asks for it directly. Start every doc on day one rather than on Saturday.

| Doc | Holds | Why it matters | Update when | Status |
| --- | --- | --- | --- | --- |
| `README.md` | Setup, add a task, add a harness, add a model | **Required** | SP0 onward, finished in SP9 | Not started |
| `docs/design.md` | Architecture, adapter interfaces, data model, isolation and reproducibility, grader design and validation, stats and choice of N | **Required** | Any design change | Started |
| `docs/assumptions.md` | Every assumption made | **Required** | As soon as one is made | Stub |
| `docs/known-limits.md` | Where conclusions should not be trusted | **Required** | As soon as one is found | Seeded |
| `docs/cost.md` | Cost formula, actual spend, how to reduce cost | **Required** | Prices, pilot, final run | Seeded |
| `docs/experiment.md` | Hypothesis, setup, results with CIs, 2 or 3 trajectories, conclusion | **Required** | Plan before the run, results after | Stub |
| Video link in `README.md` | 10 minutes or less: define a config, run it, compare, drill into a failed trial | **Required** | SP9 | Not started |
| `docs/judge-validation.md` | Label set, agreement, kappa, per-config checks | Required content, own file by choice | SP5 | Seeded |
| `tasks/` | The 20+ task set with graders | **Required** | SP4 | Not started |
| `experiments/<id>/` | Exported raw JSON or CSV, config hashes, spend | Evidence behind `experiment.md` | SP8 | Not started |
| `labels/` | Rishi's hand labels, with date and split | Evidence behind `judge-validation.md`, and hard to redo | SP5 | Not started |
| `docs/decisions.md` | Each call: options, choice, why, what would change it | Not required, but it's how Rishi explains the system | Each decision | Seeded |
| `docs/hermes-notes.md` | Measured and unverified Hermes behaviour | Feeds limits and design | Each finding | Seeded |
| `docs/worklog.md` | What was built each day, by whom, and what surprised us | Not required, for clarity on what was built | Each SP | Stub |
| `.env.example` | Key names, never values | Part of one-command setup | Each new key | Not started |
| `CLAUDE.md`, `docs/SPEC.md` | Working rules and this plan | Keeps Claude Code on track | Task or rule changes | Done |

## Brief traceability

Every requirement in the brief, and the sub-project that answers for it.

| Brief item | SP | Evidence |
| --- | --- | --- |
| Hermes as required harness | SP1 | Adapter and trace |
| Second harness proving the abstraction | SP1 | Four adapters: own loop, LangGraph, Google ADK, OpenAI Agents SDK (R1, R5, R7) |
| Two models from different providers, or one open-weight, via a common interface | SP1 | LiteLLM config, smoke test |
| New harness or model means an adapter, not a core change | SP1 | Design doc, README steps |
| Deterministic graders: exact match, unit tests, state checks | SP4 | Grader tests |
| Model-based graders: LLM judge with rubric | SP4 | Grader tests |
| Judge trust shown against human labels | SP5 | `judge-validation.md` |
| Config is harness × model × settings: skills, memory, tools, temperature, step and token budgets | SP2 | Config schema |
| Configs versioned so past results reproduce | SP2 | Content hash, reproduce test |
| Every task under every config, N trials | SP3 | Runner tests |
| Isolated runs, no leaks unless memory setting says so | SP3 | Leak test |
| Timeouts, rate limits, retries, partial failures without corruption | SP3 | Fault-injection tests |
| A vs B with CIs and a paired test | SP6 | Stats tests |
| Per-task deltas, not just an aggregate | SP6, SP7 | Comparison view |
| Clear when a difference is just noise | SP6, SP7 | Verdict, A/A test |
| Cost, latency and tokens next to quality | SP6, SP7 | Comparison view |
| Full trajectory: messages, tool calls and results, memory reads and writes, skills, grader reasoning, score | SP3, SP7 | Trial view |
| Failure analysis (stretch) | Parking lot | Categories over traces |
| TypeScript API and UI, one-command run, keys via `.env` | SP0 | Clean-clone test |
| 20+ tasks, mixed graders, some that separate configs | SP4 | `tasks/` |
| Results persisted and exportable | SP2 | Export test |
| Every assumption documented | All | `assumptions.md` |
| Git repo, production-grade, tested, README | SP0, SP9 | Repo, CI |
| Design document, all six topics | SP9 | `design.md` |
| Known limits | All, SP9 | `known-limits.md` |
| Cost formula and actual spend | SP8, SP9 | `cost.md` |
| One real experiment on one axis | SP8 | `experiment.md` |
| Video, 10 minutes or less | SP9 | Link in README |

## Timeline

| Day | Sub-projects |
| --- | --- |
| Tue 3 Nov | SP0, SP1, SP2 |
| Wed 4 Nov | SP1, SP2, SP3, SP4 |
| Thu 5 Nov | SP4, SP5, SP6, SP7 |
| Fri 6 Nov | Freeze in the morning, then SP5 and SP8 |
| Sat 7 Nov | SP9, submit |

Thursday is the crunch. If it slips, cut UI polish in SP7 before touching SP5 or SP6.

## Sub-projects

Each one has a done-when test. Scope stops growing once that test passes.

### SP0 Foundations (Tue)

**Done when:** `docker compose up` starts every service and CI is green with no LLM spend.
**Needs:** D1, D2 and D3 for the service layout.

- [ ] Rishi creates the GitHub repo, private until submission
- [ ] Add `CLAUDE.md` and the `docs/` files to the repo
- [ ] Set up the monorepo with pnpm and uv
- [ ] Write the compose skeleton and `.env.example`
- [ ] Add LiteLLM: official image `ghcr.io/berriai/litellm`, v1.83.0 or later, pinned by digest
- [ ] Build a fake OpenAI-compatible server for tests
- [ ] Add CI: lint, tests, compose smoke test
- [ ] Rishi checks API rate-limit tiers on each provider
- [ ] Fill in the Commands section of `CLAUDE.md`

### SP1 Harness and model adapters (Tue to Wed)

**Done when:** one task runs through every harness that passed its gate (Hermes and the own loop at minimum) behind the same interface, and a new model is a config line.
**Needs:** SP0, D4, D5, D6. Start from `docs/hermes-notes.md`.

- [ ] **[Rishi designs]** Harness and model adapter interfaces
- [ ] Build the Hermes adapter on the pinned SHA
- [ ] Audit Hermes and record results in `hermes-notes.md`: background skill and memory writes (R3), memory in the prompt vs the trace, temperature, model-name routing, prompt caching through the proxy, token usage in the result
- [ ] Settle the cross-harness trace format (D12, R4)
- [ ] Before fixing the adapter contract, read each SDK's run, tool and settings APIs on paper (about 1 h), so the contract is not shaped only by Hermes and the own loop
- [ ] Build the own plain loop next to Hermes, until one task runs end to end through both
- [ ] Then build LangGraph, Google ADK and the OpenAI Agents SDK in parallel (R7), one agent and one folder each, with tool parity through D14. Each passes the settings test and the tool test by its deadline or is cut with the reason recorded. Cut order: the two SDKs first, LangGraph last, never the own loop. Rishi reviews each before merge.
- [ ] Settle how task tools reach every harness (D14)
- [ ] Register models in LiteLLM and smoke-test tool calling on each
- [ ] Build the invariance diff: the first request of two configs should differ only on the axis

### SP2 Data model and configs (Tue to Wed)

**Done when:** a past result traces back to the exact config, task and code versions that produced it.
**Needs:** D2.

- [ ] **[Rishi designs]** Data model: tasks, configs, experiments, trials, traces
- [ ] Write the shared contract and generate types for both languages
- [ ] Version configs by content hash, including the harness SHA and model pin
- [ ] Add persistence and migrations
- [ ] Add JSON or CSV export

### SP3 Execution engine (Wed)

**Done when:** killing a worker mid-run and resuming gives no lost, duplicated or mislabelled trials.
**Needs:** SP1, SP2, D3.

- [ ] Run tasks × configs × N trials
- [ ] Implement isolation per D3, with a test proving no state leaks between trials
- [ ] Use a fixed `HERMES_HOME` path per trial, because the path appears in the system prompt
- [ ] Handle timeouts, rate limits and retries
- [ ] Separate infra failures from agent failures, including budget stops
- [ ] Make trial claiming idempotent and runs resumable
- [ ] Add a hard budget cap per experiment through LiteLLM `max_budget`
- [ ] Capture the full trace for every trial, including the rendered system prompt

### SP4 Tasks and graders (Wed to Thu)

**Done when:** 20+ tasks run with mixed grader types, and a few are expected to separate configs.
**Needs:** SP1, D7.

- [ ] **[Rishi designs]** Task format and task set. Domain: personal-finance assistant (D13, R6)
- [ ] Build deterministic graders: exact match, unit tests, state checks
- [ ] **[Rishi designs]** Judge rubric format. Judge is blind to harness and model, with a pinned model and a verdict and quoted evidence per criterion
- [ ] Write tasks where skills or memory should help
- [ ] Seed skills and memory explicitly per config, since a fresh Hermes home has no skills
- [ ] Test each grader against known pass and fail outputs

### SP5 Judge validation (Thu to Fri)

**Done when:** judge agreement is reported on held-out labels, per config.
**Needs:** SP4, smoke and pilot trials, D8.

The order matters because the rubric freezes with the platform:

1. Thursday: about 20 labels from smoke trials, used to tune the rubric. These do not count towards reported agreement.
2. Friday, after the pilot: about 40 held-out labels from pilot trials.
3. Friday, after the run: about 20 labels from the real experiment, because pilot outputs on a cheap model may not look like the final model's.

- [ ] Build a blind labelling view that hides the config and the judge's verdict
- [ ] Sample labels stratified across configs and likely pass or fail
- [ ] Rishi labels the three sets above
- [ ] Rishi relabels about 10 at the end to check his own consistency
- [ ] Report Cohen's kappa, false positives, false negatives and agreement per config
- [ ] Run test-retest: the same inputs judged 3 times
- [ ] Add any synthetic examples as a separate, clearly marked set
- [ ] Apply D8 to any task under the threshold

### SP6 Stats and comparison (Thu)

**Done when:** an A/A comparison and a synthetic known difference both produce the right verdict.
**Needs:** SP2, D1, D10.

- [ ] **[Rishi designs]** Unit of analysis, paired test and CI method
- [ ] Compute per-task deltas and the aggregate with intervals
- [ ] Handle multiple comparisons in per-task deltas: with 20 tasks at 5%, about 1 can look significant by chance
- [ ] Add an explicit verdict for when a difference is just noise
- [ ] Show cost, latency and tokens next to quality
- [ ] Test on simulated data with known effects

### SP7 API and UI (Thu)

**Done when:** the four video steps work in the UI: define a config, run it, compare results, drill into a failed trial.
**Needs:** SP3, SP6.

- [ ] Build the Nest API for configs, experiments, results and export
- [ ] Build the config and run views
- [ ] Build the comparison view with per-task deltas
- [ ] Build the trial view: messages, tool calls and results, memory reads and writes, skills, grader reasoning, score

### SP8 Real experiment (Fri)

**Done when:** the hypothesis, setup, results with intervals, 2 or 3 inspected trajectories and a conclusion are written up.
**Needs:** SP1 to SP7, D9. Rishi approves every real run.

- [ ] Freeze the platform and tag the commit
- [ ] Rishi commits the hypothesis and analysis plan to `experiment.md` before the run
- [ ] Run a pilot on a cheap model, then choose N from its variance
- [ ] Run the invariance diff on the two configs
- [ ] Run the experiment
- [ ] Export raw results to `experiments/<id>/`
- [ ] Inspect 2 or 3 trajectories that explain the difference
- [ ] Record actual spend in `cost.md`

### SP9 Docs and video (Sat)

**Done when:** someone new can follow the README from a clean clone, and everything is submitted.
**Needs:** SP8.

- [ ] Finish the README
- [ ] Finish `design.md` and check all six required topics
- [ ] Finish `known-limits.md` and `assumptions.md`
- [ ] Finish `cost.md`: formula, actual spend, how to reduce cost
- [ ] Walk the Brief traceability table line by line
- [ ] Test a clean-clone run
- [ ] Record the video, 10 minutes or less
- [ ] Submit

## Parking lot

Only if the frozen plan has slack.

- [ ] Failure analysis: rule-based categories over traces (wrong tool, hallucinated tool args, gave up early, loop or step exhaustion, grader disagreement)
- [ ] A third harness on an existing framework
