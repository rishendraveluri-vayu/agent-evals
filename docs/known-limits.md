# Known limits

Where this platform's conclusions should not be trusted. Add a line the moment one turns up. Remove a line only if it's actually fixed and tested.

## Topics the brief names

- **Task-set size:** to fill in. With about 20 tasks, results may not generalise to other work.
- **Judge bias:** to fill in from `judge-validation.md`. Single human rater.
- **Contamination:** to fill in from the isolation tests.
- **Harness-specific quirks:** see below.

## Hermes-specific, from notes so far

- The system prompt contains the date, the model name and a home path, so prompts aren't byte-identical across days or models. Comparing models can't be a pure single-axis change.
- Memory on vs off also changes tools and prompt. Enabling memory and skills together added about 2k tokens per call, estimated as chars / 4.
- The Hermes repo changes daily, so results apply only to the pinned SHA.
- The prompt also carries the kernel release, user home, working directory, scratch path, an environment-probe line and a git snapshot. Byte-identical prompts across concurrent trials need fixed paths per trial, which in practice means a container. The calendar date cannot be fixed, so arms should be interleaved in time.
- Prompt-cache markers are sent only when the proxy hostname contains `litellm` and the model name contains `claude`. Cost and latency comparisons across model families are therefore affected by caching for Claude only.
- The extra summary call Hermes makes at `max_iterations` is missing from its own token and cost totals. Cost must come from the LiteLLM log, or Hermes trials that hit the step cap are undercounted.
- Compression, if left on, rewrites the transcript. The final message list is then not the full trajectory.
- With the MCP route, Hermes shows the model prefixed tool names and wraps tool results in an "untrusted" block with no switch to turn it off. A cross-harness comparison includes that difference.
- The agent's shell can read its LLM key from the environment, files or `/proc` in every isolation option. Per-trial budgeted virtual keys limit the damage; they do not prevent the read.
- Hermes has no switch to stop the agent editing its own `config.yaml`, `SOUL.md` or project context files. Only a before-and-after hash per trial detects it.
- Every Hermes finding so far comes from reading the code. None has been confirmed by running it.

## From the 3 Nov research

- **Judge validation per config is underpowered.** 15 to 25 labels per config supports descriptive numbers with intervals, not a pass or fail gate. No published practice validates judges per config.
- **Judges are weakest on emotional framing**, which is exactly what the finance advice tasks test. No study tests this on advice rubrics, so it must be checked in our own labels.
- **With about 20 tasks, task count limits power more than trials do.** Effects smaller than roughly 6 to 25 points will not be detectable whatever N is. That range is a calculation from Miller's formula under assumed variances, not a measured figure.
- **LiteLLM spend logs** price missing models at zero, skip cached-token pricing below provider minimums, and do not document how retries are billed.

## Hermes, from the SP1 probes (3 Nov)

- Hermes sends local-server probes (Ollama detection, `/models`) to the proxy host that no setting fully stops. They are excluded from model-call counts by path; a change in Hermes's probe paths would inflate counts until noticed.
- Hermes's own hooks miss its hidden unmask-probe retry and its max-iterations summary calls, so any Hermes-side trace under-reports model calls. The proxy's records are authoritative (R10.9); the two are kept side by side.
- Whether `reasoning_effort` would be translated into extended thinking on a real Claude or Gemini route behind LiteLLM was not tested; the adapter keeps it off the wire.

## Hermes, from the adapter's gate tests (3 Nov)

- Hermes repairs malformed tool-call JSON and runs the repaired call, or runs the tool with `{}` when it cannot repair it, without telling the model. The other harnesses send the error back. A model that often emits broken JSON will look better on Hermes for this reason alone; the `malformed_tool_calls` count on each trial shows where it happened.
- Hermes start-up (import and MCP discovery) takes several seconds of the trial's `timeout_s`, which the other harnesses do not spend. Wall-clock comparisons across harnesses include it.

## Trial isolation (D3)

- Consecutive trials in one harness container are separated by a process sweep, a folder wipe and a read-only root filesystem, not by a fresh container. A harness that writes somewhere we did not anticipate, such as a writable mount outside the trial folder, could carry state from one trial to the next. The SP3 leak test checks the known paths only.

## Cost tracking

- LiteLLM v1.99.4's bundled price map has no entry for Haiku 5.5 or Gemini 3.8 Flash (checked 3 Nov inside the pinned image). Spend on a model the map does not know counts as $0, so a per-trial `max_budget` would never trip. Every model in `services/litellm/config.yaml` must therefore state its prices in `model_info`, and `scripts/check_litellm_config.py` fails CI otherwise. Those prices are copied by hand from the provider pages, so they can go stale.

## LiteLLM records (checked 3 Nov, v1.99.4)

