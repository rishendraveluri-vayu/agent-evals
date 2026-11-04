# Hermes notes

Pinned commit: `6112c2adb9e11f69734a29be9d2696f345ffa06a` (committed 2 Nov 2026).

Sources: one no-LLM measurement in a scratch install, and four code audits on 3 Nov in `docs/research/hermes/`, which hold every `path:line` citation. The synthesis is `docs/research/reports/Hermes architecture and traces.md`.
Nothing has been run against a real model. Apart from the measurement below and a partial tool-registry probe, every finding comes from reading the code.

## Install and entry point

- **Python.** `requires-python` is `>=3.11,<3.15`, but every core dependency carries a `python_version >= '3.14'` marker. On 3.11 to 3.13 the install succeeds with no core dependencies and fails later. Only 3.14 works. The lockfile agrees: `[tool.uv] environments` is `python_version >= '3.14'`, so `uv sync --locked --python 3.13` refuses outright. Verified install (3 Nov): `uv sync --locked --extra mcp --python 3.14` at the pin, with `mcp` 2.3.0 and `openai` 2.54.0, and `import run_agent` succeeds.
- **Entry point:** `run_agent.AIAgent`, then `run_conversation(...)`. No CLI scraping needed.
- **Import side effects.** Importing `run_agent` loads `HERMES_HOME/.env` and the checkout's `.env` into `os.environ`, exports `TMPDIR` to `HERMES_HOME/cache/scratch`, and for a fresh home starts a detached scratch-cleanup process. Measured 3 Nov: a bare `import run_agent` with `HERMES_HOME` pointed at an empty folder created `audio_cache`, `cache`, `cron`, `hooks`, `image_cache`, `logs`, `memories`, `pairing`, `sessions` and `skills` there. So `HERMES_HOME` must be set before the import, once per trial process; it cannot be switched inside one process.
- **Custom SQLite in the Dockerfile is not needed.** Hermes already refuses WAL mode on a vulnerable SQLite, and the bug needs several processes sharing one `state.db`. The local Python 3.14 links SQLite 3.53.1, which is not affected.
- **Hermes's own `evals/` folder** holds regression probes, not an eval platform.
- **Pinned dependencies conflict with other harnesses.** Hermes pins `mcp==2.3.0` and `openai==2.54.0`. Verified 3 Nov with a resolve-only `uv pip compile`: `langchain-mcp-adapters` 0.3.2 needs `mcp<2`, and `openai-agents` 0.24.0 needs `openai>=3` while `google-adk[extensions]` 2.13.0 needs `openai<3`. Each harness needs its own environment.

## Routing and request parameters

- **Pin the API mode.** Neutral model names stay on `chat_completions`, but a `gpt-5*` name with no `provider` switches to the Responses API, and a `base_url` ending in `/anthropic` switches to the Anthropic SDK. Always pass `api_mode="chat_completions"` and `provider="custom"`.
- **Temperature** reaches the request only through `request_overrides`, as top-level fields. Hermes's per-model temperature rules never run on the proxy path, so the platform owns sampling parameters. `reasoning_config` is not sent to a plain proxy.
- **Prompt-cache markers** are sent only when the proxy hostname contains `litellm` and the model name contains `claude`. The hostname is a hidden variable.
- **Context length.** For a custom `base_url` Hermes reads `GET {base_url}/models`, then a name catalog, then assumes 256,000 tokens. For a local-looking host it also probes `/api/tags`, `/version` and `POST /api/show`. Pin `model.context_length` in config.
- **`.env` under `HERMES_HOME` is re-read every turn** and can swap the key or `base_url` mid-run. Never put one in a trial home.

## Loop, budgets and results

