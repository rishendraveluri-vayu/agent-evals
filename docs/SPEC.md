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

Confirmed in SP0, after D1 to D3. Folders marked *later* do not exist yet.

```text
CLAUDE.md
README.md
docker-compose.yml       One command: docker compose up
.env.example
package.json             pnpm workspace root (apps/*)
ruff.toml                Shared Python lint settings
apps/api/                NestJS control plane
apps/ui/                 Vue 3 UI
services/fake-llm/       Scripted fake model server for tests and CI (R9)
services/litellm/        LiteLLM proxy config
services/postgres/       Database init
workers/base/            Worker base image and the D3 isolation check
workers/<harness>/       One Python project and image per harness (later, SP1)
scripts/                 Smoke test, config check, probes
tasks/                   Task set, one folder per task (later, SP4)
graders/                 Grader framework and the grader worker, Python (SP4)
configs/                 Versioned configs (later, SP2)
labels/                  Rishi's hand labels only (later, SP5)
experiments/             Exported results for the real experiment (later, SP8)
docs/                    See the docs register
```

Graders and stats are Python (D1). The grader framework lives in `graders/` at the repo root (SP4).

## Docs register

These are the documents we need so nothing gets lost. **Required** means the brief asks for it directly. Start every doc on day one rather than on Saturday.

| Doc | Holds | Why it matters | Update when | Status |
| --- | --- | --- | --- | --- |
| `README.md` | Setup, add a task, add a harness, add a model | **Required** | SP0 onward, finished in SP9 | Started |
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
| `.env.example` | Key names, never values | Part of one-command setup | Each new key | Done for SP0 |
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
| Failure analysis (stretch) | SP6, SP7 (D64) | A cause per failed trial, behaviour per arm, causes on the regression list |
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

Re-planned on 4 Nov (R13): Wednesday finishes every harness on real models and a basic UI (Claude), while Rishi writes the evals from `docs/harness-guide.md`. Thursday and Friday are for evals.

## Sub-projects

Each one has a done-when test. Scope stops growing once that test passes.

### SP0 Foundations (Tue)

**Done when:** `docker compose up` starts every service and CI is green with no LLM spend.
**Needs:** D1, D2 and D3 for the service layout.

- [x] Rishi creates the GitHub repo, private until submission
- [x] Add `CLAUDE.md` and the `docs/` files to the repo
- [x] Set up the monorepo with pnpm and uv
- [x] Write the compose skeleton and `.env.example`: one service per harness with a read-only root (D3), workers reaching only the API and LiteLLM
- [x] Add LiteLLM: official image `ghcr.io/berriai/litellm`, v1.83.0 or later, pinned by digest
- [x] Build a fake OpenAI-compatible server for tests and CI: scripted replies, streaming, and forced faults (429, timeout, 500, broken stream) (R9)
- [x] Add CI: lint, tests, compose smoke test
- [ ] Rishi checks API rate-limit tiers on each provider
- [x] Fill in the Commands section of `CLAUDE.md`

### SP1 Harness and model adapters (Tue to Wed)

**Done when:** one task runs through every harness that passed its gate (Hermes and the own loop at minimum) behind the same interface, and a new model is a config line.
**Needs:** SP0, D4, D5, D6. Start from `docs/hermes-notes.md`.

