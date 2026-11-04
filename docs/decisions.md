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
| Tool delivery (was D14) | One MCP server for the finance tools, shared by every harness, started per trial over stdio | Rishi | 3 Nov |
| Trace format (was D12) | Own event schema with `gen_ai.*` names; model calls from LiteLLM's records, tool and agent events from adapters | Rishi | 3 Nov |
| D16 Retry layer | LiteLLM retries failed model calls with backoff; a trial that still fails is labelled infra and re-run by the runner, capped | Rishi | 3 Nov |
| D17 Step unit | One step is one model call | Rishi | 3 Nov |
| D18 Harness-side tool errors | Send them back to the model wherever the framework allows, never crash the run; record where it can't | Rishi | 3 Nov |
| D19 Parallel tool calls | A config setting, off by default | Rishi | 3 Nov |
| D20 Harness-added prompt text | Keep it and record it in the invariance diff; adapters never strip it | Rishi | 3 Nov |
| D21 Finance tool conventions | Accept the server's conventions (A5, A6) | Rishi | 3 Nov |
| D22 Simulated client | Supported per task; sees only visible replies and reveals hidden facts when asked; configurable model held identical across an experiment, temperature 0, own key, replies cached by exact conversation state; ends when done or at the turn cap; coexists with single-prompt tasks | Rishi | 3 Nov |
| D23 Contract choices | Memory, skills, compression as common settings; safety-net timeout at 1.5x plus 30 s; per-trial key as a named environment variable | Rishi | 3 Nov |
| D24 Effect checks | Each setting is checked once per harness and model on a cheap real model to prove it changes behaviour; inert settings are flagged | Rishi | 3 Nov |
| Headline experiment (was D9) | Prompt v1 vs v2: failures found on discovery tasks, v2 and the analysis plan committed, then measured on held-out tasks | Rishi | 3 Nov |
| D25 Unset settings | An unset sampling setting is not sent, so the harness or provider default applies, shown as a harness default; max output tokens defaults to 8,192, steps 15, timeout 300 s; a per-model table makes the API refuse at config time a setting the model rejects (temperature on Haiku 5.5) | Rishi | 4 Nov |
| D26 Provider-error labels | New `infra:config_error` for 401/403/404 and 400s about the request setup (auth, unknown model, rejected parameter): not re-queued, and the experiment pauses. 429/5xx stay `infra:provider_error`, re-queued once. Budget stops are not re-queued. A context-too-long 400 is the agent's outcome | Rishi | 4 Nov |
| D27 Simulator v2 | `client-sim.v2`: the simulator sees a short summary of the task's client file, never narrates or writes stage directions, and sends the end marker once its concern is answered (turn cap as backstop). It runs on Haiku 5.5 at the model's default temperature, the reply cache giving repeatability; this amends D22's temperature 0 | Rishi | 4 Nov |
| D28 Harness-added tool text | D20 also covers tool descriptions: ADK's untrusted-description wrappers, identity line and fencing preamble are kept as it ships and recorded; the tool-parity gate removes only that declared wrapper before comparing | Rishi | 4 Nov |
| D29 Malformed tool calls | Adapters follow D18 only through the framework's own documented opt-in switches (ADK's ReflectAndRetryModelPlugin, the Agents SDK's unknown-tool switch); no middleware of our own. LangGraph's malformed-only reply stays `agent_error`, the SDK keeps its default error text, and each difference is in `known_differences` | Rishi | 4 Nov |
| D30 Simulator v3 | `client-sim.v3`: the client summary adds the latest month's transactions, and a concrete end rule: once the advisor has directly answered the main concern, even with a hedge, the client may ask one follow-up and then ends. Hidden facts must agree with the task's client file | Rishi | 4 Nov |
| D31 Hermes prompt-cache markers | Off in every Hermes config, like every other harness ("whichever makes it stable") | Rishi | 4 Nov |
| D32 Stopping a run early | Trial order is shuffled from a recorded seed with the arms interleaved in time, so any early batch is a random sample. After a random first batch, an arm that passes nothing (or below a threshold set in the analysis plan beforehand) pauses the run for review: a futility check only, which cannot inflate false positives. Automatic pauses on infra-failure rate and spend projection. No early stop on an apparent win: the verdict uses the full pre-registered N. Manual pause, resume and stop | Rishi ("if first 3 fail all the time no point running 200... randomize... so we are not biased towards the first n") | 4 Nov |
| D33 Hermes's own guidance | Hermes's "Parallel tool calls" section follows our `parallel_tool_calls` setting, so the prompt never contradicts it; everything else stays as shipped (D20); a pre-run conflict check shows the rendered prompt and lists contradictions with ours | Rishi | 4 Nov |
| D34 Lineage | Configs and experiments can name a parent; the UI can fork a config; Compare can use the parent's trials as arm A, reused only when the invariance diff and task set match and they ran under the same platform commit, otherwise arm A is re-run alongside B | Rishi | 4 Nov |
| D35 Arms per experiment | Two arms, A vs B. Multi-arm questions run as several A/B experiments against the same parent | Rishi | 4 Nov |
| D36 Own loop on a cut-off reply | Re-send once with the cap doubled (up to 8,192), recording a `token_cap_raised` event and both calls; cut off again ends as `token_limit`. `max_output_tokens` means the first attempt's cap, as on Hermes | Rishi | 4 Nov |
| D37 Config error mid-run | Only the failing arm pauses; the other keeps running; the UI says which arm, why and how to fix it; resuming continues it; no verdict until both arms are complete. Amends D26 | Rishi | 4 Nov |
| D38 Prompt conflict checks | A standing $2 allowance for pre-run conflict checks on Claude Sonnet 5.5 (pinned, temperature not sent), each logged with its cost in `docs/cost.md`, with a note to Rishi at half. The UI shows it to the platform's user too: the Config screen shows each check's findings, its cost and the allowance used, and platform-made calls appear as their own line in the spend total, separate from trial spend. Anything else still needs a sign-off (R8) | Rishi ("we have to show this to the user somehow") | 4 Nov |
| D39 Hermes verification run | 30 trials first on Hermes with Haiku 5.5 (10 each: memory off, on and empty, on and seeded), about $0.60, cap $2, after the simulator empty-reply fix; the other 70 decided from what they show. Ran 4 Nov: 30 of 30 passed every check, $0.275; the other 70 not run yet | Rishi | 4 Nov |
| D40 Agent builder for reviewers | A guided "Build an agent" page (agent type with an explainer per harness, model, prompt, a few settings, then try it on the free fake model or evaluate it) and a short demo guide, on the existing API. No accounts, logins, per-account API keys or hosted demo: the brief does not ask for them (Rishi, asked whether to build a shared demo login on our keys: "They did not ask"). Reviewers run the platform locally; fake models need no key. Rishi: "They did not ask for a full login and all so we don't complicate it, maybe ask Friday evening if needed": revisit Friday evening | Rishi | 4 Nov |
| D10 Unit of analysis and the verdict | The task is the unit: per-task pass-rate difference B minus A, two-level bootstrap interval (tasks, then trials), sign-flip permutation test; the headline is the task pass rate (decision 2 of the stats proposal); a critical-failure guardrail and a regression list with severity and cause sit beside it | Rishi | 5 Nov |
| D41 Per-task flags: multiple-comparison correction | Benjamini-Hochberg at 5% false discovery rate marks a task's difference as beyond noise; every task where B dropped is listed either way | Rishi | 5 Nov |
| D42 Equivalence margin | +/- 10 points of pass rate: "practically equivalent" when the whole 95% interval of B minus A lies inside it | Rishi | 5 Nov |