- **`max_iterations`** defaults to `sys.maxsize`, so always set it. Hitting it triggers one extra tool-less summary call that is missing from `api_calls`, the token totals and the hooks.
- **`run_budget_seconds` is not a hard stop.** It injects a wrap-up notice at 80%. The wall-clock stop must be ours.
- **`max_tokens` truncation is not a stop.** Hermes raises the output cap and continues.
- **Result dict** carries `final_response`, `messages`, `api_calls`, `completed`, `failed`, `partial`, `interrupted`, `turn_exit_reason`, `failure_reason`, `failure_retryable`, cumulative token counters, `estimated_cost_usd`, `cost_status`, `cost_source`, `model`, `provider`, `session_id` and `turn_id`. Early-exit results carry no token keys: record those as unknown, not zero.
- **The system prompt is not in `result["messages"]`.** Read `agent._cached_system_prompt`.
- **Compression** is on by default and replaces `messages` in place through an auxiliary LLM call. Detect it with `event_callback("session:compress")`; disable with `compression.enabled: false`.
- **Headless, dangerous commands are auto-approved** apart from a hard-coded block list. Never set `HERMES_INTERACTIVE` in trials, or each such command waits 300 s.

## Callbacks and hooks

- **Constructor callbacks** cover steps and tool calls only: `step_callback` (before each request, not after a response), `tool_start_callback`, `tool_complete_callback`, `tool_progress_callback` (the only one with tool duration), `status_callback`. `event_callback` fires only for `session:compress`.
- **Plugin hooks** carry everything else: `pre_api_request`, `post_api_request` (usage, latency, time to first token), `api_request_error`, `pre_tool_call`, `post_tool_call`, `on_skill_lifecycle`, `post_compaction`, `pre_auxiliary_call`, `post_auxiliary_call`, `on_session_start`, `on_session_end`. They load from a plugin folder under `HERMES_HOME/plugins/` with `register(ctx)`. `HERMES_SAFE_MODE=1` disables them.
- **`pre_api_request` truncates the request body** at 50k characters. Its `request_messages` list is untruncated; the LiteLLM log is ground truth.

## Context, memory and skills

- **System prompt order:** stable tier (identity, tool guidance, coding brief), context tier (project files, git snapshot, environment probe), volatile tier (skills index, memory, plugin sections, profile line, date and model, runtime block). Built once per session.
- **Per-run variance with identical config:** date and timezone (from the session id timestamp), `HERMES_HOME` path, user home, cwd, kernel release, scratch path, environment-probe line, git snapshot, plus model, provider and platform names.
- **cwd in the prompt** comes from `TERMINAL_CWD` or the process cwd. The constructor's `cwd` argument feeds only context-file discovery and the memory provider.
- **Identity text is the same with or without `skip_context_files`.** The seeded `SOUL.md`, the built-in default and the repo `SOUL.md` are identical.
- **Memory** is two files under `HERMES_HOME/memories/`, read only by injection into the prompt at construction. The `memory` tool has no read action.
- **Seeded memory entries that match Hermes's threat patterns are replaced** with a `[BLOCKED: ...]` placeholder in the prompt snapshot, silently. Render the seeded prompt and check every fact landed.
- **`skip_memory` is not a memory-off switch.** It disables only external providers. With the memory toolset enabled, the built-in store still loads, injects and writes. Without the toolset, a non-empty `MEMORY.md` still enters the prompt. Earlier measurement saw no change only because the home was empty.
- **Memory off** needs the toolset excluded and `skip_memory=True`, or `memory_enabled` and `user_profile_enabled` both false.
- **Skills** start empty in a fresh home. Bundled skills are synced by the CLI, TUI, installer, Docker and profile creation, never by `AIAgent`. The skills toolset exposes `skills_list`, `skill_view` and `skill_manage` together. `skill_manage` edits `skills.external_dirs` in place.

## Self-modification defaults

On by default once memory or skills tools are enabled. The full inventory with switches is in `docs/research/hermes/context_and_self_improvement.md`, sections 4 and 5.

- `skip_background_review=True` stops the end-of-turn review fork on the chat-completions path only. Also set `auxiliary.background_review.enabled: false`, which covers every path, and both nudge intervals to 0.
- Code defaults: `skills.creation_nudge_interval` 10 (the example config says 15, but it is copied only by the installer), `memory.nudge_interval` 10, `auxiliary.background_review.enabled` true, `security.allow_lazy_installs` true.
- No switch exists for the agent editing `config.yaml`, `SOUL.md` or `AGENTS.md` with its own tools. Only a before-and-after hash catches it.

## Tools and MCP

