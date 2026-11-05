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
| Graders and stats (was D1) | Python for the graders and the judge-agreement maths (`stats/`); the comparison statistics in the API, in TypeScript (amended 5 Nov) | Rishi | 3 Nov, amended 5 Nov |
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
| D39 Hermes verification run | 30 trials first on Hermes with Haiku 5.5 (10 each: memory off, on and empty, on and seeded), about $0.60, cap $2, after the simulator empty-reply fix; the other 70 decided from what they show. Ran 4 Nov: 30 of 30 passed every check, $0.275; the other 70 deferred on 5 Nov to after the experiment, if time and budget remain (memory is off in the experiment, D15) | Rishi | 4 Nov |
| D40 Agent builder for reviewers | A guided "Build an agent" page (agent type with an explainer per harness, model, prompt, a few settings, then try it on the free fake model or evaluate it) and a short demo guide, on the existing API. No accounts, logins, per-account API keys or hosted demo: the brief does not ask for them (Rishi, asked whether to build a shared demo login on our keys: "They did not ask"). Reviewers run the platform locally; fake models need no key. Rishi: "They did not ask for a full login and all so we don't complicate it, maybe ask Friday evening if needed": revisit Friday evening | Rishi | 4 Nov |
| D10 Unit of analysis and the verdict | The task is the unit: per-task pass-rate difference B minus A, a bootstrap interval resampling tasks only (revised 5 Nov from two levels), sign-flip permutation test; the headline is the task pass rate (decision 2 of the stats proposal); a critical-failure guardrail and a regression list with severity and cause sit beside it | Rishi | 5 Nov |
| D41 Per-task flags: multiple-comparison correction | Benjamini-Hochberg at 5% false discovery rate marks a task's difference as beyond noise; every task where B dropped is listed either way | Rishi | 5 Nov |
| D42 Equivalence margin | +/- 10 points of pass rate: "practically equivalent" when the whole 95% interval of B minus A lies inside it | Rishi | 5 Nov |
| D43 Significance level | Alpha 0.05 and 95% intervals throughout (verdict, critical guardrail, equivalence, BH q = 0.05) | Rishi | 5 Nov |
| D44 A/A calibration | An explicit calibration run: the same config on both arms only when the run is marked "A/A calibration"; the comparison of an A/B shows the latest A/A interval for its configs; each one is a paid run signed off like any other | Rishi | 5 Nov |
| D8 Judge trust bar | A judge criterion counts in the headline only when, on the held-out labels, kappa >= 0.6 with its 95% interval's lower end >= 0.4, no false-pass gap between arms, and test-retest agreement >= 90%; below it, it stays visible in trials and the report | Rishi | 5 Nov |
| D45 Judge model | Gemini 3.8 Flash, pinned for the experiment (billing enabled 5 Nov and checked with one call) | Rishi | 5 Nov |
| D46 "Not sure" labels | A second look: each "not sure" criterion comes back once, after the fresh items; still "not sure" then means excluded from the judge's agreement, with the count reported | Rishi | 5 Nov |
| D47 Headline experiment's harness and model | Hermes Agent (pinned 6112c2a) on Claude Haiku 5.5, the same for both arms of prompt v1 vs v2 | Rishi | 5 Nov |
| D48 Label budget | 20 tuning, 40 held-out, 20 from the final run, as planned in SPEC (about an hour of Rishi's labelling) | Rishi | 5 Nov |
| D49 Judge-error correction | Pooled sensitivity and specificity from the held-out labels (Rogan-Gladen), since D8 already drops criteria with a false-pass gap between arms; the comparison shows both "as judged" and "corrected" | Rishi | 5 Nov |
| D15 Hermes settings for the headline experiment | Compression, memory and skills off in both arms; prompt-cache markers off (D31); Tool Search off (R10.7) | Rishi | 5 Nov |
| D50 Minimum tasks for a verdict | 6 tasks in the aggregate; below it the verdict is "no detectable difference" with "too few tasks for any verdict" | Rishi | 5 Nov |
| D51 Fake models for reviewers | Kept as a test tool on the full Config screen, clearly labelled; they replay one script whatever the task, so their trials fail and show no A/B difference. Reviewers see real results in the shipped example and run agents with their own key | Rishi | 5 Nov |
| D52 Label sets and the task split | Tuning labels come from discovery-task trials only; held-out and final labels from held-out-task trials only; the queue and POST /labels enforce it | Rishi | 5 Nov |
| D53 The task set | The 21 tasks of docs/proposals/tasks-review.md (15 from 4 Nov, 6 new), split A: 11 discovery, 10 held-out; severities as proposed; the proposed grader fixes applied | Rishi | 5 Nov |
| D54 Arithmetic tools; provenance stays required | Add basic arithmetic tools (add, subtract, multiply, divide, percentages, rounding) to the finance toolset for both arms; the agent never does its own arithmetic; provenance stays required at 0 unsupported; prompt v1 unchanged | Rishi | 5 Nov |
| D55 No "equivalent" from a zero-width interval | When every task gives the same difference, the verdict is never "practically equivalent" | Rishi | 5 Nov |
| D56 Provenance traces arithmetic inputs | An arithmetic tool's result counts as supported only when its inputs are themselves supported | Rishi | 5 Nov |
| D57 Arithmetic tool descriptions | Plain: each says what it returns, not "use this instead of calculating yourself", so the prompt stays the only lever (as D54) | Rishi | 5 Nov |
| D58 Unit facts and reference rates | Unit facts count as arithmetic inputs without a source (12, 100, 365, 366, 28 to 31, 52, 7, 1 lakh, 1 crore; never 0 or 1); an arithmetic result equal to one of its own unsupported inputs never counts; market rates come from a new `reference_rates` finance tool with sources and dates (values approved by Rishi before any run) | Rishi | 5 Nov |
| D59 Futility check on fake-only runs | Off by default when every model in the run is fake; on by default for any paid run | Rishi | 5 Nov |
| D60 Bind-mount permissions | The API starts as root only to create and own its writable folders, then drops privileges; the health check and smoke test fail loudly when they are not writable | Rishi | 5 Nov |
| D61 Provenance: verify, don't trace | A rupee figure counts when it matches a source within tolerance, or is a correct one-step derivation the checker recomputes from sourced numbers (small counts, periods, rates and unit facts need no source, but at least one operand must be a sourced value); "figures written without a tool" is reported per arm as its own measure. Supersedes D56's strict input tracing | Rishi | 5 Nov |
| D62 Reference rates | Approved: FD 1-year 6.25% (SBI), savings 2.50% (SBI), PPF 7.10% (MoF via Indian Bank), CPI 5.54% (MOSPI, Sept 2026), RBI repo 5.50%, equity long-run 12.15% (Nifty 50 TRI since inception); debt_fund dropped (an index, not what an investor earns after costs) | Rishi | 5 Nov |
| D63 Choosing a grader | Computable answer or a trace event: deterministic; wording: a unit_test if bounded, else the judge, a bare regex last; meaning: the judge, yes/no with quotes, counted only once trusted; critical checks deterministic unless a judge criterion is trusted (`docs/proposals/grader-format.md`) | Rishi | 5 Nov |
| D64 A-vs-B behaviour and failure causes | The comparison shows per arm: tool calls by tool, required tools called, tool errors, steps and step-limit hits, end states, figures written without a tool; and every failed trial gets a rule-based cause (wrong tool, made-up arguments, gave up early, ran out of steps, unsupported figure, grader vs human label); the regression list shows which causes grew | Rishi | 5 Nov |
| D65 Freeze the agent, tasks and graders | The fixes in flight on 5 Nov (provenance D61 with the approved rates D62, the three D63 task fixes) are the last; after them the agent, tasks, graders and toolset are taken as they are into the experiment loop. Work goes to comparing runs: the experiment, the judge's validation, A/A calibration and the comparison itself (including D64) | Rishi | 5 Nov |
| D66 Standing spend allowance (R8) | For 2 hours from 11:50 to 13:50 IST on 5 Nov: any single spend under $2 may go ahead without asking, as long as the total stays under $50; each is logged in `docs/cost.md`; a single step above $2 (the final run) still needs Rishi's go-ahead, and no step is split to fit under $2 | Rishi | 5 Nov |
| D67 Prompt v2 | v1 plus the fixes from the discovery traces and Rishi's tuning labels: every rupee figure exactly from a tool (small sums included, no "about" amounts); clarify an ambiguous amount or a missing deciding fact before planning on it (or say which reading was used); explain each key figure in plain words (`configs/prompts/finance-advisor.v2.md`) | Rishi | 5 Nov |
| D68 Judge rubric v1 and criteria for v2's fixes | The judge reads `configs/rubrics/advice.v1.md` (the client's advocate and a finance planner, a quote for every yes, each criterion on its own); new criteria so the comparison can see v2's fixes: clarifies an ambiguous amount, asks for the deciding fact, explains each key figure plainly; optional until each passes the trust bar on held-out labels (D8) | Rishi | 5 Nov |
| D69 Rubric stays v1 after the tuning check | The overall criterion is lenient on the tuning labels (kappa 0.30, specificity 0.20) while the specific criteria caught the same problems; rubric v1 stays as committed in the plan, and the specific criteria carry the judgment; overall is expected to stay reported-only unless it passes the trust bar on held-out labels | Rishi | 5 Nov |
| D70 Positive control | A known-effect run to validate the platform: v1 = the finance toolset with all eight calculators removed (calculate_emi, amortization_schedule, debt_payoff_plan, prepayment_impact, fd_maturity, sip_future_value, inflation_adjusted_value, loan_affordability; data and arithmetic tools kept), v2 = the full toolset; same agent and prompt v1; all 21 tasks x 5 x 2; pass criteria fixed before the run | Rishi | 5 Nov |

