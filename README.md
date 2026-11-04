# agent-evals

A platform that runs an AI agent (a harness plus a model) on a set of tasks, many times each, built
to answer one question with evidence: **did the agent get better, worse or stay the same after a
change, and how sure are we?** This version reports the evidence (pass counts, cost and time per
version and per task, every trial's trace and grades); the verdict with its interval is not built
yet (see Status).

Five harnesses plug in through one adapter contract: Hermes Agent, LangGraph, Google ADK, the
OpenAI Agents SDK and a plain tool-calling loop. Every model call goes through a LiteLLM proxy,
where spend, tokens, latency and settings are recorded. The task set is a personal-finance
assistant with calculator tools and simulated clients. Today it holds 15 draft tasks (their
summaries still start "DRAFT") and 2 engine tests that check the platform, not an agent; the
task set is being finished.

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
`UI_PORT`, `API_PORT` or `LITELLM_PORT`, for example `API_PORT=3001 docker compose up -d --build --wait`,
and pass the same variables to every later `docker compose` command and to the checks under
Develop and test.

**Without a key** you can build, save and preview an agent (see exactly what reaches the model),
and open the finished example, which is read-only: nothing in it runs again. You can also run
agents on **fake models** (`fake/...`), which the full platform's Config screen offers: a scripted
local server answers at made-up prices, so a run needs no key and spends nothing. A fake model
makes the same scripted calls whatever the task (one always works out the same EMI), so most of
its trials fail: such a run tests the platform (queueing, retries, traces, grading), not an agent.

**With a key** you can run agents on real models. Copy `.env.example` to `.env`, add
`ANTHROPIC_API_KEY` (Claude) and/or `GEMINI_API_KEY`, then run `docker compose up -d` again. A
real run costs money: every run shows its trials, models and the most it can cost before it
starts, and asks you to confirm.

Stop it with `docker compose down`. `docker compose down -v` also wipes the local database
(configs, experiments, grades), but not the files the stack writes into the repo folder: trial
files stay in `./runs/` (delete what is inside it to remove them; one fake run of 150 trials
left about 22 MB there in testing), your labels in `./labels/`, and prompt versions you saved in
`configs/prompts/`.

## Three ways in

The home page offers:

1. **See a finished example.** A real run on a real model (Claude Haiku 5.5), shipped with the
   repo: own loop against Hermes, each task's pass counts, every trial's trace (messages, tool
   calls and results, grader reasoning) and its grades. Nothing runs and nothing is spent. Today it
   is a small draft: 15 draft tasks, one trial per task and arm, and 20 of its 30 trials undecided
   because the LLM judge was not approved for it. The full experiment replaces it.
2. **Build your own, step by step.** Pick an agent type (each has an "i" that says what it is and
   what it adds to your prompt), a model, the instructions and a few settings. Preview exactly
   what reaches the model, for free. Then evaluate it against a baseline: run it, compare the
   results, and open a failed trial to see why it failed. Running it on a real model needs a
   provider key (see Run it); without one you can build, save and preview it, and run on a fake
   model from the full Config screen to see the platform work, not the agent.
3. **The full platform.** Every experiment, config, task, harness and label, at full detail.

The first door opens `http://127.0.0.1:8080/#/example`. The first time, it copies the example shipped
in `examples/` into your local database: rows are only inserted, the example is read-only, and
nothing runs or is spent. `GET /api/examples` lists the shipped examples. Its title says what it is
("Draft stand-in: ..."), and `docs/known-limits.md` says why its counts prove nothing.

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

**The API's database tests.** Without `TEST_DATABASE_URL`, `pnpm test` skips the API's
database suites (nine test files) and prints that they were skipped, not passed. To run them,
start a throwaway Postgres (never the compose one), then stop it:

```bash
docker run --rm -d --name evals-api-test -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=x postgres:17
TEST_DATABASE_URL=postgresql://postgres:x@127.0.0.1:55432/postgres pnpm test
docker stop evals-api-test
```

**A stack on other ports or under another project name.** The checks need the same settings as
the stack: `API_PORT=3001 python3 scripts/smoke.py` (and `UI_PORT`, `LITELLM_PORT` if you changed
them), and `API_PORT=3001 docker compose --profile smoke run --rm netcheck`, because compose
otherwise recreates the API on its default port. If you started it with `-p <name>` or
`COMPOSE_PROJECT_NAME=<name>`, use the same for both: smoke.py reads `COMPOSE_PROJECT_NAME`.

`CLAUDE.md` lists every command, including the per-harness gate tests.

## Docs

- `docs/design.md`: architecture, adapter interfaces, data model, isolation and reproducibility,
  graders and their validation, the statistics and the choice of N.
- `docs/experiment.md`: the real experiment's write-up, its hypothesis, setup, results and
  conclusion, written after the run; until then a template.
- `docs/known-limits.md`: where the platform's conclusions should not be trusted.
- `docs/cost.md`: the cost formula and the actual spend.
- `docs/assumptions.md` and `docs/decisions.md`: every assumption, and every design decision with
  its options and reasons.
- `docs/harness-guide.md`: how each harness behaves and how it is wrapped.
