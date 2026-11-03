# Decisions

Rishi makes these calls. When one settles, move it to Decided and fill in the options, the choice, why, and what would change it.
"Lean" is Claude's suggestion from planning, not a decision.

## Decided

| Decision | Choice | Source | Date |
| --- | --- | --- | --- |
| API and UI | NestJS and Vue 3 with TypeScript | Brief | 3 Nov |
| Required harness | Hermes Agent at a pinned SHA, used as it comes | Brief | 3 Nov |
| Model interface | LiteLLM | Rishi | 3 Nov |
| Deadline | Saturday 7 Nov | Rishi | 3 Nov |
| LLM budget | About $100 Claude API, about $50 OpenAI or Gemini | Rishi | 3 Nov |
| Harness set (was D6) | Hermes, plus LangGraph, Google ADK, OpenAI Agents SDK and an own plain tool-calling loop. Each is an adapter. | Rishi | 3 Nov |
| Agents ADK (was D11) | Both: Google ADK and OpenAI Agents SDK, "both are most common" | Rishi | 3 Nov |
| Task domain (was D13) | Personal-finance assistant: calculation tools plus context-sensitive advice | Rishi | 3 Nov |
| Second provider (was D4) | Gemini, next to Claude | Rishi | 3 Nov |
| Graders and stats (was D1) | Python | Rishi | 3 Nov |
| Worker boundary (was D2) | HTTP claim and report; workers never touch the database | Rishi | 3 Nov |
| Trial isolation (was D3) | One long-lived container per harness, a fresh process per trial, one trial at a time per container | Rishi delegated ("simpler and more robust"); Claude's recommendation | 3 Nov |
| Tool delivery (was D14) | One MCP server for the finance tools, shared by every harness | Rishi | 3 Nov |

## Open

| # | Call | Options | Lean | Needed by |
| --- | --- | --- | --- | --- |
| D5 | Open-weight model | Hosted through OpenRouter, or local | Hosted, gpt-oss-120b if tool calling holds up | Wed |
| D7 | Tasks using the judge | Any share of the 20+ | About 6 to 8 | Thu |
| D8 | Judge threshold and what happens below it | Set before seeing results | Below threshold leaves the headline score | Thu |
| D9 | Experiment axis and N | Model, harness, memory or skills; N from the pilot | Memory empty vs seeded, if memory is the axis | Fri |
| D10 | Unit of analysis for the stats | Task, trial, or trials nested in tasks | Resample tasks, then trials within them | Thu |
| D12 | Trace format across harnesses | OpenTelemetry GenAI conventions, OpenInference, or an own schema | Research first, see R4 | Wed |
| D15 | Hermes settings that are design calls | Compression on or off; Tool Search off or on; in skills-on configs allow `skill_manage` writes or stage them; accept the untrusted MCP wrapper or not | None yet. Evidence in `docs/research/hermes/context_and_self_improvement.md` | Wed |

## Notes behind the open calls

**D1, D2, D3.** Settled on 3 Nov, see the entries below.

**D6.** Settled on 3 Nov, see the entry below.

**D11.** Settled on 3 Nov as both, see the entry below.

**D13.** Settled on 3 Nov, see the entry below. The three-tier rule for memory tasks still applies: fact only in memory, fact also discoverable with extra work, memory irrelevant. Otherwise the experiment is true by construction.

**D14.** Settled on 3 Nov as MCP, see the entry below. Evidence from 3 Nov in `docs/research/hermes/custom_tools.md`: Hermes takes an MCP server unmodified. Costs: prefixed names, Tool Search must be turned off, results wrapped as untrusted with no switch, a 3-error circuit breaker, and discovery is the caller's job. A Hermes plugin is the alternative: bare names, no wrapper, duplicated schemas.

Original note: Five harnesses must expose the same finance tools or a harness comparison measures the tool gap. One MCP server gives byte-identical tool schemas to every harness, and LangGraph, Google ADK and the OpenAI Agents SDK all consume MCP natively. It hinges on whether Hermes can load an MCP server from config without a source change. A CLI through the terminal tool is the fallback: parity is guaranteed but tool calls become shell strings, which weakens trace quality and failure analysis. Native functions per adapter are the most work and the easiest to drift.

