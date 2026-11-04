# agent-evals

A platform that runs an AI agent (a harness plus a model) on a set of tasks, many times each, and
answers one question with evidence: **did the agent get better, worse or stay the same after a
change, and how sure are we?**

Five harnesses plug in through one adapter contract: Hermes Agent, LangGraph, Google ADK, the
OpenAI Agents SDK and a plain tool-calling loop. Every model call goes through a LiteLLM proxy,
where spend, tokens, latency and settings are recorded. The task set is a personal-finance
assistant with calculator tools and simulated clients.

> **Status, 4 Nov 2026.** The platform runs end to end: configs, runs with N trials, isolation,
> retries, traces, deterministic graders, the judge's plumbing and blind labelling. Still being
> finished: the comparison's verdict and intervals (statistics), the judge's validation against
> human labels, and the real experiment. Until then the comparison shows the per-task results
> without a verdict. The write-up lands in `docs/experiment.md`.

## Run it

You need Docker with the compose plugin and about 10 GB of free disk. The first build takes a few
minutes, mostly downloading base images.

```bash
docker compose up -d --build --wait
```

Then open **http://127.0.0.1:8080**. Every port binds to localhost only. If a port is taken, set
`UI_PORT`, `API_PORT` or `LITELLM_PORT`, for example `API_PORT=3001 docker compose up -d --build --wait`.

**Keys.** You need no key to look around or to open the finished example. To run agents on real
models, copy `.env.example` to `.env`, add `ANTHROPIC_API_KEY` (Claude) and/or `GEMINI_API_KEY`,
then run `docker compose up -d` again. Every run shows its trials, models and most it can cost
before it starts, and asks you to confirm a paid run.

Stop it with `docker compose down`; add `-v` to wipe the local database too.

## Three ways in

The home page offers:

1. **See a finished example.** A real A/B experiment, already run, shipped with the repo: the
   comparison per task, every trial's trace (messages, tool calls and results, grader reasoning,
   final score) and the grades. Nothing is spent.
2. **Build your own, step by step.** Pick an agent type (each has an "i" that says what it is and
   what it adds to your prompt), a model, the instructions and a few settings. Preview exactly
   what reaches the model, for free. Then evaluate it against a baseline: run it, compare the
   results, and open a failed trial to see why it failed.
3. **The full platform.** Every experiment, config, task, harness and label, at full detail.

## What runs where

| Service | What it does | Port (localhost) |
| --- | --- | --- |
| `ui` | Vue 3 UI, served by nginx; proxies `/api` to the API | 8080 |
| `api` | NestJS control plane: the database, the trial queue, run controls, grading jobs | 3000 |
| `litellm` | Model proxy: every model call, a key and budget per trial, no response cache | 4000 |
| `worker-*` | One per harness (Hermes, own loop, LangGraph, ADK, Agents SDK): claim a trial, run it in a fresh folder, upload the results | none |
| `grader` | Grades finished trials as its own step, so a grader fix never re-runs a trial | none |
| `fake-llm` | Scripted OpenAI-compatible model server for tests and CI | internal only |
| `postgres` | Platform database, plus LiteLLM's own | internal only |

Workers run on an internal network that reaches only the API, LiteLLM and the fake model server,
with a read-only root filesystem and one writable trial folder (`docs/design.md`, isolation).

## Add a harness

One folder under `workers/` with an adapter, a capabilities file, a Dockerfile and two gate
tests. Nothing in the platform core changes.

```bash
make new-harness NAME=crewai      # scaffold workers/crewai/ from the template
make probe-harness NAME=crewai    # measure what actually reaches the model, against the fake server
make test-harness NAME=crewai     # the contract's gate tests
```

The contract is `docs/adapter-contract.md`; how each existing harness was wrapped is in
`docs/harness-guide.md`.

## Add a model

One entry in `services/litellm/config.yaml` with its provider route, the key's variable name and
its prices (per input, output and cached token). Then check it:

```bash
uv run --no-project --with pyyaml==6.0.3 python scripts/check_litellm_config.py   # no cache, prices set
docker compose restart litellm
```

## Add a task

One folder `tasks/<id>/` with a `task.json`: the messages (or a simulated client), the client's
data file if it has one, and its graders (exact numbers from a tool, tool called or not, text
present or absent, end state, number provenance, a Python unit test, or the LLM judge with a
rubric). See `tasks/README.md` and `docs/proposals/grader-format.md`; the API picks a new task
up without a restart.

## Develop and test

None of these call a real model; tests use the fake model server.

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build      # apps/api, apps/ui
cd graders && uv sync --locked && uv run pytest -q                           # graders and the judge
cd stats && uv sync --locked && uv run pytest -q                             # judge agreement maths
cd workers/adapterlib && uv sync --locked && uv run pytest -q                # contract, runner
python3 scripts/smoke.py                                                     # the running stack, end to end
docker compose --profile smoke run --rm netcheck                             # worker isolation
```

`CLAUDE.md` lists every command, including the per-harness gate tests.

## Docs

- `docs/design.md`: architecture, adapter interfaces, data model, isolation and reproducibility,
  graders and their validation, the statistics and the choice of N.
- `docs/experiment.md`: the real experiment, its hypothesis, setup, results and conclusion.
- `docs/known-limits.md`: where the platform's conclusions should not be trusted.
- `docs/cost.md`: the cost formula and the actual spend.
- `docs/assumptions.md` and `docs/decisions.md`: every assumption, and every design decision with
  its options and reasons.
- `docs/harness-guide.md`: how each harness behaves and how it is wrapped.