- A wildcard route priced only in `model_info` logged every call at $0, because LiteLLM prices the resolved model name (`openai/<script>`). The fake route now also sets prices in `litellm_params`. A real model added later under a wildcard would hit the same gap, so real models are listed one by one.
- Spend-log rows are written in batches, every second with `proxy_batch_write_at: 1`, and lagged by more than 1.5 s for a fast trial on 3 Nov. The runner now waits until LiteLLM holds at least as many calls as the harness reported, then 1.5 s of no change, at most 30 s. If the log never catches up, `proxy_usage.complete` is false and the trial's counts and cost are not trusted. A harness that under-reports its own calls could still let the wait end early; the floor is the harness's count, not the true one.
- LiteLLM cuts long strings out of the bodies it stores in the spend log (about 2,000 characters by default, with a note naming `MAX_STRING_LENGTH_PROMPT_IN_DB`). It cut the task prompt out of Hermes's system prompt on 3 Nov. Compose now sets the limit to 2,000,000 characters, and the merge flags any body that still carries the note (`evals.request.truncated`), which fails the proxy gate.
- The proxy merge puts a model call under the agent turn whose time window holds its start. The clocks are the adapter's and LiteLLM's container clocks; skew between them larger than the gap between turns would misplace a call.

## Invariance diff

- It normalises only the trial folder path and Hermes's "Conversation started:" date line. Other per-run text in Hermes's prompt (kernel release, host, user name) is constant on one machine, so trials compared across machines will show it as unexpected differences. Real runs happen in one container image, which keeps them constant.
- It compares the first request only. A difference that appears later in a trial (for example a tool result wrapped differently) is not caught here; the trace shows it.

## Simulated client (D22)

- The reply cache is filled per trial and stored by the runner afterwards. Two trials running at the same time that reach the same new conversation state both call the simulator, and can get different replies; the first stored wins for later trials. At temperature 0 the replies should match, but that is not guaranteed.
- The simulator's own calls go through a separate key, so they are not in the agent's spans or counts. Their cost is not yet added to the trial's spend.

## Fake model server (tests and CI only)

- It does not model `max_tokens` (so it never returns `finish_reason: length`), `tool_choice`, `n`, auth, or whether a tool call matches the request's `tools`. Tests that pass against it say nothing about those behaviours; real dev runs (R9) cover them.
- It speaks only the OpenAI Chat Completions format. A harness that needs the Anthropic Messages format (for example the Claude Agent SDK) reaches it only through LiteLLM's translation, which is untested.

## Finance tools (`services/finance-mcp`)

- Loans that cannot be scheduled in whole paise are rejected rather than approximated: an EMI that rounds to ₹0, an EMI below the first month's interest, a loan that would clear early, or a final payment above twice the EMI. Tasks must avoid such inputs.
- Tool schemas leave the server identical for every client, but harnesses rewrite them before the model sees them (LangGraph strips titles and inlines references; ADK wraps descriptions). The schemas are kept flat to minimise this, and the tool test compares what actually reaches the model.
- The MCP SDK orders `inputSchema` keys differently under protocol 2026-07-28 than under 2025-11-25. Content is identical; every known harness negotiates 2025-11-25.

## To check before submission

- [ ] Upstream OpenRouter provider changes, if D5 goes hosted
- [ ] Rate-limit retries that could affect latency numbers
- [ ] Prompt caching that could affect cost and latency differently per provider
- [ ] Anything the invariance diff could not explain
- Haiku 5.5 charges 5x for any request whose prompt is over 100,000 tokens (Claude pricing page, 4 Nov). LiteLLM's price fields have no 100k tier, so spend on such a request would be under-counted by up to 5x. Our prompts are far below it; a trial that grows past it should be flagged from the token counts.
- Malformed tool calls are handled differently by each harness, so a "malformed call" task does not measure the same thing everywhere (4 Nov, from the gate tests against the fake): the own loop sends the error back; Hermes repairs the JSON silently; LangGraph ends the run when a reply holds only malformed calls (labelled `agent_error`, the model never sees the error); Google ADK drops the bad call and puts a call to a tool that does not exist (`adk_handle_model_error`) in its place, ending the turn after the 4th in a row; the OpenAI Agents SDK sends a fixed "An error occurred while running the tool. Please try again." Compare harnesses on such tasks only with this in mind.
- Text the harness adds differs: ADK appends an identity line and a fencing preamble to the system prompt and wraps every tool description in untrusted-content markers; Hermes adds its own guidance and prefixes tool names; LangGraph and the Agents SDK add nothing. Token counts and costs across harnesses include this overhead.
- LangGraph's OpenAI client changes requests by model name with no switch: `gpt-5*` names drop temperature, `o1*` names send temperature 1 when none is set, `o<digit>` names send the system prompt as `developer`. Claude and Gemini names are unaffected; a config using such names on LangGraph is not comparable.
- The Agents SDK does not expose `finish_reason`; the adapter reads it from the raw response to detect `token_limit`. The fake never returns `length`, so that path is untested end to end.
- The runner labels a `harness_error` as `agent` unless LiteLLM's last status was 429, 5xx or a budget stop. On the first real run (4 Nov) a provider 400 for an unscoped API key was labelled `agent`, which would have counted a setup error against the config. Until the labelling rule is settled, read the end detail of every `harness_error` trial before scoring it.
- Claude Haiku 5.5 rejects any non-default temperature (Claude API docs, 4 Nov; to be confirmed by the settings smoke trial). On Haiku the temperature setting cannot vary, and the simulated client cannot run at temperature 0 as D22 says; the smoke script sends Haiku's default of 1 and relies on the reply cache for repeatability.