**D12.** Evidence from 3 Nov in `docs/research/trace-standards.md`: OpenTelemetry GenAI is all "Development" stability with memory and skill attributes in no release; OpenInference is stable but has no memory or skills. Options: pure OpenTelemetry GenAI, OpenInference plus Phoenix on our Postgres, or our own small schema on an OTLP-shaped envelope with `gen_ai.*` names. The brief says the evidence favours the third. Hermes needs a trace plugin under any option.

Original note: Four harnesses each emit traces differently. A shared trace schema is what lets one trial view and one failure analysis work for all of them. OpenTelemetry GenAI semantic conventions and OpenInference are the two candidate standards. Decide after the research in R4.

**D9.** Memory on vs off isn't one axis: enabling it changes the tools and the prompt even with nothing stored. Memory on and empty vs on and seeded is cleaner.

**D10.** Trials of one task are not independent samples, so treating 400 trials as n = 400 overstates confidence. With 20 tasks, the task count may limit power more than N does, so raising N eventually stops helping. McNemar also needs a defined pairing unit, so settle that first.

## Rulings

Dated statements from Rishi that constrain the design. Not option-choices, so they carry no D number.

- **R1 (3 Nov). Four harnesses.** Hermes as required, plus LangGraph, one agents ADK (D11) and an own plain tool-calling loop. Rishi accepts the schedule risk knowingly: "it is the only way we can show we can do this."
- **R2 (3 Nov). Modularity is the point.** Adding a harness must be an adapter, and the design has to show how easy that is. Hermes first, then the others through the same interface. Rishi's test cases for the interface: adding a GitHub coding agent or the Claude Agent SDK tomorrow should be simple.
- **R3 (3 Nov). Self-improvement must be explicit.** Any behaviour where the agent changes its own prompt, skills or memory in the background has to be a configurable setting, off unless a config turns it on. An implicit change mid-experiment means the comparison is not a proper test.
- **R4 (3 Nov). Investigate a trace standard.** Check whether OpenTelemetry or OpenInference can carry traces from all harnesses before designing our own format. Feeds D12.
- **R5 (3 Nov). Five harnesses.** D11 settled as both SDKs, so R1 now reads Hermes plus LangGraph, Google ADK, OpenAI Agents SDK and the own loop.
- **Pre-mortem note (3 Nov), not a ruling.** Three of five pre-mortem reviewers challenged R5 with evidence, and a dependency check confirmed the harnesses cannot share one Python environment. Options are in `docs/premortem/summary.md`. Resolved by R7.
- **R6 (3 Nov). Tool call and judgment at the crux.** The domain must need both a correct tool call and a context-sensitive response. Rishi's example: debt taken to cover a spouse's death should get a different answer from a loan for the latest phone because friends bought one. "Anything with tool call and intelligence at the crux."
- **R7 (3 Nov). Five harnesses, built in parallel and gated one by one.** Pre-mortem option C. R5's five harnesses stand. Hermes and the own loop come first, until one task runs end to end through both. Then LangGraph, Google ADK and the OpenAI Agents SDK are built in parallel, each by its own agent in its own folder. Each counts only once it passes two tests: temperature and the token and step limits actually reach the model request, and it sees the same tools and tool results as Hermes. A harness that misses its deadline is cut on its own, with the reason recorded. Cut order: the two SDKs first, LangGraph last, never the own loop. Rishi reviews each adapter before it merges. Rishi's reasoning: "adapters are generic code that require less of my time and can happen in parallel." Deadline per harness: Thursday 5 Nov, 12:00.
- **R8 (3 Nov). Every real run is signed off, whatever it costs.** No standing budget for now. Before any real LLM call, Claude scopes the run (trials, models, estimated cost) and Rishi signs off explicitly, "even if it is a dollar or less". Budget must not block development: "lets not let budget stop dev". The pre-mortem's standing spending envelope is declined for now; revisit when real runs start.
- **R9 (3 Nov). Fake model server plus real models.** Tests and CI use a fake OpenAI-compatible server with scripted replies, streaming, and forced faults: 429, timeout, 500 and a broken stream. Real dev runs on Haiku 5.5 and Gemini Flash cover what a fake cannot: real latency, real rate limits and provider quirks through LiteLLM. They run locally, never in CI, each signed off under R8. Rishi's reason for adding real models: the fake "doesnt time out hit rate limits which are classic issues we hit".
- **R10 (3 Nov). Adapter rules.** Rishi approved each, walked through one at a time. (1) One fresh process per trial reads `spec.json` and writes `result.json` and `trace.jsonl`; nothing else crosses the boundary. (2) The adapter reports how the run ended and never judges; graders score; the runner labels agent outcomes versus infra failures, which are reported, never silently dropped. Rishi: the end-state list "may change and the granularity of this maybe more than what we think right now", so it is provisional and every result also stores the harness's raw stop signals for later relabelling without re-running. (3) Every model call goes through LiteLLM with a per-trial key; workers hold no provider keys and have no internet route. (4) Each adapter declares the settings it supports from the platform's full set; a config asking for anything else is rejected before the run. (5) A claimed setting counts only once the settings test shows it in the captured request, and tools must pass the tool test. (6, revised by Rishi) Adapters push every limit into the harness's native mechanism, with the wrapper adding one where the harness has none (e.g. a whole-trial timeout), so trials end cleanly with a result. Runs are sized upfront from the cost, time and N estimate and only started if they can finish; Rishi: "no point running 15 out of 100 its better to say that upfront". The runner's timeout and the proxy's spend cap stay only as safety nets set well above the estimate; one tripping is an infra event to investigate. (7) Built-in harness tools are off; the agent sees exactly the task's tools plus anything the config explicitly enables. (8) Memory, skills, background review, sessions, self-edits and compression are off unless the config turns them on; every trial starts from a wiped folder; Hermes's `config.yaml`, `SOUL.md` and `AGENTS.md` are hashed before and after each trial. (9) LiteLLM's records are the source of truth for tokens, cost, latency and call counts; harness-reported counts are kept for comparison. (10) Adapters only translate: no task logic, no grading, no prompt edits; a new harness is one folder with its Dockerfile, adapter, capabilities file and two gate tests. (11) Every harness's built-in retries are set to zero, so retrying happens in exactly one place. (12) On a safety-net timeout the runner kills the adapter's whole process group.

