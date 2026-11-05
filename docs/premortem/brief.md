# Pre-mortem brief

Written Tue 3 Nov 2026, midday. Read this in full before anything else.

## The premise

It is Saturday 7 Nov. The submission went out late, broken, or with a conclusion an interviewer took apart in ten minutes. Work backwards: what broke, when did it first show, and what could we have done on Tuesday to prevent it?

Nothing is built yet. Only plans and research exist. That is the point: find the breaks while the design is still paper.

## The brief, condensed

Take-home for an Applied AI Engineer role. Build a platform that evaluates any agent harness running with any model and answers "did the agent get better, worse or stay the same, and how sure are we?"

- **Stack:** NestJS API and Vue 3 UI in TypeScript; Python workers allowed. One command to run locally, for example `docker compose up`, with keys from `.env`.
- **Harnesses:** Hermes Agent required, at least one more. Models: two providers or one open-weight, through a common interface.
- **Must do:** 20+ tasks with deterministic graders (exact match, unit tests, state checks) and an LLM judge validated against human labels; configs as harness × model × settings (skills, memory, tools, temperature, step and token budgets), versioned; every task under every config with N trials; isolated runs; timeouts, rate limits, retries and partial failures without corruption; A vs B with confidence intervals, a paired test, per-task deltas, a clear "just noise" verdict, cost, latency and tokens; full trajectory view per trial; failure categories as a stretch.
- **Deliverables:** tested repo with README; design doc on architecture, adapter interfaces, data model, isolation and reproducibility, graders and their validation, statistics and choice of N; known limits; cost formula and actual spend; one real experiment on a single axis with hypothesis, setup, CIs, 2 or 3 inspected trajectories and a conclusion; a video of 10 minutes or less.
- **Graded on:** eval methodology, abstraction, observability, engineering quality, judgment. "We care more about sound evaluation design than about feature count."

## People and time

- Rishi is the architect and the only human. He must explain every part in the next interview round. Claude Code implements what he agrees.
- Timeline: Tue SP0 foundations, SP1 adapters, SP2 data model. Wed SP1 to SP4. Thu SP4 to SP7, "the crunch". Fri morning platform freeze, then judge validation and the real experiment. Sat docs, video, submit.
- Rishi must hand-label about 80 trials for judge validation, on Thu and Fri.
- Budget: about $100 on the Claude API, about $50 on OpenAI or Gemini.

## The assumed design

Settled items are marked. Everything else is the current lean, treated as the plan for this exercise.

- **Harnesses (settled):** five. Hermes at a pinned commit, used unmodified; LangGraph; Google ADK; OpenAI Agents SDK; our own plain tool-calling loop. Each is an adapter. Cut order if time slips: the two SDKs, then LangGraph, never the own loop.
- **Domain (settled):** a personal-finance assistant. Tools do loan amortisation, payoff schedules, budgets and interest, and read or update a ledger. Responses must fit the person's circumstances: debt after a spouse's death should get a different answer from a loan for a phone bought under peer pressure. Tasks are calculations (exact match), ledger changes (state checks) and advice (numbers checked deterministically, fit to circumstance judged by an LLM).
- **Tool delivery (lean):** one MCP server for the finance tools, consumed by all five harnesses.
- **Models:** through LiteLLM. Second provider Gemini or OpenAI, undecided. Possibly an open-weight model through OpenRouter.
- **Architecture (lean):** NestJS owns Postgres, used as the job queue. Python workers claim and report trials over HTTP. Graders and statistics in Python.
- **Isolation (lean):** a container per trial. The worker launches it through the Docker socket.
- **Traces (lean):** our own small JSON schema, borrowing OpenTelemetry `gen_ai.*` attribute names. Each harness adapter maps its native events into it.
- **Experiment (lean):** Hermes, memory on and empty versus memory on and seeded with client facts. Memory tasks in three tiers: fact only in memory; fact also findable in the ledger with extra steps; memory irrelevant. N chosen from a pilot on a cheap model.
- **Statistics (lean):** the task is the pairing unit. Per-task pass-rate deltas, hierarchical bootstrap that resamples tasks then trials, a permutation or paired t check, Wilson or Newcombe intervals, an A/A run as the noise floor, an explicit "noise" verdict.
- **Judge:** pinned model, blind to harness and model, one verdict per criterion with quoted evidence. Validated on about 20 tuning labels, about 40 held-out labels from the pilot and about 20 audit labels from the real run, with Cohen's kappa and per-config agreement.

