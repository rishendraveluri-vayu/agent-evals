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

## Open

| # | Call | Options | Lean | Needed by |
| --- | --- | --- | --- | --- |
| D1 | Where graders and stats live | Python or TypeScript | Python | Tue |
| D2 | Worker boundary | HTTP claim and report, or direct DB access | HTTP | Tue |
| D3 | Trial isolation | Container per trial, or process per trial | Container | Tue |
| D5 | Open-weight model | Hosted through OpenRouter, or local | Hosted, gpt-oss-120b if tool calling holds up | Wed |
| D7 | Tasks using the judge | Any share of the 20+ | About 6 to 8 | Thu |
| D8 | Judge threshold and what happens below it | Set before seeing results | Below threshold leaves the headline score | Thu |
| D9 | Experiment axis and N | Model, harness, memory or skills; N from the pilot | Memory empty vs seeded, if memory is the axis | Fri |
| D10 | Unit of analysis for the stats | Task, trial, or trials nested in tasks | Resample tasks, then trials within them | Thu |
| D12 | Trace format across harnesses | OpenTelemetry GenAI conventions, OpenInference, or an own schema | Research first, see R4 | Wed |
| D15 | Hermes settings that are design calls | Compression on or off; Tool Search off or on; in skills-on configs allow `skill_manage` writes or stage them; accept the untrusted MCP wrapper or not | None yet. Evidence in `docs/research/hermes/context_and_self_improvement.md` | Wed |
| D14 | How task tools reach every harness | One MCP server shared by all; a CLI driven through each harness's terminal tool; or native tool functions written per adapter | MCP if Hermes takes an MCP server unmodified, else CLI | Wed |

## Notes behind the open calls

**D1.** Python puts graders next to the sandbox and gives proven stats libraries. The risk is that Nest looks thin.

**D2.** HTTP lets Nest own the DB and keeps workers stateless. Direct DB access is simpler, but two languages then share one schema. Either way, Postgres can be the queue, with no Redis.

**D3.** A container per trial is properly isolated and harness-neutral, and startup is small next to LLM latency, but the worker needs the Docker socket. A process with a temp home is simpler, but an agent with a terminal tool can reach the worker's filesystem and possibly its keys. Hermes also puts the `HERMES_HOME` path in its system prompt, which favours a fixed path.
Evidence from the 3 Nov Hermes audit: several agents in one process are ruled out. The prompt also carries home, cwd, kernel and scratch paths, so concurrent trials only get identical prompts in containers. The local shell is unsandboxed and auto-approves dangerous commands headless. The key is readable inside a container too, so per-trial virtual keys are needed either way. Every research harness surveyed uses a container per trial. Comparison table: `docs/research/reports/Hermes architecture and traces.md`, section 6.

**D6.** Settled on 3 Nov, see the entry below.

**D11.** Settled on 3 Nov as both, see the entry below.

**D13.** Settled on 3 Nov, see the entry below. The three-tier rule for memory tasks still applies: fact only in memory, fact also discoverable with extra work, memory irrelevant. Otherwise the experiment is true by construction.

**D14.** Evidence from 3 Nov in `docs/research/hermes/custom_tools.md`: Hermes takes an MCP server unmodified. Costs: prefixed names, Tool Search must be turned off, results wrapped as untrusted with no switch, a 3-error circuit breaker, and discovery is the caller's job. A Hermes plugin is the alternative: bare names, no wrapper, duplicated schemas.

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

## Entry template

```markdown
### D<n>: <title> (<date>)
Options: ...
Choice: ...
Why: ...
What would change it: ...
```