## Settled entries

### D6: Second harness (3 Nov)
Options: own plain loop only; one existing framework; several frameworks plus an own loop.
Choice: Hermes plus three more: LangGraph, one agents ADK (D11), and an own plain tool-calling loop.
Why: the brief grades abstraction on whether a new harness is a small change. One extra harness shows an adapter exists; three show the interface holds across frameworks that model loops, tools and traces differently. The own loop stays as the clean control.
What would change it: a slip past Wednesday on the Hermes adapter. Then the order of cuts is ADK first, LangGraph second, never the own loop, since the brief requires at least one second harness. Superseded by R7: the two SDKs are cut first, LangGraph last, each on its own deadline.
Cost: if harnesses are compared, each needs equivalent file and terminal tools, or the comparison measures the tool gap.

### D11: Which agents SDK (3 Nov)
Options: Google ADK only; OpenAI Agents SDK only; both.
Choice: both.
Why: they are the two most common agent SDKs, so an interviewer recognises each, and two SDKs with different tool and tracing models are a stronger test of the adapter interface than one.
What would change it: a slip on the Hermes adapter. Cut order is set in SPEC SP1.

### D13: Task domain (3 Nov)
Options: coding sandbox; terminal and data ops; business-ops CRM sandbox; personal-finance assistant.
Choice: personal-finance assistant. Tools do the arithmetic (loan amortisation, payoff schedules, budgets, interest), and the response has to fit the person's circumstances.
Why: it needs a tool call and judgment in the same task, which is what the harness-times-model question is about. Rishi has built a finance agent before, so he can write and label these tasks credibly. No code from that project is reused; the domain tools are written fresh for this platform. Calculations give exact-match and state-check graders; the advice gives judge tasks a real reason to exist; client circumstances in memory give the D9 memory axis natural tasks. It also goes beyond the coding domains everyone uses.
What would change it: if the judge cannot be validated to threshold on the empathy rubric in SP5, the judge-graded tasks fall back per D8 and the experiment leans on the deterministic tasks.