## Hermes facts from the code audit

All from reading the pinned code. Hermes has not been run yet.

- **Self-modification is on by default** with memory or skills tools: a background review thread writes skills and memory after a run, and the agent's own tools write too. Every behaviour has a switch, several only in `config.yaml`. The agent editing its own `config.yaml`, `SOUL.md` or `AGENTS.md` has no switch; only a file hash detects it.
- **The prompt varies with the host:** date, timezone, home path, working directory, kernel release, scratch path, an environment-probe line and a git snapshot. Byte-identical prompts for concurrent trials need a container per trial. Several agents in one Python process is ruled out by process-global state.
- **Memory** is read only by injection into the system prompt at construction, as a frozen snapshot. `skip_memory=True` does not turn memory off.
- **Most of the trace is in plugin hooks**, not constructor callbacks. Hooks load from a plugin folder in Hermes's home. `max_iterations` triggers one extra summary call missing from Hermes's own token and cost totals. Early exits return no token counts.
- **Compression** is on by default and rewrites the message list.
- **MCP works unmodified**, but Hermes prefixes tool names, hides MCP tools behind a tool-search bridge unless turned off, wraps results as "untrusted" with no switch, and pauses a server for 60 s after three consecutive error results.
- **Routing:** a model name starting with `gpt-5` silently switches Hermes to the Responses API unless the API mode is pinned. Prompt-cache markers are added only when the proxy hostname contains `litellm` and the model name contains `claude`.
- **The local terminal is unsandboxed** and auto-approves dangerous commands headless. The agent can read its LLM key in every isolation option.
- **Python 3.14 only.** Hermes is a large repository: 10,600 Python files, about 400 MB checked out.

## Eval research facts

- **Benchmarks break more than expected:** audits found 16% to 72% of tasks broken. Changing only the harness moves scores by 9 to 34 points.
- **Statistics:** treating trials as independent pushes false-positive rates above 45%. With about 20 tasks, only large effects are detectable: roughly 6 to 25 points depending on assumptions, whatever N is. Tasks discriminate only near 30% to 70% pass rates. A single run's pass@1 moves 2 to 6 points from noise alone.
- **Judges:** best practice is binary verdicts per criterion with a reference answer and an "unknown" exit. Judges miss a meaningful share of failures on agent transcripts and default to leniency. Accuracy drops sharply on long traces. Judges are weakest on emotional framing. Repeated judging at temperature 0 still disagrees. 60 to 80 labels is the floor for an overall agreement number and too few for a per-config gate.
- **Practice:** humans must read transcripts. Error analysis reads about 100 traces. Task validity, rubric criteria, judge agreement and "is this difference meaningful" have no automated substitute.
- **Cost:** LiteLLM prices unknown models at zero, cached-token pricing varies by provider, and retry billing is undocumented.

## Gemini's independent list

From an independent review of the brief:

- concurrent trials colliding on shared tool state;
- runaway token loops exhausting the budget and taking down the worker pool via rate limits;
- judge non-determinism inflating variance and invalidating paired tests;
- long trajectories truncated by the judge's context, so it grades only part of a run;
- flattening LangGraph's nested asynchronous state into messages drops debugging context;
- one failure taxonomy across harnesses leaks, because each surfaces errors differently;
- rate-limit retry backoff inflating latency for one config;
- simple cost formulas break with prompt caching and split input and output prices.

As we read the brief, it rewards judge validation, a valid paired test with CIs and per-task deltas, adapters that add a harness without touching the core, strict isolation, granular traces, robustness to timeouts and partial failures, and honesty about limits. It penalises single-trial results, harness-specific assumptions, brittle pipelines and over-investment in visuals.

## Environment facts on Rishi's machine

- Rishi is not in the `docker` group and the compose plugin is not installed. Docker does not run yet.
- Hermes's dependencies are not installed. An earlier hands-off attempt found that Claude Code's auto mode blocked installing Hermes.
- `pnpm` and `gh` are missing. Node 22, uv and Python 3.14 are present.
- Today's research was interrupted twice, once by a usage limit and once by a network outage, costing about an hour.
- The fake OpenAI-compatible LLM server for tests is not built yet. Hermes streams responses by default.

## Deeper sources, for targeted reads only

- `docs/SPEC.md` and `docs/decisions.md`
- `docs/research/reports/Agent evals state of the art.md`
- `docs/research/reports/Hermes architecture and traces.md`
- `docs/research/trace-standards.md`
- `docs/research/hermes/*.md`: four detailed code audits
