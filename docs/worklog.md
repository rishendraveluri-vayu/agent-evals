# Worklog

Not required by the brief. It records what was built and by whom, so the next-round conversation is easy. Keep it or remove it before submission.

## Tue 3 Nov

- Rishi: scope, budget, deadline, LiteLLM.
- Claude: read the brief and Hermes source, measured Hermes prompt overhead, drafted this spec and the doc stubs.
- Rishi ruled: four harnesses (R1), modular adapters (R2), explicit self-improvement only (R3), trace standard research (R4). Opened D11 and D12.
- Rishi settled D11 as both SDKs (R5, five harnesses) and D13 as a personal-finance assistant (R6). Opened D14 on tool delivery.
- Claude: launched research on agent-eval methodology, Hermes architecture and traces, and trace standards. Reports land in `docs/research/`.
- Claude delivered: `docs/research/reports/Agent evals state of the art.md` and `docs/research/reports/Hermes architecture and traces.md`, from five eval notes, one trace-standards brief and four Hermes code audits. Hermes notes rewritten with the audit corrections. D15 opened.
- Claude ran a pre-mortem with five reviewers (CTO, eval methodology, platform, integration, hiring panel) on a shared brief that included Gemini's analysis. Summary in `docs/premortem/summary.md`. Verified that the harnesses' pinned dependencies conflict.
- Surprises: Hermes self-modifies by default once memory or skills are on; `skip_memory` does not turn memory off; most of the trace lives in plugin hooks, not callbacks; MCP works unmodified but wraps results as untrusted. Two interruptions, a usage limit and a network outage, cost about an hour; no work was lost.
- Rishi ruled R7: five harnesses stay, built in parallel once Hermes and the own loop run one task end to end, each gated on the settings and tool tests. Deadline per harness still to set.
- Environment fixed with Rishi's sudo: Docker group, compose and buildx, `gh` login. Claude: Hermes installed at the pin on Python 3.14 and imports cleanly; pnpm 10.34.9; git repo initialised and the first commits made.
- Surprises: pnpm 12 does not run under Node 22.14's corepack; a bare `import run_agent` builds a whole Hermes home folder, so `HERMES_HOME` must be set per process before import.
- Rishi settled D4 (Gemini is the second provider), set R7's deadline (Thursday 12:00 per extra harness), ruled R8 (every real run is scoped and signed off, even under a dollar; no standing budget) and R9 (fake model server for tests and CI, plus real dev runs on Haiku 5.5 and Gemini Flash).
- Claude started `docs/design.md`: decided entries and verified constraints only, open items pointing at `decisions.md`.
- Rishi settled D1 (graders and stats in Python) and D2 (HTTP through the API; workers never touch the database), and delegated D3 to "simpler and more robust". Claude chose one long-lived container per harness with a fresh process per trial, and logged the tradeoff.
- SP0 done: `docker compose up` starts Postgres, LiteLLM v1.99.4, the fake model server, the API and the UI, all healthy, and CI is green on the first run (lint, typecheck, tests, LiteLLM config check, compose smoke, worker isolation check) with no provider keys. Claude built the compose stack, LiteLLM config, worker base, CI and docs; two agents built the fake model server (73 tests) and the API and UI skeletons (21 tests). Rishi created the repo, chose MCP for D14, and still owns the rate-limit tier check.
- Surprises: LiteLLM v1.99.4's bundled price map has no Haiku 5.5 or Gemini 3.8 Flash, so spend would read $0 and budget caps would never trip; the config check now requires explicit prices. Port 3000 on Rishi's machine is held by sibling-project processes, so host ports are configurable.
- Four SDK checks (LangGraph, ADK, Agents SDK, Claude Agent SDK) and the finance MCP server (164 tests, 11 tools) landed. Rishi walked through and approved the adapter rules (R10), revising the limits rule, and settled D12, D14's transport and D16 to D21 one question at a time.