- **MCP servers load unmodified** from `mcp_servers` in `config.yaml`, over stdio, Streamable HTTP or SSE. A headless agent does not run discovery itself: call `discover_mcp_tools()` first.
- **Names are `mcp__<server>__<tool>`.** The user guide says `mcp_<server>_<tool>`, which is wrong. The MCP tool timeout default is 300 s in code, not the 120 s in the example config.
- **Tool Search** is on by default and hides MCP, plugin and runtime tools behind `tool_search`, `tool_describe` and `tool_call`. Turn off with `tools.tool_search.enabled: "off"`. This is also why the earlier measurement saw those three tools with only `file` and `terminal`: the `terminal` toolset includes `process_manage`, which is on the default defer list.
- **MCP results are wrapped** in `<untrusted_tool_result>` by name prefix. No switch found.
- **Three consecutive MCP error results** pause every tool on that server for 60 s.

## Isolation and state

- **`set_hermes_home_override` is per context, not per instance.** It does not carry into threads, and terminal settings, `.env`, caches and the cwd are process-global. Several agents in one process are ruled out; run one process per trial.
- **The local terminal backend has no sandbox.** It runs `bash` as our user and strips only a fixed list of key names from the shell environment. `LITELLM_*` names are not on it.
- **The docker terminal backend** defaults to reusing one long-lived container across sessions and processes. For trials set `TERMINAL_CONTAINER_PERSISTENT=false` and `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES=false`.
- **`session_db=None` is safe** except for the `session_search` tool, which opens the default `state.db`.
- **Plugin discovery** runs at every `AIAgent()` and loads `HERMES_HOME/plugins` and `cwd/.hermes/plugins`.

## Measured, no LLM call

Script: `scripts/measure_hermes_overhead.py`. Fresh `HERMES_HOME`, sizes estimated as chars / 4, so treat them as approximate.

| `enabled_toolsets` | Tools | Tool schemas | System prompt | Total per call |
| --- | --- | --- | --- | --- |
| `file`, `terminal` | 8 | ~2.6k tok | ~1.0k tok | ~3.7k tok |
| `file`, `terminal`, `memory`, `skills` | 12 | ~4.5k tok | ~1.3k tok | ~5.8k tok |
| Default (none passed) | 20 | ~10.1k tok | ~1.3k tok | ~11.4k tok |

## Confirmed in SP1 against the fake LLM server (3 Nov)

37 Hermes processes at the pin, only against the fake model server, directly or through the compose LiteLLM. No real LLM calls. Method, evidence and source lines: `docs/research/hermes/sp1_probes.md`.

- [x] **Rendered prompt.** Memory adds a guidance paragraph, a `MEMORY` block with a usage meter and a `USER PROFILE` block. Skills add a `skill_manage` nudge and a `## Skills` block telling the model it "MUST" load matching skills. An injection-shaped seed entry becomes `[BLOCKED: …]` and is logged at WARNING in `logs/errors.log`, so seeding can be checked for it.
- [x] **`request_overrides`** puts `temperature`, `top_p`, `seed` and `parallel_tool_calls` top-level in the body. Constructor `max_tokens` is sent as `max_tokens`; `request_overrides.max_tokens` wins over it.
- [x] **Pinning `model.context_length` does not stop every non-chat request (refuted).** It removes only the context-length lookups. Ollama `num_ctx` detection still sends five GETs to any "local" host, including `litellm`, unless `model.ollama_num_ctx` is set. After the first response the cost estimator fetches `{base_url}/models` and reruns those probes, with no switch found. They are harmless 404s inside our network, but they show up in proxy logs and must be excluded from call counts.
- [x] **Retries.** A 429 gets 3 attempts about 1 s apart (Retry-After honoured). A 500 gets 3 attempts with roughly 2 s and 5 s backoff. Default auto-recovery (`agent.auto_recovery_cycles: 5`) kept an always-500 trial going for 284 s and 23 requests; with `0` it ended in 9 s. Per R10.11 and D16 the adapter sets client retries and auto-recovery to 0.
- [x] **No per-trial `session_id`, `user`, `metadata` or cache key** in bodies or headers. Two trials' bodies were byte-identical once paths were normalised.
- [x] **MCP sequence.** Tool names are `mcp__finance__*`. Tool Search hides them by default; `tools.tool_search.enabled: "off"` fixes that. Results are wrapped in `<untrusted_tool_result>` with a preamble, and there is no switch (D20 keeps it). Hooks see the unwrapped result. The finance server advertises resources and prompts, so `mcp_servers.finance.tools: {resources: false, prompts: false}` is needed to avoid four extra utility tools. With that, `enabled_toolsets=["finance"]` and Tool Search off, exactly the 11 finance tools reach the model.
- [x] **Headless run with `session_db=None`** creates no `state.db` and never changes `config.yaml`. Nothing is written outside `HERMES_HOME`. Failed runs add `sessions/request_dump_*.json` (no key inside).
- [x] **No third-party calls** from the Hermes process on a custom route (an in-process audit hook saw only loopback). Child processes were not covered: `finance-mcp`, seven local `git` commands at MCP connect, scratch-prune and `uname -p`. The container's internal network covers them.
- [ ] **Community OpenTelemetry plugins:** not verified; they need the OTel SDK and exporter, which are not installed. Not needed under D12.