- [x] **[Rishi designs]** Harness and model adapter interfaces: contract v2, approved as a start (R12), in `docs/adapter-contract.md`
- [x] Build the Hermes adapter on the pinned SHA (`workers/hermes`; 9 gate tests against the fake, 4 through LiteLLM)
- [ ] Audit Hermes and record results in `hermes-notes.md`: background skill and memory writes (R3), memory in the prompt vs the trace, temperature, model-name routing, prompt caching through the proxy, token usage in the result
- [x] Settle the cross-harness trace format (D12, R4)
- [x] Before fixing the adapter contract, read each SDK's run, tool and settings APIs on paper (about 1 h), so the contract is not shaped only by Hermes and the own loop
- [x] Build the shared adapter library (spec, timeout wrapper, MCP command, conversation loop, end-state mapping, atomic result, span writer), the `new-harness` scaffold and the `probe-harness` command that writes capabilities from evidence (R11). `workers/adapterlib`, 44 tests on Python 3.11 and 3.14; `make new-harness NAME=`, `make probe-harness NAME=`
- [x] Build the own plain loop next to Hermes, until one task runs end to end through both (through LiteLLM, fake models only)
- [x] Minimal trace view (one trial's span timeline) and a spend chart per trial and config, in the first end-to-end run (R11). Reads trial folders until SP2's database
- [ ] Effect checks per harness and model on Haiku 5.5 and a Gemini Flash, each run signed off with an estimate (D24)
- [x] Add the simulated-client helper (D22: reply cache, own key, turn cap) and the conversation loop in Hermes and the own loop, with a simulated gate test (fake simulator; prompt `client-sim.v1` is a draft for Rishi)
- [ ] Then build LangGraph, Google ADK and the OpenAI Agents SDK in parallel (R7), one agent and one folder each, with tool parity through D14. Each passes the settings test and the tool test by Thursday 12:00 or is cut with the reason recorded. Cut order: the two SDKs first, LangGraph last, never the own loop. Rishi reviews each before merge.. Built 4 Nov on branch `sp1-harnesses`: all three pass the 8 gates, the drift test and their proxy tests against the fake; waiting for Rishi's review before merge
- [x] Settle how task tools reach every harness (D14)
- [ ] Register models in LiteLLM and smoke-test tool calling on each, with real dev runs on Haiku 5.5 and Gemini Flash, each scoped and signed off first (R8, R9)
- [x] Build the invariance diff: the first request of two configs should differ only on the axis (`evals-invariance A B --axis ...`; checked on Hermes and the own loop through LiteLLM: prompt v1 vs v2 differs only in the prompt lines)

### SP2 Data model and configs (Tue to Wed)

**Done when:** a past result traces back to the exact config, task and code versions that produced it.
**Needs:** D2.

- [x] **[Rishi designs]** Data model: tasks, configs, experiments, trials, traces (R14, `docs/proposals/data-model.md`)
- [ ] Write the shared contract and generate types for both languages
- [x] Version configs by content hash, including the harness SHA and model pin (`POST /api/configs`)
- [x] Add persistence and migrations (Postgres, `apps/api/migrations/`)
- [x] Add JSON or CSV export (`GET /api/experiments/:id/export`)

### SP3 Execution engine (Wed)

**Done when:** killing a worker mid-run and resuming gives no lost, duplicated or mislabelled trials.
**Needs:** SP1, SP2, D3.

- [x] Run tasks × configs × N trials (`scripts/sp3_kill_test.py`: 20 trials over 2 harnesses)
- [x] Implement isolation per D3: one trial folder at a fixed path, leftover-process sweep, wipe and empty check between trials, with a test proving no state leaks from one trial to the next in the same container (image tests in all five worker images; files reach the API over HTTP, so workers mount no shared folder)
- [x] Use a fixed `HERMES_HOME` path per trial, because the path appears in the system prompt (`/trial` in every container)
- [x] Set LiteLLM per-call retries with backoff and a capped trial re-queue (D16), tested against the fake's forced 429s; update the config check (4 Nov: also 503s, 400s and a hung call, on a throwaway LiteLLM of the pinned image; attempts counted per trial in `proxy_usage`)
- [ ] Handle timeouts, rate limits and retries: tested with the fake's forced faults, then seen on a signed-off real dev run (R9)
- [ ] Separate infra failures from agent failures, including budget stops
- [x] Make trial claiming idempotent and runs resumable (SKIP LOCKED claims, 60 s lease; passed the kill test on 4 Nov)
- [ ] Show trials, estimated cost, time and whether N is enough before every run, and start only runs that can finish (R10.6)
- [x] Add a LiteLLM `max_budget` safety net per experiment and per trial, set well above the estimate; a trip is an infra event (R10.6) (the API mints each trial key with a budget and refuses experiments below the estimate's high end)
- [x] Capture the full trace for every trial, including the rendered system prompt (stored with the API; Hermes's rendered prompt is an artifact)

### SP4 Tasks and graders (Wed to Thu)

**Done when:** 20+ tasks run with mixed grader types, and a few are expected to separate configs.
**Needs:** SP1, D7.

- [x] **[Rishi designs]** Task format and task set. Domain: personal-finance assistant (D13, R6) (D53: 21 tasks, severities on every required check)
- [x] Split tasks into discovery and held-out sets for the prompt experiment (D9); keep simulated-client tasks to about 5 to 8 (D22) (D53 split A: 11 discovery, 10 held-out; 7 conversations)
- [ ] Rishi reviews about 10 simulated-client transcripts and the simulator prompt is versioned before the experiment (D22, R11)
- [x] Build deterministic graders: exact match, unit tests, state checks (`graders/`, ten types incl. a reserved judge, and `required_tools` and `provenance` on the runner's `checks.json`; grading as its own step through the API and a `grader` service, R14; the spec format is a draft for Rishi, `docs/proposals/grader-format.md`)
- [ ] **[Rishi designs]** Judge rubric format. Judge is blind to harness and model, with a pinned model and a verdict and quoted evidence per criterion
- [ ] Write tasks where skills or memory should help
- [x] Seed skills and memory explicitly per config, since a fresh Hermes home has no skills (API: `POST /configs` takes `seed`, in the hash, copied into `spec.seed` at claim, D39; the Config screen's seed fields and the seeded content for D39's run are separate)
- [x] Test each grader against known pass and fail outputs (96 tests in `graders/tests`, incl. the real 4 Nov transcripts of all five harnesses; API grading e2e with the real grader worker)

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

- [x] **[Rishi designs]** Unit of analysis, paired test and CI method (D10, revised 5 Nov to a task bootstrap; D41 to D44, D50; `docs/design.md` section 6)
- [x] Compute per-task deltas and the aggregate with intervals (`apps/api/src/stats/`, in `GET /experiments/:id/compare` once every arm is complete and graded; Newcombe per task, a task bootstrap for the aggregate, the sign-flip test; tested against published values)
- [x] Handle multiple comparisons in per-task deltas: with 20 tasks at 5%, about 1 can look significant by chance (Benjamini-Hochberg at q = 0.05, D41)
- [x] Add an explicit verdict for when a difference is just noise (better, worse, practically equivalent within +/- 10 points, or no detectable difference with what is not ruled out; none below 6 tasks; held back by the critical-failure guardrail; A/A calibration runs, D44)
- [x] Show cost, latency and tokens next to quality (the same task bootstrap, no verdict; time leaves out trials with a retried model call)
- [x] Test on simulated data with known effects (seeded: A/A false calls, coverage and power at K = 10 and 20, the -15 and equivalence cases, the 6-task floor, the two-level comparison; `docs/known-limits.md`, Statistics)

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

- [ ] Pre-run power estimate on the Run screen (stats proposal section 6): from the pilot's spread between and within tasks, the smallest difference the planned N and K detect 8 times in 10. Today the simulated table in `docs/known-limits.md` stands in for it.

- [x] Failure analysis: rule-based categories over traces (wrong tool, hallucinated tool args, gave up early, loop or step exhaustion, grader disagreement). Built 5 Nov as D64: a cause per failed trial (A45), each arm's behaviour on the comparison, and the causes that grew on the regression list.
- [ ] A third harness on an existing framework
- [ ] Accounts and a hosted demo (D40: not asked for by the brief): logins, per-account provider keys, a shared demo login on our keys behind a hard LiteLLM budget, hosting with HTTPS. Ask Rishi Friday evening whether it is needed.
- [ ] Tools beyond MCP, to show the tools axis is more than "which MCP server" (Rishi, 3 Nov): e.g. a harness built-in such as Hermes code execution as a config setting, one tool delivered natively per adapter, or a plain HTTP API tool. Revisit after the first end-to-end run.
- [ ] Conflict check: mark each finding whose `harness_says` or `we_say` quote is not in the text verbatim, so an invented quote is visible (no extra call).
- [ ] Probe on `fake/<real model name>` instead of `fake/finance-emi`, so Hermes's model-name-gated guidance (gpt, gemini, ...) appears in the rendered prompt. The fake server falls back to its default script for an unknown name. Needs Rishi's call (known-limits, "Pre-run checks").
- [ ] Guided builder: offer to save the own-loop twin of a new agent (same model, prompt and settings) as its vanilla baseline, so "Evaluate it" always has a one-change comparison. Today it has one only when such an agent was saved before.
- [x] Provenance through the arithmetic tools (D54): also check that each arithmetic tool call's input numbers are themselves supported (a tool result, the client file or a user message before the call), so a figure the agent made up cannot become "supported" by passing through `round` or `add([x, 0])` (`docs/known-limits.md`, Platform checks). Decided as D56 and built 5 Nov: runner 0.2.0 (`checks.json` `arithmetic`, `rejected`), framework 0.4.0, A40.
- [ ] Hermes adapter: fail at start-up when a tool in `allowed_tools` is not on the server, as the other four adapters do, instead of Hermes dropping it silently (`docs/hermes-notes.md`).
- [ ] UI sample data: `make-fixtures.mjs` still declares memory, skills and compression supported on LangGraph, ADK and the Agents SDK, where their `capabilities.json` says unsupported, so fixture mode shows them as available there.
- [x] Provenance (D58): require at least one input with a real source per arithmetic call, so a figure made only of unit facts (`multiply([100, 12])`) is not "supported" from nothing (`docs/known-limits.md`, Platform checks). Decided as part of D61: every call needs a sourced amount (A44).
- [x] `reference_rates` (D58): Rishi approves or edits the proposed values in `services/finance-mcp/src/finance_mcp/reference_rates.json` before any run uses `finance/v3` (approved 5 Nov, `debt_fund` removed; server 0.4.1), and re-reads them just before the experiment (October's CPI is due in mid-November; the NSE factsheet URLs are replaced monthly). A changed value is a new server version and toolset version.

## Freeze (D65, 5 Nov)

After D61, D62 and the D63 task fixes land, the agent, prompt v1, tasks, graders and toolset are frozen. New findings about the agent or tasks go to `docs/known-limits.md` or the write-up, not into fixes. Remaining work is the evaluation loop and the comparison.
