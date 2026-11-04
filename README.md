# agent-evals

Run agent harnesses across models and settings, and compare them with paired trials and confidence intervals.

The platform answers one question with evidence: did the agent get better, worse or stay the same, and how sure are we? Harnesses (Hermes Agent, LangGraph, Google ADK, the OpenAI Agents SDK and a plain tool-calling loop) plug in as adapters. Every model call goes through a LiteLLM proxy, which is where settings, spend and usage are checked.

> Status: SP0 foundations. The sections marked *later* are filled in as the work lands. The plan is in `docs/SPEC.md`.

## Run it

Needs Docker with the compose plugin.

```bash
docker compose up
```

That starts Postgres, LiteLLM, the fake model server, the API and the UI. Open the UI at http://127.0.0.1:8080. All ports bind to localhost only.

No `.env` is needed for local runs or tests. Real runs need provider keys: copy `.env.example` to `.env` and fill in the keys you need.

To open a finished example without running anything, load one of the shipped examples (`examples/`): `curl -X POST http://127.0.0.1:3000/api/examples/harness-ownloop-vs-hermes-haiku/load`. `GET /api/examples` lists them. A loaded example is sample content and read-only; today's is a small draft stand-in (`docs/known-limits.md`).

## What runs where

| Service | What it does | Port (localhost) |
| --- | --- | --- |
| `ui` | Vue 3 UI, served by nginx, proxies `/api` to the API | 8080 |
| `api` | NestJS control plane: owns the database and the trial queue; workers talk only to it, over HTTP | 3000 |
| `litellm` | Model proxy: every model call, per-trial virtual keys and budgets, no response cache | 4000 |
| `fake-llm` | Scripted OpenAI-compatible server for tests and CI, with forced faults | internal only |
| `postgres` | Platform database, plus LiteLLM's own database | internal only |

Harness workers run on an internal network that reaches only the API, LiteLLM and the fake model server, with a read-only root filesystem and one writable trial folder (`docs/design.md`, section 4).

## Develop

```bash
pnpm install                 # TypeScript apps (apps/api, apps/ui)
pnpm lint && pnpm typecheck && pnpm test

cd services/fake-llm         # each Python project has its own uv environment
uv sync && uv run ruff check . && uv run pytest -q
```

Stack checks, with no LLM spend:

```bash
docker compose up -d --build --wait
python3 scripts/smoke.py                              # UI, API, LiteLLM -> fake model
docker compose --profile smoke run --rm netcheck      # worker isolation
uv run --no-project --with pyyaml==6.0.3 python scripts/check_litellm_config.py
```

## Add a harness

*Later (SP1).*

## Add a model

*Later (SP1).* A new model is one entry in `services/litellm/config.yaml`.

## Add a task

*Later (SP4).*

## Docs

- `docs/design.md`: architecture, adapters, data model, isolation, graders, stats.
- `docs/decisions.md`: every design decision, with options and reasons.
- `docs/experiment.md`, `docs/cost.md`, `docs/assumptions.md`, `docs/known-limits.md`.
