# Design

Rishi's design record. The brief requires all six topics below.

Each entry is one of three kinds:

- **Decided:** Rishi's call, with the decision or ruling it comes from.
- **Constraint:** a verified fact the design has to respect, with the evidence. Not a choice.
- **Open:** not decided yet. Options and tradeoffs live in `docs/decisions.md`.

Claude fills in only Decided and Constraint entries.

## 1. Architecture

Decided:

- The control plane is a NestJS API and a Vue 3 UI, in TypeScript (brief).
- Harness workers may be Python (spec).
- Every model call from every harness goes through LiteLLM (Rishi, 3 Nov). This one choke point is where settings, spend and usage are checked, whichever harness made the call.
- The model providers are Claude and Gemini (D4). The open-weight model is still open (D5).
- LiteLLM's response cache is never on for trials. It would replay answers, so repeated trials would stop being independent samples (`CLAUDE.md`).

- Graders and stats are Python (D1).
- Workers talk only to the NestJS API, over HTTP: they claim a trial, then report its result. They never hold database credentials, so the API is the one owner of the schema and the one place that logs and checks what workers do (D2).
- Each harness runs as its own long-lived compose service, with a fresh process per trial (D3, section 4).

## 2. Harness and model adapter interfaces

Decided:

- **The harnesses are Hermes, the own plain loop, LangGraph, Google ADK and the OpenAI Agents SDK** (R1, R5, D11).
- **Build order and gates** (R7):
  - Hermes and the own loop come first, until one task runs end to end through both.
  - The other three are then built in parallel.
  - Each one counts only after it passes the settings test and the tool test.
  - The deadline for each one is Thursday 5 Nov, 12:00. A harness that misses it is cut on its own. Cut order: the two SDKs first, LangGraph last, never the own loop.
- **Adding a harness is an adapter, not a core change** (R2). The test cases are adding a GitHub coding agent or the Claude Agent SDK tomorrow.
- **A new model is one config line**, because all model access goes through LiteLLM (SP1 done-when).
- **Task tools come from one MCP server shared by every harness** (D14), so every harness sees the same tool names, descriptions and schemas. It is started per trial over stdio inside the harness container, so its state lives in the trial folder.
- **Self-improvement is explicit** (R3). Anything that lets an agent change its own prompt, skills or memory in the background is a config setting, off unless a config turns it on.

Constraints:

- **The harnesses cannot share one Python environment.** Hermes pins `mcp==2.3.0` and `openai==2.54.0`. `langchain-mcp-adapters` 0.3.2 needs `mcp<2`. `openai-agents` 0.24.0 needs `openai>=3`, while `google-adk[extensions]` 2.13.0 needs `openai<3`. Checked 3 Nov with a resolve-only `uv pip compile`.
- **So each harness has its own environment, and the adapter boundary is a process boundary.** The platform hands a trial to a harness process and reads back the answer, the trace and the usage. The shape of that contract is open.
- **Hermes runs only on Python 3.14.** Its lockfile supports `python_version >= '3.14'` only.
- **Hermes must be configured per process, before it is imported.** A bare `import run_agent` builds a full home folder under `HERMES_HOME`, so the home cannot be switched inside one process. Measured 3 Nov.
- **Hermes changes requests in ways the adapter has to neutralise.** `gpt-5*` model names route to the Responses API. Temperature only reaches the request through `request_overrides`. A `max_iterations` stop makes one extra, uncounted summary call. Details are in `docs/hermes-notes.md`.

Decided, the adapter rules (R10, 3 Nov):