## Open

| # | Call | Options | Lean | Needed by |
| --- | --- | --- | --- | --- |
| D7 | Tasks using the judge | Any share of the 20+ | About 6 to 8 | Thu |
| D8 | Judge threshold and what happens below it | Set before seeing results | Below threshold leaves the headline score | Thu |
| D15 | Hermes settings that are design calls | Compression on or off; Tool Search off or on (must be off for MCP tools, R10.7); in skills-on configs allow `skill_manage` writes or stage them; ~~accept the untrusted MCP wrapper or not~~ (settled by D20: accept) | None yet. Evidence in `docs/research/hermes/context_and_self_improvement.md` | Wed |

## Notes behind the open calls

**D1, D2, D3.** Settled on 3 Nov, see the entries below.

**D6.** Settled on 3 Nov, see the entry below.

**D11.** Settled on 3 Nov as both, see the entry below.

**D13.** Settled on 3 Nov, see the entry below. The three-tier rule for memory tasks still applies: fact only in memory, fact also discoverable with extra work, memory irrelevant. Otherwise the experiment is true by construction.

**D14.** Settled on 3 Nov as MCP, see the entry below. Evidence from 3 Nov in `docs/research/hermes/custom_tools.md`: Hermes takes an MCP server unmodified. Costs: prefixed names, Tool Search must be turned off, results wrapped as untrusted with no switch, a 3-error circuit breaker, and discovery is the caller's job. A Hermes plugin is the alternative: bare names, no wrapper, duplicated schemas.

