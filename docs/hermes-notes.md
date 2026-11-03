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

## Still to confirm in SP1, against the fake LLM server

- [ ] Rendered prompt for frozen, memory-seeded and skills-seeded homes
- [ ] `request_overrides` puts `temperature` in the request body
- [ ] Pinning `model.context_length` stops every non-chat probe to the proxy
- [ ] Retry count, backoff and result shape on a failing endpoint
- [ ] Whether any request body carries a per-trial `session_id`, `user`, `metadata` or cache key
- [ ] Message and hook sequence for one MCP tool call
- [ ] Whether a headless run creates `state.db` or edits `config.yaml` with `session_db=None`
- [ ] Whether the OpenRouter catalog is fetched on a custom route, the only possible third-party call
- [ ] Whether the community OpenTelemetry plugins work at the pin