- **One process, one file in, two files out.** A fresh adapter process per trial reads `spec.json` and writes `result.json` and `trace.jsonl`. Any language can implement it.
- **Adapters translate, graders judge, the runner labels.** The end-state list is provisional; raw harness stop signals are stored so trials can be relabelled later without re-running.
- **Models only through LiteLLM**, with a per-trial key; no provider keys and no internet in workers.
- **Declared and proven settings.** Each adapter declares the settings it supports; anything else is rejected before the run. A setting counts only once the settings test sees it in the captured request; tools must pass the tool test.
- **Native limits, sized runs, safety nets.** Limits go into each harness natively (the wrapper adds what is missing, such as a whole-trial timeout). Runs are sized upfront from the cost, time and N estimate. The runner's process-group kill and the proxy's spend cap are safety nets only.
- **Only the task's tools,** plus anything the config enables. **Nothing learns** unless the config says so (R3).
- **The proxy is the source of truth** for tokens, cost, latency and call counts.
- **Retries:** LiteLLM retries failed model calls with backoff (429, 5xx and timeouts, up to 3 times; never other 4xx), counted per trial as `proxy_usage.attempts` against the harness's `model_calls`; a trial that still fails is re-run by the runner, capped (D16). **One step is one model call** (D17). **Tool errors go back to the model** wherever the framework allows (D18). **Parallel tool calls** are a setting, off by default (D19). **Harness-added prompt text is kept and recorded** (D20).
- **Traces:** OpenTelemetry spans in OTLP JSON, one trace per trial, with `gen_ai.*` attributes and our own `evals.*` events for memory, skills and errors; model-call spans from LiteLLM's records, tool and turn spans from each adapter (D12, amended 3 Nov).
- **Thin adapters, no hidden retries.** One folder per harness; every harness's built-in retries set to zero so retrying happens in one place.

Decided, the field-by-field contract (R12, 3 Nov; to be iterated on 4 Nov):

