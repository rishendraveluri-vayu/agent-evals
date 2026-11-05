# agent-evals

A platform that runs an AI agent (a harness plus a model) on a set of tasks, many times each, built
to answer one question with evidence: **did the agent get better, worse or stay the same after a
change, and how sure are we?** Each comparison gives a verdict (better, worse, practically
equivalent, or no detectable difference) with a 95% interval over the tasks and a paired test, per
task results flagged after a multiple-comparison correction, a guardrail on critical checks, and
cost, tokens and time beside it, down to every trial's trace and grades.

Five harnesses plug in through one adapter contract: Hermes Agent, LangGraph, Google ADK, the
OpenAI Agents SDK and a plain tool-calling loop. Every model call goes through a LiteLLM proxy,
where spend, tokens, latency and settings are recorded. The task set is a personal-finance
assistant with calculator tools and simulated clients. It holds 21 tasks, 10 of them held out to
score the experiment and 11 for discovery (where the first prompt's failures were found and the
judge was tuned), plus 2 engine tests that check the platform, not an
agent.

> **Status, 5 Nov 2026.** The platform runs end to end with its statistics: configs, runs with N
> trials, isolation, retries, traces, deterministic graders, an LLM judge, blind labelling,
> failure causes, and the comparison (verdict, 95% intervals, a paired test, per-task flags,
> critical-failure guardrail, cost and time, A/A calibration; `docs/design.md`, section 6).
> **The real experiment has run:** on Hermes with Claude Haiku 5.5, prompt v2 passed 73 of 100
> trials on the 10 held-out tasks against v1's 64, +9 points (95% interval +3 to +16, p = 0.0625),
> which the rule fixed before the run calls "no detectable difference": 5 of the 10 tasks scored
> the same in both arms (always passed or always failed), and the 5 left are too few for the test
> to reach p < 0.05. v1 run against itself as a check gave −4 points (−12 to +3), no difference,
> as it should. Nearly all of the +9 is one check, that every rupee figure comes from a tool
> (the rule v2 adds); set aside, the arms pass 95 and 97 of 100 (`docs/known-limits.md`).
> **The platform passes its own test:** with the calculator tools broken on purpose (a positive
> control set out before the run), it found +44.8 points (+23.8 to +65.7, p = 0.0011), flagged 7
> tasks, all among those predicted and none of the 7 controls, and named "wrong tool" as the
> cause in 68 of 83 failures. The same v1 vs v2 on two more harnesses: own loop +8 (−4 to +23),
> LangGraph +17 (+5 to +29, p = 0.047, "better"). **The judge is so far checked only against the
> human labels used for tuning,** where its overall verdict was too lenient, so no judge verdict
> counts in the result. The write-up, with inspected trials: `docs/experiment.md`.

## Run it

You need Docker with the compose plugin and about 15 GB of free disk (a cold build used about
9.9 GB in testing). The first build takes about 5 minutes on 4 vCPUs, mostly building the images:
downloading the base images was about a minute of it.

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
files stay in `./runs/`, your labels in `./labels/`, and prompt versions you saved in
`configs/prompts/`. To remove the trial files, delete what is inside `runs/`, not the folder
itself: `rm -rf runs/*` (one fake run of 150 trials left about 22 MB there in testing). No sudo is
needed. The API runs as uid 1000; when you are another user, its start-up step gives those three
folders (the folders only, never what is in them) to uid 1000, keeps your group and makes them
group-writable, so everything it writes there is yours to delete. If `rm` is refused anyway (a
folder Docker created because it was missing belongs to root), delete from inside the API:
`docker compose exec api sh -c 'rm -rf /runs/*'`.

If `docker compose up --wait` stops with the api container unhealthy, `docker compose logs api`
says why in plain words: the database is down, or a folder above cannot be written, with the fix.

## Three ways in

The home page offers:

1. **See a finished example.** The real experiment, shipped with the repo: prompt v1 against v2
   on Hermes with Claude Haiku 5.5, 10 held-out tasks and 10 trials per task and arm (200 trials),
   with its A/A calibration (v1 against itself, another 200). You see the verdict, the difference
   with its interval, each task's pass counts, and every trial's trace (messages, tool calls and
   results, grader reasoning) and its grades. Nothing runs and nothing is spent.
2. **Build your own, step by step.** Pick an agent type (each has an "i" that says what it is and
   what it adds to your prompt), a model, the instructions and a few settings. Preview exactly
   what reaches the model, for free. Then evaluate it against a baseline: run it, compare the
   results, and open a failed trial to see why it failed. Running it on a real model needs a
   provider key (see Run it); without one you can build, save and preview it, and run on a fake
   model from the full Config screen to see the platform work, not the agent.
3. **The full platform.** Every experiment, config, task, harness and label, at full detail.

The first door opens `http://127.0.0.1:8080/#/example`. The first time, it copies the examples shipped
in `examples/` (the experiment and its A/A calibration) into your local database: rows are only
inserted, the examples are read-only, and nothing runs or is spent. `GET /api/examples` lists the
shipped examples; `docs/experiment.md` explains the result and `docs/known-limits.md` what it
cannot show.

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

An open-weight model runs locally the same way: `qwen2.5-7b-local` is already registered, served by
an optional Ollama service. Start it with `docker compose --profile local-model up -d ollama`, pull
the model once with `docker compose exec ollama ollama pull qwen2.5:7b` (about 4.7 GB), and pick it
in a config. It costs nothing, but on a CPU-only machine each model call takes minutes.

## Add a task

One folder `tasks/<id>/` with a `task.json`: the messages (or a simulated client), the client's
data file if it has one, and its graders (exact numbers from a tool, tool called or not, text
present or absent, end state, number provenance, a Python unit test, or the LLM judge with a
rubric). See `tasks/README.md` and `docs/proposals/grader-format.md`; the API picks a new task
up without a restart.

## Develop and test

You need Node 22.14 or later, pnpm 10.34.9 (run `corepack enable` once; the first `pnpm` then
asks to download that version) and [uv](https://docs.astral.sh/uv/) for the Python projects. None
of these call a real model; tests use the fake model server.

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build      # apps/api, apps/ui
cd graders && uv sync --locked && uv run pytest -q                           # graders and the judge
cd stats && uv sync --locked && uv run pytest -q                             # judge agreement maths
cd workers/adapterlib && uv sync --locked && uv run pytest -q                # contract, runner
python3 scripts/smoke.py                                                     # the running stack, end to end
docker compose --profile smoke run --rm netcheck                             # worker isolation
```

**The API's database tests.** Without `TEST_DATABASE_URL`, `pnpm test` skips the API's
database suites: Jest's summary for the API reads `Test Suites: 11 skipped, 32 passed, 32 of 43
total`, and a warning says they were skipped, not passed. To run them, start a throwaway
Postgres (never the compose one), then stop it:

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
- `docs/experiment.md`: the real experiment: the hypothesis and analysis plan committed before the
  runs, then the results, the controls, the trajectories and the conclusion.
- `docs/known-limits.md`: where the platform's conclusions should not be trusted.
- `docs/cost.md`: the cost formula and the actual spend.
- `docs/assumptions.md` and `docs/decisions.md`: every assumption, and every design decision with
  its options and reasons.
- `docs/harness-guide.md`: how each harness behaves and how it is wrapped.