**Corrections to the 3 Nov code audit, found by running it:**

- **Hermes sends `reasoning_effort: "medium"` on every request.** At this pin `provider="custom"` has a provider profile with a default effort (`plugins/model-providers/custom/__init__.py:46-54`). Through our LiteLLM (`drop_params: false`) the first request then gets a 400, and Hermes retries without the field. `agent.reasoning_effort` in config is ignored by `AIAgent`. Keep it off the wire with `model_overrides.custom.<model>.supports_reasoning: false`; `reasoning_config={"enabled": False}` sends `"none"` instead.
- **`max_iterations=N` makes N+1 requests**: N tool-calling requests plus a non-streaming summary request that still carries `tools`. If the model answers it with a tool call, Hermes retries the summary once, then returns a canned "couldn't generate a summary" string. `api_calls`, token totals and hooks exclude the summary calls.
- **Hermes's hooks and counters miss requests the proxy sees.** A streaming 5xx triggers a hidden non-streaming "unmask probe" whose success looks like one clean call. Summary calls fire no API hooks, and `on_session_end` does not fire on failure. Request counts and infra labels must come from LiteLLM (R10.9).
- **A failed run returns an apology in `final_response`**, with `failed=True` and no token keys. The apology says "3 attempts" even after 18. The adapter must map `failed=True` to `harness_error` and never pass the apology on as an answer.
- **Prompt-cache markers** appear for `claude` model names on the hostname `litellm` (three `cache_control` markers, string content turned into part lists), as the audit predicted. `prompt_caching.cache_ttl: "off"` removes them.
- Tool-call arguments replayed on the wire are re-serialised with sorted keys.

## Found while building the adapter (3 Nov, gate tests against the fake)

All nine gate tests pass at the pin (`workers/hermes/tests/test_gate.py`), against the fake model server only.

- **Malformed tool-call JSON is repaired, not returned.** `agent/message_sanitization.py:_repair_tool_call_arguments` closes unclosed braces, strips trailing commas and fixes control characters, then runs the repaired call. If it cannot repair the arguments it runs the tool with `{}`. The model is never told its call was malformed. No switch was found, so D18 records this as a harness difference. Each repair is logged at WARNING in `logs/agent.log`, and the adapter counts it from there as a `malformed_tool_call` event.
- **The task system prompt goes in as `run_conversation(system_message=...)`.** Hermes puts it in the context tier of its own system prompt, after its identity and tool guidance, which D20 keeps.
- **Hermes's own retries are a config key:** `agent.api_max_retries` (minimum 1, meaning a single attempt) with `agent.auto_recovery_cycles: 0`. With both, a permanent 429 got exactly one request.
- **The step budget resets every turn** from `agent.max_iterations` (`agent/turn_context.py:664`), so the adapter sets it to the trial's remaining steps before each turn of a conversation. At `max_steps=3` the fake saw 5 requests: 3 counted by Hermes and 2 summary requests it does not count.
- **Start-up takes several seconds** (import, then MCP connect and discovery) before the first model call. It counts toward `timeout_s`.
- **MCP tool filtering** uses `mcp_servers.<name>.tools.include`, so a toolset version that leaves a tool out reaches Hermes as a smaller tool list.