Original note: Five harnesses must expose the same finance tools or a harness comparison measures the tool gap. One MCP server gives byte-identical tool schemas to every harness, and LangGraph, Google ADK and the OpenAI Agents SDK all consume MCP natively. It hinges on whether Hermes can load an MCP server from config without a source change. A CLI through the terminal tool is the fallback: parity is guaranteed but tool calls become shell strings, which weakens trace quality and failure analysis. Native functions per adapter are the most work and the easiest to drift.

**D12.** Settled on 3 Nov, see the entry below. Evidence from 3 Nov in `docs/research/trace-standards.md`: OpenTelemetry GenAI is all "Development" stability with memory and skill attributes in no release; OpenInference is stable but has no memory or skills. Options: pure OpenTelemetry GenAI, OpenInference plus Phoenix on our Postgres, or our own small schema on an OTLP-shaped envelope with `gen_ai.*` names. The brief says the evidence favours the third. Hermes needs a trace plugin under any option.

Original note: Four harnesses each emit traces differently. A shared trace schema is what lets one trial view and one failure analysis work for all of them. OpenTelemetry GenAI semantic conventions and OpenInference are the two candidate standards. Decide after the research in R4.

**D9.** Settled on 3 Nov as prompt v1 vs v2, see the entry below. Earlier note: memory on vs off isn't one axis: enabling it changes the tools and the prompt even with nothing stored. Memory on and empty vs on and seeded is cleaner.

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
- **R11 (3 Nov). Rishi's paper review of contract v1.** (a) Runs, results, spans and logs are stored and indexed in the database and shown in the UI; the trial folder is transport only. (b) Harness defaults must be shown. (c) Prompts are first-class, versioned config: "majority of agent changes would be prompt driven"; tool sets likewise. (d) Adding a harness or ADK must be low effort, not "a long coding effort". (e) Full logs, no 200-line tail: "we need full accountability and traceability". (f) Traces must be built and visualised quickly; spend must be easy to plot. (g) Closer to industry standard: traces as OpenTelemetry spans (D12 amended). (h) Settings must be shown to change behaviour, not just to arrive: "I have temperature but nothing changes when I move the value" (D24). (i) The simulated client is needed for real conversations, but the yes-man client is the problem; the adapter-driven conversation must be proven ("not sure this works"). (j) "We are being graded about the way we evaluate an agent. Main priority is always the eval", but the agent must be competent, not stupid; spend a little time making it feel good without overdoing it. The showcase: find missing tools, make a prompt change, improve the bot in the video.
- **R12 (3 Nov). Contract v2 approved as a starting point.** Rishi, without a full read: "we can go on with v2 ... its fine as a start even v1 was this is better so yeah we can build that contract and iterate tomorrow". So `docs/adapter-contract.md` is the contract to build against now, and changes from his read on 4 Nov are expected. Anything built on it that turns out wrong is reworked, not defended.
- **R13 (4 Nov). Finish the agents and a basic UI today; Thursday and Friday are for evals.** Rishi: "ui and the actual agents is something we finish off today ... so Thursday Friday is pure evals no more dev on the unimportant stuff which is mandatory but no one cares." The work is split. Rishi writes the evals (tasks, graders, rubric, experiment) from a thorough guide to how each harness package works and how our adapter drives it (`docs/harness-guide.md`, sent as a PDF). Claude gets every harness working through LiteLLM with a real model and a real simulated-client conversation, plus the UI. The UI should use the best design skills available and keep the viewer's cognitive load low while staying as easy as possible to build; polish waits until evals are up. Asked whether to cut the OpenAI Agents SDK (Claude recommended cutting it), Rishi chose to build it today, so R7's five harnesses stand. Real runs still need sign-off under R8.
- **R14 (4 Nov). SP2 data model approved as proposed.** Rishi approved `docs/proposals/data-model.md` without changes, including its four recommended choices: the config hash also covers the adapter's capabilities file; result and runner report as JSONB on the trial row, spans in their own table, everything else as files under `runs/`; labels stay files in `labels/`, imported read-only, with the labelling view writing the file through the API; grading is its own step after the trial, so a grader fix re-grades without re-running. Trials are claimed with `FOR UPDATE SKIP LOCKED`, heartbeat every 10 s, lapse after 60 s and are re-queued once.
- **R15 (4 Nov). Merge and push without a code review first.** Asked how to handle R7's "Rishi reviews each adapter before merge" for branch `sp1-harnesses` (three adapters, the API, the worker engine and images), Rishi chose to merge to main and push now and review later from the harness guide and the code. Claude recommended an independent code review first; that review is still owed.
- **R16 (4 Nov evening). Platform feature freeze after the in-flight work.** Claude's assessment: the platform is ahead, the evals (tasks, graders, judge, labels, stats, pilot, experiment) are behind, and the brief rewards evaluation design over feature count. Agreed by Rishi ("Okay"): once the work already started lands (run controls and lineage, the conflict check, the harness-side changes, the UI polish), no new platform features unless an eval needs one. From Thursday morning Rishi's time goes to the tasks and the judge rubric; Claude builds the graders, judge runner, labelling flow and stats around his design. Pilot Thursday evening; labels and the experiment Friday; write-up and video Saturday.
- **D5 settled (4 Nov evening). Open-weight model: a local demo only.** Rishi chose a small pinned model run locally (6 CPU cores, 46 GB RAM, no GPU: a few minutes per trial), registered as one more LiteLLM entry and run for 3 trials on the own loop, to show that a new model is one config line at no API cost. Not an experiment arm; Claude Haiku 5.5 and Gemini 3.8 Flash cover the brief's two-provider requirement. Installing it is asked first.

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