### D4: Second provider (3 Nov)
Options: Gemini or OpenAI.
Choice: Gemini, next to Claude.
Why: Rishi's call. The planning lean was Gemini because its price was the one found, and Gemini Flash is one of the two cheap models for real dev runs (R9).
What would change it: not stated.

### D1: Where graders and stats live (3 Nov)
Options: Python or TypeScript.
Choice: Python.
Why: Rishi's call. Python puts graders next to the harness workers and gives proven stats libraries. The cost noted at planning: the NestJS side does less, so it must earn its place as the control plane.
What would change it: not stated.

### D2: Worker boundary (3 Nov)
Options: HTTP claim and report through the API, or direct database access from workers.
Choice: HTTP. Workers claim trials and report results through the NestJS API and never hold database credentials.
Why: Rishi: logging and the like work better through the API, and giving workers direct database access is risky; the API controls it. It also keeps one owner of the schema instead of two languages sharing it.
What would change it: not stated.

### D3: Trial isolation (3 Nov)
Options: a container per trial; a process per trial on a shared host; one long-lived container per harness running a fresh process per trial, one trial at a time.
Choice: the third. Each harness is a compose service with its own image. Its runner claims one trial, starts a fresh process for it with every writable path (Hermes home, `HOME`, `TMPDIR`, tool state) in one trial folder at a fixed path, then kills every leftover process, wipes the folder and checks it is empty before claiming the next. The root filesystem is read-only. Parallelism comes from running more replicas of a service.
Why: Rishi delegated the call: "which is simpler and more robust do that." Simpler: no Docker socket in the worker, no sibling containers to reap after a crash, no host-path bind mounts, and every image is built by `docker compose up` (pre-mortem break 13). More robust: a worker crash kills its own trial, so resume cannot double-run it (break 9); tool state lives in the trial folder, so trials never share a ledger (break 8); one trial per container means fixed paths, so prompts that carry home, cwd and scratch paths stay identical across trials; agent shell commands stay inside the container. Each harness keeps its own dependencies, which the verified conflicts require.
Given up: consecutive trials in one container are separated by the process sweep, the wipe and the read-only root, not by a fresh container. Every research harness surveyed uses a container per trial, but those run coding tasks that mutate a whole environment; finance tasks touch only the trial folder. Hermes's scratch-prune child deliberately outlives its parent (`hermes_constants_scratch_detach.py`), which is why the runner sweeps leftover processes. The SP3 leak test checks the separation.
Still needed either way: the LiteLLM key is readable inside the container, so each trial gets its own virtual key with its own budget.
What would change it: the leak test failing, or a harness that must write outside the trial folder.

### D14: How task tools reach every harness (3 Nov)
Options: one MCP server shared by all; a CLI driven through each harness's terminal tool; native tool functions written per adapter.
Choice: one MCP server, `services/finance-mcp/`. Rishi: "start coding the basic mcp for finance stuff, like bare minimum for indian finance."
Why: one server gives every harness byte-identical tool names, descriptions and schemas, and every framework in R5 consumes MCP natively, so the tool test can diff what each harness actually sends. Known costs, recorded on 3 Nov: Hermes prefixes names (`mcp__<server>__<tool>`), Tool Search must be off, results are wrapped as untrusted with no switch (D15), and a 3-error circuit breaker.
Still open: the transport. Stdio, spawned per trial inside the harness container, keeps all tool state in the trial folder (D3); one streamable-HTTP service needs per-trial state keyed by trial. The server supports both, so this can be settled in SP1 without code changes.
What would change it: a harness that cannot load an MCP server unmodified.

## Entry template

```markdown
### D<n>: <title> (<date>)
Options: ...
Choice: ...
Why: ...
What would change it: ...
```