## Decided after Rishi's review (4 Nov evening), gate-level tests against the fake

Tests: `workers/hermes/tests/test_prompt_switches.py`, against the fake model server only.

- [x] **D33: the "Parallel tool calls" prompt section follows `parallel_tool_calls`.** The switch is Hermes's own config key `agent.parallel_tool_call_guidance` (default true, `hermes_cli/config_defaults.py:176`, read in `agent/agent_init.py:1323`; the section is `PARALLEL_TOOL_CALL_GUIDANCE` in `agent/prompt_builder.py:411`, added in `agent/system_prompt.py:566` only when tools are loaded). The adapter writes `false` when the setting is false and leaves the key out when it is true or unset. With `false`, the system message on the wire has no "# Parallel tool calls" heading and still has "# Finishing the job" and every other section (D20). `applied_settings.parallel_tool_call_guidance` records the value read back from `agent._parallel_tool_call_guidance`.
- [x] **D31: prompt-cache markers are off in every config.** The adapter writes `prompt_caching.cache_ttl: "off"` unless `harness_options.prompt_cache_markers` is true. Checked with a model name containing `claude` on a host named `litellm.localhost` (which resolves to loopback here): no `cache_control` in any request by default or with the option false, and markers present with it true. `applied_settings.prompt_cache_markers` has source `platform_default` unless the option is set.

## Verified on Claude Haiku 5.5 through the engine (D39, 4 Nov night)

30 real trials, 10 per memory mode, the 10 draft tasks used in label batch 1's single and conversation mix, experiments `e_0mw2932bv7f47b6e7c4f32a21` (memory off), `e_0mw2932ff68fb231326079843` (on, empty) and `e_0mw2932j32262e513cc0e9021` (on, seeded). Checked trial by trial from the stored files with `scripts/verify_hermes.py` (reads only).

- [x] **Our task prompt reaches the model intact**, inside Hermes's system prompt, in 30 of 30 (D20).
- [x] **No "Parallel tool calls" section** with `parallel_tool_calls: false`, 30 of 30 (D33).
- [x] **No `cache_control` marker in any request**, 30 of 30 (D31).
- [x] **Tools are exactly the 11 finance tools**, plus `memory` only when memory is on, 30 of 30.
- [x] **Memory off has no memory tool and no memory block; on and empty has the tool and none of the seed text; on and seeded has every seeded entry in the prompt**, 30 of 30.
- [x] **LiteLLM's call count equals Hermes's own in every trial** (0 calls unaccounted for in 30), and LiteLLM's log was complete each time (R10.9).
- [x] **Compression never fired**, and **Hermes's config files hashed the same after each trial as before**.
- **Hermes never called the `memory` tool** in the 20 memory-on trials. Every trial is one session, and nothing in these tasks asks it to remember anything. So within one trial, "memory on, empty" differs from "memory off" only by the tool's schema and the memory section of the prompt, and "seeded" differs by the seeded text. See `docs/known-limits.md`.
- Cost per trial: $0.0082 off, $0.0106 on and empty, $0.0087 seeded (one run each, not a comparison).

## Prompt caching before and after D31 (4 Nov night, from LiteLLM's spend log)

- Hermes as it comes marks its prompt for Anthropic's cache. Before D31 took effect, its trials
  were cached: label batch 1 read 86% of its prompt tokens from the cache (581,765 of 678,844,
  76 calls, plus 37,835 cache writes), the client-sim v2 and v3 checks 79% and 65%. The reads are
  about 6,350 tokens a call, the size of its system prompt.
- Since D31 (the adapter writes `prompt_caching.cache_ttl: "off"` unless
  `harness_options.prompt_cache_markers` is true), none: the three D39 runs had 0 cache reads and
  0 writes in 1.87M prompt tokens, which matches the D39 check "no `cache_control` marker in any
  request". The own loop and LangGraph never sent cache markers.
- An earlier version of this note (written the same night) said Hermes still uses the cache; it
  mixed the trials from before and after D31. Corrected on 5 Nov.