### D12: Trace format across harnesses (3 Nov)
Options: OpenTelemetry GenAI conventions; OpenInference with Phoenix; our own small schema with `gen_ai.*` names.
Choice: our own schema. `trace.jsonl` has one event per line (model call, tool call, tool result, error, memory read, skill load, final answer). Model-call events come from LiteLLM's records for the trial key, the same for every harness; tool and agent events come from each adapter's hooks.
Why: OpenTelemetry GenAI is all at Development stability and, like OpenInference, has no memory or skills concepts, which the memory experiment needs; both add a service. Recording model calls at the proxy fits R10.9 and covers harnesses that expose no raw requests (the Claude Agent SDK). The `gen_ai.*` names keep an OpenTelemetry export possible later.
What would change it: a reviewer requirement for OTLP traces, which an exporter could meet.

### D14 transport (3 Nov)
Choice: the finance MCP server is started per trial over stdio inside the harness container. It dies with the trial's process group, and its state lives in the wiped trial folder (D3). Adapters set MCP tool timeouts explicitly, because ADK and the Agents SDK default to 5 s.
Rejected: one shared HTTP service, because concurrent trials would share a server and state would need keying by trial (pre-mortem break 8).

### D16: Retry layer (3 Nov)
Options: LiteLLM per-call retries plus trial re-queue; LiteLLM only; trial re-runs only.
Choice: LiteLLM retries a failed model call (429, 500, timeout) a few times with backoff, logged per trial key; harness retries are off (R10.11). A trial that still fails is labelled infra and re-run from scratch by the runner a capped number of times; failed attempts are reported and never counted in quality.
Why: one retry layer inside a trial, identical for every harness and visible at the proxy; trial re-runs recover what still dies without paying again for every rate-limit blip.
Done (4 Nov): `services/litellm/config.yaml` sets `num_retries: 3`, a `retry_policy` of 3 for rate limits and timeouts and 0 for 400, 401 and content-policy errors, a 1 s backoff floor under LiteLLM's exponential backoff (Retry-After honoured), and a 180 s per-call `timeout` and `stream_timeout`. Tested against a throwaway LiteLLM of the pinned image and the fake: 429, 500, 502, 503 and timeouts got 4 attempts at most; 400, 401, 403 and 404 got 1. LiteLLM keeps a retried call as one spend-log row and puts its retries in `metadata.attempted_retries`, so `proxy_usage` now counts `attempts` and `retried_calls` beside `model_calls` (the harness's requests), and each `chat` span carries `evals.proxy.attempts`. A call that still fails after the retries is labelled `infra:provider_error` (429, 5xx, and now LiteLLM's 408 timeout). The proxy gate tests check 1 harness request against LiteLLM's attempts, and `scripts/check_litellm_config.py` requires bounded retries, a backoff floor, no retries on 4xx other than 429, and a bounded timeout.

### D17: Step unit (3 Nov)
Choice: one step is one model call. Adapters map it to `max_llm_calls` (ADK), `max_turns` (Agents SDK, Claude SDK), `max_iterations` (Hermes) and LangGraph's model-call limit in error mode. The proxy's call count per key checks it. Hermes's extra summary call at its limit is recorded, not hidden. Tool calls are counted in the trace but not limited.

### D18: Harness-side tool errors (3 Nov)
Choice: when the model sends broken tool arguments or calls an unknown tool, adapters use each framework's option to return the error to the model so it can recover, and never crash the run. Where a framework cannot (ADK ends the run on a malformed call), its behaviour is kept and recorded as a known harness difference. Adapters detect and label every case (R10.2), including LangGraph's apparent success with an empty answer.

### D19: Parallel tool calls (3 Nov)
Choice: `parallel_tool_calls` is a config setting, off by default, so every harness runs one tool call per model turn unless a config says otherwise. To check on the first real run: that Gemini accepts the setting through LiteLLM.

### D20: Harness-added prompt text (3 Nov)
Choice: keep what harnesses add (ADK's identity line and untrusted markers on tool descriptions, Hermes's untrusted wrapper on tool results) and record it in the invariance diff. Adapters never strip it.
Why: R10.10 forbids adapter prompt edits, and stripping would be uneven because Hermes's wrapper has no switch. Settles D15's wrapper question as accept.

### D21: Finance tool conventions (3 Nov)
Choice: accept the finance server's conventions: amortisation schedules paged at 60 rows, loans close at exactly ₹0.00 with the last EMI absorbing rounding, unschedulable loans rejected, snowball by starting balance, part-year FD simple interest, whole-year inflation, paise rounding, debit or credit transactions. Recorded as A5 and A6 and in `known-limits.md`.

### D22: Simulated client (3 Nov)
Options offered: one prompt with no simulated user (Claude's recommendation); a simulated client; scripted follow-ups. Rishi chose the simulated client.
Choices, one question at a time: the client sees only the agent's visible replies and reveals hidden facts only when asked. The client model is configurable but identical across every config in an experiment (Rishi: "Make it configurable, but does the harness change based on that is the real question, we use one set of responses to re run right"), at temperature 0 with a versioned prompt and its own key. Replies are cached by task, simulator config and exact visible transcript, so identical conversation states get identical replies across harnesses and re-runs. The conversation ends when the client is done or at `max_client_turns` (default 3). Simulated and single-prompt tasks coexist.
Why: realistic advisor conversations, where the agent has to draw facts out, without letting the client become a source of noise or a confound. The agent's calls are never cached, so trials stay independent samples.
Cost: a second model in every simulated trial, and every adapter needs a conversation loop. Build order moves the extra harnesses' start a few hours later; the Thursday 12:00 deadline is unchanged.
What would change it: the simulator proving unstable at temperature 0, or the cost or variance swamping the experiment, in which case D9 can keep the experiment to single-prompt tasks.

### D23: Adapter contract choices (3 Nov)
Choices: memory, skills and compression are common config settings, with harness-specific detail in per-harness options; the runner's safety-net timeout fires at `timeout_s × 1.5 + 30 s`; the per-trial key travels as an environment variable named in the spec (Rishi chose this over Claude's recommendation of the spec file). Recorded in `docs/adapter-contract.md`.

### D9: Headline experiment (3 Nov)
Options: prompt v1 vs v2 with a discovery and held-out split; memory empty vs seeded (the earlier lean) with the find-and-fix loop shown as a demo; both.
Choice: prompt v1 vs v2. v1 runs on discovery tasks; trace analysis finds the failures (for example arithmetic without a tool, missed empathy); v2 and the analysis plan are committed before the re-run; v1 and v2 are compared on held-out tasks not used to find the problems. A missing tool found on the way is shown as a finding and added in the next iteration, so the experiment changes one thing.
Why: Rishi's showcase ("find missing tools, make prompt change, improve the bot in the video"), the most common real agent change, and the held-out split answers the "true by construction" criticism the pre-mortem raised against the memory design.
Still open, for the analysis plan in `docs/experiment.md`: the harness and model (default Hermes and one model), N, the split sizes, D10 (unit of analysis) and D8 (judge threshold).

### D12 amendment: OpenTelemetry spans (3 Nov)
Rishi: "Need to scale the code much closer to industry standard." Traces become OpenTelemetry spans in OTLP JSON: one trace per trial, spans for the agent run, each turn, each model call (from LiteLLM) and each tool call, with memory, skill and error events as span events using our own `evals.*` attributes. Standard tools can read them; our UI renders them.

### D24: Effect checks (3 Nov)
Choice: once per harness and model at gate time, on Haiku 5.5 and a Gemini Flash, each run signed off with an estimate (R8): temperature changes output variety, a small token cap truncates, parallel tool calls arrive together when on, seeded memory is used when on. A setting that arrives but changes nothing is recorded as inert for that harness and model.
Why: Rishi: "I have temperature but nothing changes when I move the value." The gate tests only prove a setting reaches the request.

### D10: Unit of analysis, primary metric and regressions (5 Nov)
Options: the task as the unit (two-level bootstrap and a sign-flip test, proposed in `docs/proposals/stats.md`); a mixed-effects logistic model; the trial as the unit (not recommended). For severity: a critical-failure guardrail on the verdict; a severity-weighted score as the metric; or severity reported only, with no gate.
Choice: the task as the unit, as proposed. The headline is the task pass rate (every required grader passes; a trial with no outcome is counted apart, never as a pass or a fail). Each grader gets a severity (critical, major or minor) in its task file, set by Rishi; B can only be called better when its critical failures did not rise beyond noise, with their paired interval shown beside the verdict. Where B regressed, a list shows which checks flipped from pass to fail, critical ones first, and each failed trial's cause (the brief's stretch item 7: wrong tool, made-up tool arguments, gave up early, ran out of steps, grader disagrees with the human label).
Why: Rishi: "While the logic is sound, we may need to have more details, some failures are more catastrophic than others so an overall pass rate works, but also where b regressed needs a further look as to what kind of regression that is." He chose the critical guardrail over a weighted score or report-only.
What would change it: severities that cannot be agreed per grader; too few critical checks for their interval to say anything (then report them without the gate, and say so).
Still open from the stats proposal: the per-task correction (Holm or BH), an equivalence margin, alpha.