- Rishi approved contract v2 as a start without a full read, to iterate on 4 Nov (R12).
- Claude implemented, against the fake model only (no real calls): the contract v2 JSON Schemas; the shared adapter library (stdlib only: spec, watchdog timeout, spans, conversation loop with the simulated client and its reply cache, step budget across turns, applied-settings sources, integrity hashes, atomic result) and its runner (process group, D23 safety net, leftover sweep, schema check, labels, per-trial LiteLLM keys, spend-log merge into chat spans); the gate kit; the own loop and the Hermes adapter, each passing every gate directly and through LiteLLM; the simulator prompt draft `client-sim.v1`; the interim trace view and spend chart; the `new-harness` scaffold and the `probe-harness` command, which now writes both harnesses' capabilities from evidence; and the invariance diff, which shows prompt v1 vs v2 differing only in the prompt lines for both harnesses.
- Surprises: Hermes repairs malformed tool-call JSON and runs it without telling the model (no switch; recorded under D18). LiteLLM cut stored bodies at about 2,000 characters, which removed the task prompt from Hermes's stored system prompt, and its spend log lagged past the runner's first wait so a fast trial showed 0 calls; both fixed and guarded. A wildcard route priced only in `model_info` logged $0. Hermes at `max_steps=3` made 5 calls and counted 3, which the trace view now shows side by side.

## 4 Nov

- Rishi re-planned the week (R13): Claude finishes every harness on real models and a basic UI today; Rishi writes the evals from `docs/harness-guide.md`, a 26-page guide to each harness that Claude produced from the research notes, the adapters and the probes.
- Claude built the LangGraph, Google ADK and OpenAI Agents SDK adapters in parallel, one agent and one worktree each (R7). All three pass the 8 gates, the drift test and the proxy tests, and are combined with Hermes and the own loop on branch `sp1-harnesses`, waiting for Rishi's review before merge.
- Rishi approved the data model as proposed (R14). Claude wrote the control-plane API contract (`docs/api-contract.md`), so the API, the worker and the UI could be built in parallel; the API alone holds the LiteLLM master key.
- First signed-off real run: 15 trials on Claude Haiku 5.5 across all five harnesses, $0.077. Every harness answered a tool-using finance question and held a 3-turn simulated-client conversation, and LiteLLM's call count matched each harness's own in every trial.
- Built in parallel by three agents against `docs/api-contract.md`: the control-plane API (155 tests, including the database suites on a real Postgres), the worker loop with one image per harness (D3 leak test and a mid-trial `docker kill` per image), and the nine UI screens from the approved canvas design (123 tests). A five-reviewer critique loop then polishes the UI for up to 10 rounds.
- Incident: the API agent ran `pkill -f "node dist/main.js"` to stop its own test server and also stopped the live API container and a sibling project's server on port 3000. Rishi okayed restarting ours. Agent briefs now forbid killing processes by pattern.
- The worker review found that workers mounting `runs/` read-write let trial 2 read trial 1's stored files; files now go to the API over HTTP instead (D2), fixed before SP3 counts as done.
- Surprises: an organisation-level Anthropic key without a workspace is refused with a 400, and the runner labelled that setup error `agent`; Haiku 5.5 rejects temperature outright; the simulated client contradicted its own client file and never ended a conversation; ADK replaces a malformed tool call with a call to a tool that does not exist, and LangGraph ends the run when a reply holds only malformed calls.

## 5 Nov

- Rishi designed the statistics (D10, D41 to D44) and, after the simulations below, revised D10's interval to a task bootstrap and approved the 6-task floor (D50).
- Claude implemented SP6: the comparison's statistics in the API (`apps/api/src/stats/`, TypeScript, seeded): the verdict with its 95% interval and the exact sign-flip test, per-task Newcombe intervals and Fisher tests with Benjamini-Hochberg flags, the critical-failure guardrail from a new optional grader `severity`, the regression list, and cost, tokens and time (time without trials whose model call LiteLLM retried). A/A calibration runs (D44): one config on both arms when marked, its interval shown under every A/B of that config. The Compare, Run, Experiments and Tasks screens show it all.
- Surprises: the first design's two-level bootstrap counted trial noise twice; on simulated data it covered the truth 99% of the time and found a real +15 points only 69% of the time at 20 tasks, against 85% for tasks only, which is why D10 was revised. At the headline's 10 to 12 held-out tasks, a real +15 is found only about half the time. Exactly counting 2^20 sign patterns took half a second per comparison until it was split into two halves of 2^10.

## Entry template

```markdown
## <day>
- Rishi designed: ...
- Claude implemented: ...
- Surprises: ...
```
