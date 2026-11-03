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

## Trial isolation (D3)

- Consecutive trials in one harness container are separated by a process sweep, a folder wipe and a read-only root filesystem, not by a fresh container. A harness that writes somewhere we did not anticipate, such as a writable mount outside the trial folder, could carry state from one trial to the next. The SP3 leak test checks the known paths only.

## Cost tracking

- LiteLLM v1.99.4's bundled price map has no entry for Haiku 5.5 or Gemini 3.8 Flash (checked 3 Nov inside the pinned image). Spend on a model the map does not know counts as $0, so a per-trial `max_budget` would never trip. Every model in `services/litellm/config.yaml` must therefore state its prices in `model_info`, and `scripts/check_litellm_config.py` fails CI otherwise. Those prices are copied by hand from the provider pages, so they can go stale.

## Fake model server (tests and CI only)

- It does not model `max_tokens` (so it never returns `finish_reason: length`), `tool_choice`, `n`, auth, or whether a tool call matches the request's `tools`. Tests that pass against it say nothing about those behaviours; real dev runs (R9) cover them.
- It speaks only the OpenAI Chat Completions format. A harness that needs the Anthropic Messages format (for example the Claude Agent SDK) reaches it only through LiteLLM's translation, which is untested.

## To check before submission

- [ ] Upstream OpenRouter provider changes, if D5 goes hosted
- [ ] Rate-limit retries that could affect latency numbers
- [ ] Prompt caching that could affect cost and latency differently per provider
- [ ] Anything the invariance diff could not explain