## Open

| # | Call | Options | Lean | Needed by |
| --- | --- | --- | --- | --- |
| D7 | Tasks using the judge | Any share of the 20+ | About 6 to 8 | Thu |

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
Settled after it: the per-task correction (D41), the equivalence margin (D42) and alpha (D43).

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

### D44: A/A calibration as an explicit run (5 Nov)
Options: an explicit calibration run (the same config on both arms, allowed only when marked); split-half of arm A's own trials (free, but measures noise at N/2 and misses side-by-side effects such as claim order); simulated A/A only (the stats tests).
Choice: the explicit calibration run. Without the mark, the same config on both arms stays refused (A30), so an accidental A/A cannot happen. The comparison of an A/B shows the latest A/A interval for its configs beside its own. The simulated A/A tests stay as well.
Why: Rishi picked it. The stats design (proposal section 5) calls for an A/A run every time, and the statistics have to be checked on this setup, not assumed: only a real A/A shows the noise of this setup, harness and model.
What would change it: cost (each A/A is a full run, about $1 to $2 on Haiku at 20 tasks x 10 trials, a rough estimate, needing a sign-off under R8).

### D8: The judge's trust bar (5 Nov)
Options: kappa >= 0.6, lower bound >= 0.4, retest >= 90%; kappa >= 0.7, lower >= 0.5, retest >= 95%; kappa >= 0.4, lower >= 0.2, retest >= 85%. In each, the false-pass rate must not differ between arms.
Choice: kappa at least 0.6 and its 95% interval's lower end at least 0.4, on the held-out set; the false-pass gap between arms has an interval that includes 0; test-retest agreement at least 90%. A criterion below the bar is "not trusted": it stays in the trial view and the report with its numbers, and leaves the headline pass. Fixed in `docs/experiment.md` before the pilot; never moved after seeing held-out results.
Why: Rishi picked it. 0.6 is "substantial" agreement on the usual scale; with about 40 held-out labels the kappa interval is about +/- 0.2 wide, so the lower-bound rule asks for a point estimate near 0.6 and the stricter bar would fail good judges on label count alone.
What would change it: more held-out labels (a tighter interval would allow a stricter bar); kappa misleading on a criterion whose answer is almost always yes (then report raw agreement, sensitivity and specificity beside it, as section 3 of the proposal already does).

