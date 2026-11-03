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
- **Task tools come from one MCP server shared by every harness** (D14), so every harness sees the same tool names, descriptions and schemas. Whether it runs over stdio per trial or as one HTTP service is still open.
- **Self-improvement is explicit** (R3). Anything that lets an agent change its own prompt, skills or memory in the background is a config setting, off unless a config turns it on.

Constraints:

- **The harnesses cannot share one Python environment.** Hermes pins `mcp==2.3.0` and `openai==2.54.0`. `langchain-mcp-adapters` 0.3.2 needs `mcp<2`. `openai-agents` 0.24.0 needs `openai>=3`, while `google-adk[extensions]` 2.13.0 needs `openai<3`. Checked 3 Nov with a resolve-only `uv pip compile`.
- **So each harness has its own environment, and the adapter boundary is a process boundary.** The platform hands a trial to a harness process and reads back the answer, the trace and the usage. The shape of that contract is open.
- **Hermes runs only on Python 3.14.** Its lockfile supports `python_version >= '3.14'` only.
- **Hermes must be configured per process, before it is imported.** A bare `import run_agent` builds a full home folder under `HERMES_HOME`, so the home cannot be switched inside one process. Measured 3 Nov.
- **Hermes changes requests in ways the adapter has to neutralise.** `gpt-5*` model names route to the Responses API. Temperature only reaches the request through `request_overrides`. A `max_iterations` stop makes one extra, uncounted summary call. Details are in `docs/hermes-notes.md`.

Open:

- The adapter contract: what goes in, what comes out, and how capabilities are declared. **[Rishi designs]**
- The config shape: a common block plus per-harness options.
- D12: the trace format across harnesses.
- D15: the Hermes settings that are design calls.

## 3. Data model

Tasks, configs, experiments, trials and traces. **[Rishi designs]** in SP2.

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
- **A worker crash kills its own trial.** The trial's claim then lapses and it is re-run once, never twice.
- **Each trial gets its own LiteLLM virtual key and budget**, since the key is readable inside the container.

Given up: consecutive trials in one container are separated by the sweep, the wipe and the read-only root, not by a fresh container. The SP3 leak test checks this. See the D3 entry in `docs/decisions.md` for the full tradeoff.

## 5. Grader design and validation

Decided:

- **The domain is a personal-finance assistant** (D13, R6).
  - Every task needs a correct tool call and a response that fits the person's circumstances.
  - Rishi's example: debt taken on after a spouse's death should get a different answer from a loan for a phone bought because friends had one.

Open:

- D7: which tasks use the judge.
- D8: the judge threshold, and what happens below it.

Results go in `docs/judge-validation.md`.

## 6. Statistical method and choice of N

Constraints:

- **With a two-sided exact paired test (sign-flip) across k tasks, the smallest possible p-value is 2/2^k**, however many trials each task gets. At 5 tasks that is 0.0625, so no per-tier result can reach p < 0.05 with 5 tasks.

Open:

- D9: the experiment axis and N.
- D10: the unit of analysis.