### D41: Which correction flags a task as beyond noise (5 Nov)
Options: Holm (family-wise error: at most a 5% chance that any flag is false); Benjamini-Hochberg (false discovery rate: about 5% of flagged tasks may be noise); both as two levels ("worth a look" and "confirmed"); no correction (about one false flag in 20 tasks even when nothing changed).
Choice: Benjamini-Hochberg at q = 0.05 over the per-task tests of one experiment. It decides only the per-task flag. The overall verdict is one test and needs no correction; the critical-failure guardrail (D10) is one pooled test and needs none either.
Why: Rishi: "BH is fine but we need to prepare for the decision taken and trade offs." D10 asks that every regression of B gets a closer look, so a flag means "look here", whose cost when wrong is a wasted read, not a false claim. At our sizes Holm cannot flag anything useful: with 20 tasks its first bar is 0.05 / 20 = 0.0025, and with N = 5 trials per arm the most extreme task (5 of 5 against 0 of 5) has p = 0.008 by Fisher's exact test, so no task can ever be flagged; at N = 10 only near-total flips are (10 of 10 against 2 of 10, p = 0.0007), while 8 of 10 against 2 of 10 (p = 0.023) is not.
What would change it: a write-up that must quote individual tasks as findings (then Holm, or report the BH flags as leads only); many more trials per task.