### D45: The judge model is Gemini 3.8 Flash (5 Nov)
Options: Claude Sonnet 5.5 (proposed); Claude Opus 5.5; Gemini 3.8 Flash.
Choice: Gemini 3.8 Flash, pinned for the whole experiment. Every judging run still needs Rishi's approval with a model and a budget (`POST /experiments/:id/judge`).
Why: Rishi picked it. It is the cheapest ($0.75 / $3.75 per MTok, listed to rise to $1.50 / $7.50 from 1 Jan 2027) and from a different family than the Claude agents, so a judge preferring its own family's writing cannot tilt a comparison of Claude configs.
Unblocked 5 Nov: Rishi enabled billing; one check call answered in 2.4 s for $0.000235 (`docs/cost.md`). Before that, the Gemini key's project was not on a paid tier. On 4 Nov every Gemini call failed with 503 "high demand", then 429 "You exceeded your current quota, please check your plan and billing details" (`docs/cost.md`). The judge cannot run until billing is on. One call also took 3 minutes before a 503, against the judge's 300 s timeout (A22).
What would change it: Gemini still failing or too slow with billing on (then Sonnet 5.5, the proposal's choice); the judge missing the trust bar (D8) where a stronger judge would pass.
Not yet run: the judge has never met a real model; its JSON answer format, the 8,000-token cap and the quote check are tested against a stub and the fake server only (`docs/known-limits.md`).

### D46: "Not sure" labels get a second look (5 Nov)
Options: excluded from the agreement (proposed); counted as "no"; a second look.
Choice: a second look. A criterion Rishi marks "not sure" comes back once in the same set, after every fresh item, marked "Second look". The answer then given replaces the "not sure" in the judge's agreement and is not counted as a relabel (it is not a self-consistency test). A second "not sure" is final: it is left out of the agreement (`--human-unsure exclude`) and counted per criterion. A criterion with many "not sure" labels points at an unclear rubric.
Why: Rishi picked it: the best data for the judge check, at the cost of some extra labelling time.
What would change it: labelling time running out before Friday (then exclude what is left, which is the same rule applied early).

### D47: The headline experiment runs on Hermes with Claude Haiku 5.5 (5 Nov)
Options: Hermes on Claude Haiku 5.5; Hermes on Gemini 3.8 Flash; the own loop on Claude Haiku 5.5.
Choice: Hermes Agent at the pinned SHA 6112c2a on Claude Haiku 5.5, for both arms of prompt v1 vs v2.
Why: Rishi picked it. Hermes is the brief's required harness and passed every D39 check on Haiku 5.5; Haiku is cheap (measured $0.0024 to $0.014 a trial on 4 Nov) and is not the judge's family (D45, Gemini), so the judge does not grade its own model family's answers.
What would change it: Hermes failing on the final tasks in a way the platform cannot label as infra; Anthropic rate limits at the planned N.
Rough cost, an estimate before the pilot: 20 tasks x 10 trials x 2 arms on Haiku 5.5 is about $2 to $5, plus the simulated client and the judge.

### D15: Hermes settings in the headline experiment (5 Nov)
Options: all off (compression, memory, skills); Hermes's defaults (compression on, memory and skills off); memory and skills on.
Choice: compression, memory and skills off in both arms of prompt v1 vs v2, with prompt-cache markers off (D31) and Tool Search off (R10.7). `skill_manage` does not arise with skills off.
Why: Rishi picked it. The prompt stays the only difference, and no hidden extra model call (compression rewrites the history through an auxiliary call) can change one arm's trajectories or cost; D39 found Hermes never writes memory within one session, so memory would add schema and prompt text without testing what it is for.
What would change it: tasks long enough that an uncompressed conversation hits the model's context limit (none of ours is near it).

### D10 revision: resample tasks only (5 Nov)
Options: the two-level bootstrap as first settled (tasks, then trials within each task); tasks only (the standard cluster bootstrap); tasks only with a small-sample interval correction.
Choice: tasks only. Each task's observed pass rate already carries the noise of its trials, so resampling the trials again counts that noise twice and widens the interval.
Evidence (SP6's simulation, 1,000 simulated experiments per row, task pass rates uniform 10 to 75%, verdict = interval clear of 0 and sign-flip p < 0.05): at 20 tasks x 10 trials, two levels gave 1.5% false "better" or "worse" when nothing changed, 98.5 to 99% coverage, 69% power for a real +15 points and a 24.3-point mean width; tasks only gave 4.7%, 91.6 to 93.7% coverage, 85% power and 17.2 points. At 40 tasks, tasks only covers 95.1%. Reference: Davison and Hinkley (1997), Bootstrap Methods and their Application, section 3.8.
Why: Rishi picked it: false alarms near the promised 5% and much more power; the slight under-coverage of the percentile interval at about 20 tasks is a known small-sample effect, recorded in `docs/known-limits.md`, and the verdict also needs the permutation test.
What would change it: very few held-out tasks (the headline compares on held-out tasks only), where a small-sample interval correction would be worth its extra explanation.

### D50: At least 6 tasks for any verdict (5 Nov)
Options: a floor of 6 tasks; a floor of 8; no floor.
Choice: 6. Below 6 tasks in the aggregate the verdict is "no detectable difference", with a sentence that there are too few tasks for any verdict. Better or worse cannot happen below 6 anyway: the sign-flip test's smallest two-sided p-value is 2 / 2^K, which is above 0.05 at K = 5.
Why: Rishi picked it. "Practically equivalent" (D42) has no permutation test behind it, and the percentile interval under-covers with few tasks. SP6's simulation (tasks-only bootstrap, N = 10, 1,000 runs per row) called a real +15-point effect "equivalent" in 3.9% of runs at K = 4, 1.4% at K = 6, 1.1% at K = 8, 0.6% at K = 10 and 12, 0% at K = 20; a 95% interval should allow at most 2.5%.
Also measured, power to call a real +15 "better": 0% at K = 4, 10.5% at 6, 30.4% at 8, 49.9% at 10, 54.7% at 12, 85.4% at 20. The headline compares on held-out tasks only, so the split decides this.

### D52: The label sets follow the task split (5 Nov)
Options: follow the task split; disjoint tasks assigned at random to sets; keep the sets disjoint by trial only.
Choice: the tuning set takes trials of discovery tasks only; the held-out and final sets take trials of held-out tasks only. The label queue offers only those, and `POST /labels` refuses a label in the wrong set (400 `wrong_split`).
Why: Rishi picked it. Disjoint by trial alone let one task appear in both tuning and held-out, so the judge could be tuned on a task's outputs and scored on more of the same task's, which flatters its agreement. Following the split also matches the experiment: the v2 prompt and the rubric are both shaped on discovery tasks, and both are measured on held-out ones.
What would change it: too few held-out-task trials for 40 held-out labels before the final run (then label held-out tasks from a v1 run on them, still never a discovery task).

### D53: The task set, its split and severities (5 Nov)
Options: approve the six new tasks or drop some; split A (11 discovery, 10 held-out), B (9 / 12) or C (A without convo-where-to-start); severities as proposed or set by hand; the smaller grader fixes all, only the false fails, or none.
Choice: all 21 tasks; split A, with held-out = the six new tasks, loan-to-clear-card and convo-consolidation, sip-education-goal and otp-scam; severities as proposed in `docs/proposals/tasks-review.md` section 3 (20 critical, 63 major, 1 minor of the 84 required deterministic graders); all proposed grader fixes (the months regexes become `number` checks, names-a-risk becomes a judge criterion, convo-payoff's hidden fact says "in total, minimums included" as a new task version, convo-where-to-start gets its own concern). *(Later counts: since D63 the task files hold 20 critical, 59 major and 1 minor of 80 required checks; the 63 of 84 here were task version 2's.)*
Why: Rishi picked them. K = 10 held-out tasks lets the sign-flip test reach p = 0.002 and survive one reversal; the never-run tasks are the cleanest held-out set; near-duplicate scenarios stay on one side. Power for a real +15 points is about 50% at K = 10 (D50's table): the write-up says so.
Recorded in `docs/experiment.md`: the four held-out tasks from 4 Nov (the consolidation pair, sip, otp) had their v1 outputs read before v2 was written; v2 is written from discovery traces only.

### D54: Arithmetic tools, and provenance stays required (5 Nov)
Options: make provenance optional and report it beside the pass rate; keep it required at 0; allow 1 or 2 unsupported amounts.
Choice: keep it required at 0, and add basic arithmetic tools to the finance toolset (add, subtract, multiply, divide, percentages, rounding), so every figure in an answer can come from a tool and the model never does its own arithmetic. Both arms of the experiment get the new toolset. Prompt v1 stays as it is: it already forbids prose arithmetic and will see the new tools in its tool list.
Why: Rishi: "addition if done wrong fails so keep it required add basic math tools like add / subtract/ multiply / divide and other basics and never allow llm to do its own calculation, we may highlight this in the video. the failure trace". On 4 Nov provenance failed 18 of 24 Hermes trials, almost all on sums written in prose (Rs 23,120 = Rs 14,120 + Rs 9,000): a missing tool, found by trace analysis. The video shows that failure trace, the tools added, then v1 vs v2 measured on held-out tasks; if v1 still does sums in prose with the tools available, v2 can tell it to use them, and the prompt stays the only difference.

### D1 amendment: where the statistics run (5 Nov)
The comparison statistics (SP6) were built in TypeScript in the API, against D1 as written ("graders and stats: Python"); Claude chose it from the brief's "TypeScript for the API" and did not flag the conflict with D1 before building. Rishi kept it: the statistics run where the comparison is served, tested against published values (cross-checked with SciPy and statsmodels). The graders and the judge-agreement maths (`stats/`, `evals-agreement`) stay Python.

### D55: No "practically equivalent" from a zero-width interval (5 Nov)
Options: a guard; no guard (documented only).
Choice: the guard. When every task gives the same difference, the task bootstrap's interval has no width; that shows no spread, not a small one (a task at 10 of 10 against 10 of 10 is still consistent with a gap of over 20 points), so the verdict is "no detectable difference" with a sentence saying why. Better or worse can still follow when the sign-flip test agrees.
Why: Rishi picked it; it only removes a claim.

### D56: Provenance traces the inputs of arithmetic tools (5 Nov)
Options: an arithmetic tool's result counts as supported only when its inputs are supported (by a finance tool's result, the client's file or the client's message); any tool result counts (documented only).
Choice: trace the inputs, so a made-up figure cannot become "supported" by passing through `round(x)` or `add([x, 0])`. It changes what the grader counts: a new framework version, and the recorded trials regrade for free.
Why: Rishi picked it, closing the loophole found while adding the tools (D54).

### D58: Unit facts, an identity guard, and a reference-rates tool (5 Nov)
Options for market rates an agent volunteers: a `reference_rates` tool with sourced, dated assumptions; unit facts only (a rate counts only if the task, client or a tool states it); unit facts plus any rate the answer discloses as an assumption.
Choice: the tool. Rishi asked for "a smarter solution" than a short list of constants ("fd rate equity retuns days in a month a lot of them are there"). Three parts:
- Unit facts need no source: 7, 12, 28 to 31, 52, 100, 365, 366, 1,00,000 (lakh) and 1,00,00,000 (crore). Never 0 or 1, which are the laundering tricks (`add([x, 0])`, `multiply([x, 1])`).
- Identity guard: an arithmetic result equal to one of its own unsupported inputs never counts (`round(x)` and the like).
- A new finance tool `reference_rates` returns documented market assumptions (FD, equity, inflation, PPF, savings and the like), each with its source and as-of date, so a rate the agent volunteers has a source and an invented one still fails. It is a new toolset version for both arms; no experiment has run yet, so nothing recorded changes.
Why: our tasks already state the rates they need (in the message or the client file), so the remaining false "unsupported" came from unit facts and from rates an agent volunteers; grounding rates in a tool follows D54's rule that the model never invents what a tool can give.

### D61: Provenance verifies numbers instead of tracing tool calls (5 Nov)
Options: verify, don't trace (the standard extract-and-match pattern with derived figures recomputed); keep D56 and D58 as decided (strict input tracing); match sources only (any tool result counts).
Choice: verify, don't trace. A rupee figure in an answer counts when it matches a source (a tool result, `reference_rates` included; the user's or client's messages; the client file; the task's own text) within the existing tolerance, or when it is a correct one-step derivation the checker recomputes itself: a sum, difference, product, ratio or percentage of sourced numbers, where small counts, periods, rates and unit facts need no source but at least one operand must be a sourced value. A wrong sum fails; a correct one passes whether a tool or the prose computed it. Arithmetic tool results are judged the same way. "Figures written without a tool" (verified only as a derivation) is reported per arm as its own measure, so v1's prose arithmetic and v2's use of the tools stay visible, and the video can show the failure trace.
Why: Rishi: "Source could be user input yes but if it is too restrictive it becomes useless like 12 lakhs car in a year means 1 comes up how do we handle or are we overthinking this try to find out how numbers are verified in llm outputs". The usual approaches extract each number and match it to the sources under a declared tolerance policy, report unverified numbers as unverified rather than wrong (Proof-Carrying Numbers, arXiv 2509.06902), and check the key figures against known answers (FinQA's execution accuracy; our `number` graders, marked critical). D56's tracing blocked a laundering trick no trial has shown, at the price of false fails on ordinary inputs ("in a year", "3 months of expenses").
Kept from D58: the unit facts, the identity guard and the `reference_rates` tool (values still need Rishi's approval).

### D65: Freeze the agent side, and run the evaluation loop (5 Nov)
Choice: after the fixes already in flight (D61 provenance with the approved reference rates of D62, and the three task fixes under D63), the agent, its prompt v1, the tasks, the graders and the toolset are frozen as they are. No more tuning of the agent or the task set; anything found later is recorded as a finding or a known limit, not fixed. The work from here is the evaluation loop: the v1 run on discovery tasks, Rishi's labels, the judge's validation, the prompt v2 written from discovery traces, A/A calibration, the v1 vs v2 run on held-out tasks, and the comparison (D64's behaviour and causes are part of comparing runs, so they stay in scope).
Why: Rishi: "lets commit that these are last fixes and we take the agent and however they are into the evals loops next. So whatever it is we start the main thing they judge no one cares how well the agent works what matters is how well it can compare runs."

### D66: A standing spend allowance for two hours (5 Nov)
Rishi: "given the limited time we have left i would suggest anything less than 2 dollars and less than 50 $ over 2 hours u dont need to ask me". From 11:50 to 13:50 IST on 5 Nov, a single paid step under $2 (a judge pass, an A/A calibration, a re-run) may start without asking, keeping the total under $50, with trials, models and expected cost stated in `docs/cost.md` before it starts and the actual cost after. A step above $2 on its own still needs his go-ahead, and no step is split to stay under $2. After the window, R8 applies as before.

### D67 and D68: Prompt v2 is v1 plus the fixes; the judge measures them (5 Nov)
Rishi, on reading his 33 tuning labels against the graders (they agreed on 20 of 33: 10 trials he would pass failed on provenance over rounded or prose-summed figures, 3 he would fail passed because no deterministic check sees an assumed ambiguous amount or a confusing explanation): "Actually i think the changes to make this happen should be our v2, so the agent as is is v1 and these fixes are v2, the fail path". v2 takes the tool fix and "Tools + clarify" (his choice), plus explaining figures plainly from his notes. Without judge criteria for them, the comparison could see only the tool fix, so he approved the criteria too ("Yes, add the criteria").
For the write-up: the deterministic pass rate is mostly a provenance measure on these tasks; v2 targets provenance directly, so a pass-rate gain alone does not show clients served better. The judge criteria (once trusted) and the trajectories are what can show that.

## Entry template

```markdown
### D<n>: <title> (<date>)
Options: ...
Choice: ...
Why: ...
What would change it: ...
```