- **`docs/adapter-contract.md` v2** defines the trial folder, `spec.json`, `capabilities.json`, `result.json`, the span names, exit codes, gate tests, effect checks, the simulated client and what is stored. The JSON Schemas in `contract/v2/` are its machine-readable form.
- **The config shape** is a common `settings` block (temperature, max output tokens, max steps, timeout, parallel tool calls, memory, skills, compression) plus `harness_options` validated against each adapter's own schema (D23).
- **Platform checks after every trial** (4 Nov, from Rishi's review): the runner writes `checks.json` next to the result, the same for every harness: number provenance (each money amount the agent wrote, and whether a tool result, the client file or a user message holds it at the precision shown) and the task's `required_tools` called or missing. Graders and the judge read it; it never changes a trial's label (contract section 12).

Open:

- D15: the remaining Hermes settings that are design calls (compression, `skill_manage` writes).

## 3. Data model

Tasks, configs, experiments, trials and traces. **[Rishi designs]** in SP2.

Approved on 4 Nov (R14): `docs/proposals/data-model.md`. Content-addressed prompts, toolsets (since 4 Nov the toolset hash covers the published tool manifest and the server version, not just the tool names), tasks and configs; experiments freeze task hashes × config hashes × N; one trial row per (experiment, task, config, repeat, attempt) with a claim, heartbeat and idempotent report; spans and grades in their own tables; labels stay files; raw trial files stay under `runs/`.

Added with D22's reply cache (migration `002_sim_replies.sql`): a `sim_replies` table keyed by the simulator cache key, with the task sha256, simulator model, temperature, token cap and prompt sha256 it is scoped by and the trial that first produced each reply. A claim hands out every reply in its trial's scope; a report adds the trial's new ones, first reply per key kept. An empty reply is never cached (D26, 4 Nov): the adapter marks it with `error` in `sim_replies.jsonl`, the report skips it, and a claim leaves out any empty reply stored before that rule, so a trial re-queued after `infra:sim_error` asks the simulator again.

Added with D26 (migration `003_experiment_pause.sql`): an experiment status `paused`, with `paused_at`, `paused_reason` and `resumed_at`. A report labelled `infra:config_error` pauses a running experiment, so no more trials are claimed; `POST /experiments/:id/start` resumes it. `infra:config_error` and `infra:budget_net` attempts are never re-queued; the other infra labels are re-queued once (D16). Since D37 (migration 005), a config error pauses only its arm; the experiment status `paused` is for pauses by hand and D32's futility check and guards.

Added with D27 (migration `004_sim_temperature_optional.sql`): `sim_replies.temperature` may be null, for a simulator that sends no temperature (Haiku 5.5); claims select replies with `IS NOT DISTINCT FROM`, so a null temperature is its own cache scope. The spec's `client_sim` gains an optional `client_summary`, built by the API from the task's client file at claim time and not stored separately.

Added with D32, D34, D35, D37 and the guide review's platform item 8 (migration `005_run_controls.sql`):
- `configs.parent_hash` and `experiments.parent_experiment_id` (D34). Lineage is not behaviour, so it is not in the config hash. `experiments.reuse_baseline` asks to reuse the parent's arm-A trials; `baseline_decision` says whether that applied and why.
- `experiment_arms`, one row per arm (A, and B unless it is a pilot; D35): what can change while the experiment runs, kept off the frozen `experiments` row. An arm is paused by an `infra:config_error` report (D37, amending D26) or by hand; claims skip a paused arm. `reused_trial_ids` lists the parent's trials arm A reuses. `futility_checked_at` makes the futility check run once per arm.
- `trials.order_index` and `experiments.order_seed` (D32): a seeded shuffle of the (task, repeat) blocks, with the arm order shuffled inside each block, so the arms alternate and any early batch is a random sample. Claims go in that order.
- `experiments.futility` (the resolved rule) and `spend_guard_at` (the spend guard pauses once).
- `experiment_events`: pauses, resumes, stops and the baseline decision, which the trial rows cannot show. Claim, failure and re-queue events are still derived from the trial rows.
- `workers`: each worker's harness and when it was last seen (a claim, empty or not, or a heartbeat), so the estimate's time divides by the live workers per harness.

Added with D33 and D38 (migration `006_probes_and_system_spend.sql`; 005 is the run-controls work):

- **Probe trials.** `trials.experiment_id` may be null, and a `probe` flag marks a trial run outside any experiment to render a config's system prompt on the fake model (a check constraint ties the two). At most one live probe per config (a partial unique index). Probes are claimed through the normal worker protocol, ahead of experiment trials, and left out of estimates, the label queue and trial spend. They run a built-in task row, `prompt-probe`, that is not in the task catalogue.
- **`rendered_prompts`**, one row per config hash: the normalised system text, its sha256, the tool names, our prompt's offsets and the harness's own text, from the config's first usable probe.
- **`system_spend`**, one row per model call the platform makes itself: kind, model, status (`pending` with a worst-case reservation before the call, then `done` or `failed`), cost and tokens from LiteLLM's spend log, and a `ref` to what it was for. Allowances are computed from it.
- **`conflict_checks`**: findings cached by (input sha256, checker prompt sha256, model), where the input hashes the rendered prompt, our prompt and the settings, with the spend row that paid for them.

Added with SP4's grading step (migration `007_grading.sql`; R14 "grading is its own step"): a `grading_jobs` table, one row per grading of one trial, holding the frozen grader specs with their hashes, any grader files, a claim lease and the task's outcome on that trial (pass, fail or incomplete); and `grades` gains the grader type, `required`, the reason, the spec hash, the framework version and the job. A grade is unique by (trial, grader id, grader version, run index), so a re-grade adds rows and never overwrites one. Views `current_grading` and `current_grades` give each trial's latest finished grading.

Added with D39's seeded runs (migration `008_config_seed.sql`): `configs.seed`, the memory entries and skills every trial of the config starts with, in contract v2's seed shape; older configs get empty lists. A non-empty seed is part of the config hash, and an empty one is left out of it, so configs made before seeds keep their hashes. The claim copies it into `spec.seed`. `POST /configs` refuses a seed for a feature the harness cannot take or the config turns off (`docs/api-contract.md`).

Interim, not a design decision: until SP2, the API reads finished trial folders from `RUNS_DIR` through a `TrialStore` interface (`apps/api/src/trials/trial-store.ts`), so the trace view and spend chart work now. SP2's database store replaces the file store behind the same interface.

Planned in the spec, not yet designed:

- Configs are versioned by content hash, including the harness SHA and the model pin.
- A past result must trace back to the exact config, task and code versions that produced it.

## 4. How runs are isolated and reproduced

Constraints:

- **Hermes is pinned at `6112c2adb9e11f69734a29be9d2696f345ffa06a`** and installed from its own `uv.lock`. Hermes source is never modified.
- **Each trial needs its own Hermes home, set before import.** See section 2.
- **The Hermes home path appears in the system prompt**, so its path must be the same in every trial. Otherwise two configs differ by more than their axis.
- **Hermes can edit its own `config.yaml`, `SOUL.md` and `AGENTS.md` with no switch to stop it.** Those files need a hash check before and after every trial (R3).

Decided (D3; Rishi delegated the call to "simpler and more robust"):

- **One long-lived container per harness, a fresh process per trial, one trial at a time per container.** Each harness is a compose service with its own image. Parallelism comes from running more replicas of a service.
- **Every writable path lives in one trial folder at a fixed path.** That covers the Hermes home, `HOME`, `TMPDIR` and tool state such as the finance ledger. Because only one trial runs in a container at a time, the paths are the same in every trial, so prompts that carry them stay identical.
- **Between trials, the runner kills every leftover process, wipes the folder and checks it is empty.** Hermes's scratch-prune child deliberately outlives its parent, which is why the sweep is needed.
- **The root filesystem is read-only**, so nothing can persist outside the trial folder.
- **Workers mount nothing from the host.** After a trial the worker uploads each file of `out/` to the API (`PUT /api/worker/trials/:id/files/*path` with its sha256), and the API alone writes `runs/<experiment>/<trial>/attempt-<n>/`. A trial therefore cannot read or change an earlier trial's stored files (D2, D3; `docs/api-contract.md`, worker protocol).
- **A worker crash kills its own trial.** The trial's claim then lapses and it is re-run once, never twice.
- **Each trial gets its own LiteLLM virtual key and budget**, since the key is readable inside the container.

Given up: consecutive trials in one container are separated by the sweep, the wipe and the read-only root, not by a fresh container. The SP3 leak test checks this. See the D3 entry in `docs/decisions.md` for the full tradeoff.

## 5. Grader design and validation

Decided:

- **The domain is a personal-finance assistant** (D13, R6).
  - Every task needs a correct tool call and a response that fits the person's circumstances.
  - Rishi's example: debt taken on after a spouse's death should get a different answer from a loan for a phone bought because friends had one.

Built on 4 Nov, where graders live (follows D1, D2, R10.2 and R14; the SPEC left the project's place to SP4):

- **Graders are a Python project at the repo root, `graders/` (package `evals_graders`)**, outside every harness worker: adapters only report how a trial ended (R10.2), graders judge.
- **A grader reads only the trial's stored files:** `result.json` (final answer, transcript, end state), the `execute_tool` spans in `trace.jsonl` (tool names, arguments, results, with Hermes's `mcp__finance__` prefix and wrapped results normalised) and `checks.json`. `evals-grade <out_dir> --task task.json` grades one folder from the command line.
- **Grading is its own step after the trial (R14).** A `grader` compose service (`evals-grader`, same read-only runtime as a harness worker, trials network only, no mounts) claims grading jobs from the API, downloads the trial's files over HTTP, grades and reports (D2). A grader fix is `POST /experiments/:id/regrade`: new grade versions next to the old ones, no trial re-run (`docs/api-contract.md`, Grading).
- **Every grade quotes its evidence verbatim** and carries a version: the hash of its spec (and grader file) plus the framework version, computed identically in Python and in the API. A judge's rubric file (`configs/rubrics/<id>.<version>.md`) is part of its version the same way, so editing a rubric gives new grade versions.

Built as a draft, open for Rishi (SP4 **[Rishi designs]**): the grader spec format, its ten types (number, tool_called, tool_not_called, regex_present, regex_absent, end_state, provenance, required_tools, unit_test, and the reserved judge; provenance and required_tools read the runner's `checks.json`) and the outcome rule are in `docs/proposals/grader-format.md`, with the choices listed there.

Open:

- D7: which tasks use the judge.
- D8: the judge threshold, and what happens below it.

Results go in `docs/judge-validation.md`.

## 6. Statistical method and choice of N

Constraints:

- **With a two-sided exact paired test (sign-flip) across k tasks, the smallest possible p-value is 2/2^k**, however many trials each task gets. At 5 tasks that is 0.0625, so no per-tier result can reach p < 0.05 with 5 tasks.

Open:

- N, split sizes, harness and model for the headline experiment, which is prompt v1 versus v2 on discovery and held-out tasks (D9, decided 3 Nov).
- D10: the unit of analysis.