**The trade-off, to explain it.**
- What BH controls: among the tasks it flags, the expected share that are really unchanged is at most 5%. With 10 flags, expect about half a false one.
- What it does not control: the chance of at least one false flag. When nothing changed at all, BH and Holm behave alike (both at most 5% chance of any flag); when several tasks really changed, BH lets the bar rise with the rank (the k-th smallest p-value is compared with k x 0.05 / 20), so it flags more, and some of those can be noise.
- Why not Holm: it guards against even one false flag, which suits claims, not a list of places to look; at N = 5 to 10 trials per task it would leave the flag column empty or nearly so, and an always-empty column tells a reviewer nothing.
- Why not no correction: with 20 tasks about one looks different by chance in every experiment, which is what the brief means by "make it clear when a difference is just noise".
- What protects us from BH's looser flags: every task where B dropped is shown with its counts and its interval whether flagged or not; a flag is a pointer, not a verdict; the verdict and the critical guardrail are separate tests; and the A/A calibration run shows how many tasks BH flags when nothing changed.
- Assumptions under it: BH holds for independent tests or positively dependent ones (tasks sharing a harness and model tend to move together, which is positive dependence); per-task p-values come from that task's trials only, so a task with few trials can never reach a small p-value, and the write-up says how many trials each task had.

### D42: An equivalence margin of +/- 10 points (5 Nov)
Options: +/- 10 points; +/- 5 points; no margin (three outcomes only).
Choice: +/- 10 points of task pass rate. The verdict has four outcomes: better, worse, practically equivalent (the whole 95% interval of B minus A inside +/- 10 points), or no detectable difference (with the smallest difference that could exist undetected). Fixed in the analysis plan before the run.
Why: Rishi picked it from the three. Without a margin the platform cannot tell "the same" from "too few trials to tell"; +/- 5 would rarely be reachable at our sizes (an unmeasured estimate of +/- 10 to 15 points interval width at about 20 tasks and 10 trials each).
What would change it: the pilot's measured interval width; a domain reason to call a smaller change material (a money-advice task where 5 points matters).
To explain it: equivalence is a claim about the whole interval, not the point estimate: B at -2 points with an interval of -14 to +10 is "no detectable difference", not "equivalent", because a 14-point drop is still possible.

## Entry template

```markdown
### D<n>: <title> (<date>)
Options: ...
Choice: ...
Why: ...
What would change it: ...
```
