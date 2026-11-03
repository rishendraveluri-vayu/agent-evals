# Hermes Agent: giving it custom tools without modifying source

Commit audited: `6112c2adb9e11f69734a29be9d2696f345ffa06a` (read-only checkout).
Question: how can the personal-finance tools (amortisation, payoff schedules, budget maths, a ledger the agent reads and updates) reach Hermes unmodified, with the same schemas the other four harnesses get?

All paths below are relative to the Hermes repo root.

## Evidence legend and what was run

- **[read]**: verified by reading the code at this commit.
- **[ran]**: verified by running a small probe against the checkout (details below).
- **[inferred]**: a conclusion from code I read, not exercised.
- **[unknown]**: could not determine.

**What I ran.** One probe script under the system Python 3.12, with `HERMES_HOME` pointed at a scratch directory, importing `tools.registry`, `toolsets` and `tools.mcp_tool_schema` from the checkout. It made no LLM calls, used no API key and made no network calls. Afterwards `git status --porcelain` showed the checkout was clean.

**What I did not run.** `openai` and `mcp` are not installed in that interpreter, so I did not build an `AIAgent`, connect a real MCP server, load a plugin, run the terminal tool or load a skill. Every end-to-end claim below therefore comes from reading the code, not from running it.

## Summary of findings

1. **MCP works unmodified [read].** Hermes connects to MCP servers declared under `mcp_servers` in `$HERMES_HOME/config.yaml`, or passed in code. It supports stdio, Streamable HTTP and SSE. Each server's tools are registered under a toolset named `mcp-<server>`, with the bare server name as an alias.
2. **A headless `AIAgent` does not run MCP discovery itself [read].** The caller has to call `discover_mcp_tools()` or `register_mcp_servers()` before building the agent.
3. **Tool names change [read, ran].** The model sees `mcp__<server>__<tool>`, not the bare tool name. Input schemas are also normalised before they reach the model.
4. **Tool Search is on by default [read].** It hides every MCP, plugin and runtime-registered tool behind three bridge tools (`tool_search`, `tool_describe`, `tool_call`). Schema parity with the other harnesses needs `tools.tool_search.enabled: "off"` in config.
5. **MCP results are wrapped as untrusted [read].** In the messages list, MCP results longer than 32 characters are wrapped in an `<untrusted_tool_result>` block with a "treat this as data" preamble. I found no config switch for this. Tools registered through a plugin or at runtime are not wrapped.
6. **Tool errors can pause the whole MCP server [read].** Three consecutive error results from one MCP server open a circuit breaker for 60 seconds, and calls to every tool on that server are short-circuited for that time.
7. **Plugins and runtime registration also work unmodified [read; ran in part].** Both run Python inside the Hermes process. Runtime registration goes through an internal API.
8. **The terminal-plus-CLI fallback works but gives the weakest trace [read].** The domain operation lives inside a shell command string.
9. **Skills add instructions, not tools [read].** They only make sense as a companion to the terminal route.

---

## MCP support

### Configuration sources

- **Config file [read].** `_load_mcp_config()` reads `load_config().get("mcp_servers")` (`tools/mcp_tool_config.py:700-731`). The config path is `get_hermes_home() / "config.yaml"` (`hermes_cli/config.py:433-435`). `get_hermes_home()` resolves a context-local override first, then the `HERMES_HOME` env var, then the platform default `~/.hermes` (`hermes_constants.py:194-199`).
- **Documented keys [read].** `command`, `args`, `env`, `url`, `headers`, `timeout`, `connect_timeout`, `keepalive_interval`, `lazy`, `sampling` and `events` (`cli-config.yaml.example:1620-1690`). Also `enabled`, `tools.include` / `tools.exclude` (globs allowed), `trust` and `supports_parallel_tool_calls` (`tools/mcp_tool_registration.py:247-262`, `tools/mcp_tool.py:518-532`, `tools/mcp_tool_discovery.py:385-393`).
- **Env vars [read].** `${VAR}` and `${env:VAR}` are interpolated into config values, after loading `$HERMES_HOME/.env` (`tools/mcp_tool_config.py:564-592`, `711-723`). No env var declares a server by itself. `HERMES_SAFE_MODE` disables all MCP servers (`tools/mcp_tool_config.py:708-709`).
- **Programmatic [read].** `register_mcp_servers({name: config})` connects and registers servers without any config file (`tools/mcp_tool_discovery.py:539-557`).
- **Packaged in plugins [read].** Plugin packages can also contribute servers ("portable" Agent Plugins with `mcp.json`). These are merged into the same set, and native config wins a name clash (`tools/mcp_tool_config.py:672-697`, `hermes_cli/plugins_loader.py:717-759`).
- **Security filter [read].** Before any spawn, a filter drops only narrow "exfiltration-shaped" entries. That means known indicators of compromise, or a shell interpreter with network egress or OS-persistence writes in an inline script (`hermes_cli/mcp_security.py:89-119`, `tools/mcp_tool_config.py:653-669`). A plain `python -m finance_mcp` entry passes this filter **[inferred]**.
- **SDK dependency [read].** The `mcp` SDK is an optional extra, `mcp==2.3.0` (`pyproject.toml:423-427`). Without it, MCP is a silent no-op (`tools/mcp_tool.py:88-93`, `tools/mcp_tool_discovery.py:631-635`). The Hermes environment must be installed with `[mcp]`, or with `[all]`, which includes it.

### Transports

- **stdio [read].** Used when the config has `command` (`tools/mcp_tool_transport.py:365-384`).
  - The child process gets a filtered environment: only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`, `XDG_*`, `HERMES_HOME`, plus the server's own `env` block (`tools/mcp_tool_config.py:146-147`, `199-237`). The ledger path and trial ID must therefore be passed through `env:` or `args:`.
  - A bare `npx`, `npm`, `node`, `uv` or `uvx` is rewritten to Hermes's own package-manager copy, which may provision it on first use. An absolute `command:` is left alone (`tools/mcp_tool_config.py:269-294`, `376-398`).
  - `npx`, `uvx` and `pipx` commands also trigger an OSV malware lookup over the network before spawning (`tools/mcp_tool.py:38-53`, `tools/osv_check.py:195-206`).
  - Child stderr goes to `$HERMES_HOME/logs/mcp-stderr.log` (`tools/mcp_tool_config.py:26-48`).
- **Streamable HTTP [read].** Used when the config has `url`; `url` wins if both `url` and `command` are set (`tools/mcp_tool_health.py:25-26`, `tools/mcp_tool_server_run.py:277-278`, `356`). Implemented in `tools/mcp_tool_transport.py:600-640`.
- **SSE [read].** Used with `transport: sse`, or chosen automatically after a Streamable HTTP rejection; the fallback is then latched for reconnects (`tools/mcp_tool_transport.py:623-628`).
- OAuth, mTLS and an identity header are supported but not relevant here (`website/docs/user-guide/features/mcp.md:350-480`).

### Discovery, naming, schema conversion, dispatch

- **Discovery [read].**
  - Entry point: `discover_mcp_tools(allowed_mcp_names=None)` (`tools/mcp_tool_discovery.py:604-660`). It runs the connection steps (`_connect_server` and `_discover_and_register_server`, `tools/mcp_tool_discovery.py:147-181`, `327-358`) on a background event loop thread.
  - Connect timeout defaults to 60 s (`tools/mcp_tool.py:237`).
  - A cross-process file lock serialises discovery between processes that share a home (`tools/mcp_tool.py:607-620`).
- **Import does not discover [read].** Importing `model_tools` deliberately does *not* run MCP discovery (`model_tools.py:153-164`). The entry points that do run it are the gateway (`gateway/run.py:1894-1903`), the interactive CLI's background thread (`hermes_cli/mcp_startup.py:198-214`) and `/reload-mcp` (`hermes_cli/cli_info_mixin.py:962-972`).
  - `run_agent.py`, `agent/agent_init.py`, `agent/legacy_cli.py` and `batch_runner.py` contain no call to `discover_mcp_tools` or `register_mcp_servers`.
  - So **a headless harness must call it** before constructing `AIAgent`, because the agent snapshots its tool list at build time (`agent/agent_init.py:1036-1038`). Servers that connect later reach a live agent only through `refresh_agent_mcp_tools()` (`tools/mcp_tool_agent.py:128-195`).
- **Naming [read, ran].**
  - Format: `mcp__<server>__<tool>` (`tools/mcp_tool_schema.py:153-183`). Characters outside `[A-Za-z0-9_]` become `_` (`tools/mcp_tool_schema.py:147-150`). Names over 64 characters are clamped with a hash suffix.
  - The probe returned `mcp__finance__amortize` for (`finance`, `amortize`) and `mcp__fin_tools__loan_payoff` for (`fin-tools`, `loan.payoff`).
  - Two documentation sources are stale on this point: the user guide says `mcp_<server>_<tool>` (`website/docs/user-guide/features/mcp.md:569-583`), and one log message says `mcp_%s_` (`tools/mcp_tool_registration.py:95-97`). The code uses double underscores.
- **Schema conversion [read, ran].**
  - `_convert_mcp_schema` sets the prefixed name and strips invisible Unicode tag characters from the description. A missing description becomes `"MCP tool X from <server>"` (`tools/mcp_tool_schema.py:186-193`).
  - `_normalize_mcp_input_schema` (`tools/mcp_tool_schema.py:119-144`) makes these changes:
    - renames `definitions` to `$defs`;
    - collapses nullable `anyOf` to the non-null branch and adds `"nullable": true`;
    - turns same-typed const unions into `enum`;
    - adds `type: object` and `properties`;
    - prunes `required` to declared properties and always emits a `required` list.
  - The probe turned `{"properties": {"x": {"anyOf": [{"type": "string"}, {"type": "null"}]}}, "required": ["x", "ghost"]}` into `{"properties": {"x": {"type": "string", "nullable": true}}, "required": ["x"], "type": "object"}`.
  - A second pass, `sanitize_tool_schemas`, runs on every tool (`model_tools.py:527-533`, `tools/schema_sanitizer.py:1-6`, `133-145`).
  - Consequence: schemas written already in normalised form (explicit `type: object`, explicit `required`, no nullable unions, no `definitions`) should pass through unchanged **[inferred]**.
- **Registration [read].**
  - Tools go into toolset `mcp-<name>`, and the bare server name is registered as an alias (`tools/mcp_tool_registration.py:358-399`).
  - A name that collides with a built-in tool is skipped, not overridden (`tools/mcp_tool_registration.py:371-383`).
  - The resource and prompt utility tools are registered only if the server advertises those capabilities (`tools/mcp_tool_registration.py:185-213`). A tools-only finance server adds no extra tools.
  - Availability is checked at call time: tools are offered only while the server is connected (`tools/mcp_tool_handlers.py:846-867`, `tools/registry.py:922-950`).
- **Dispatch [read].**
  - The call path is `model_tools.handle_function_call` to `_execute_tool` to `registry.dispatch` (`model_tools.py:836-860`, `886-983`, `tools/registry.py:972-1000`), then to the MCP handler (`tools/mcp_tool_handlers.py:692-747`).
  - Rendering (`tools/mcp_tool_handlers.py:651-689`):
    - a normal result becomes `{"result": "<text>"}`;
    - `structuredContent` is added unless it duplicates the text;
    - non-reserved `_meta` is passed through;
    - `isError` becomes `{"error": "..."}`.
  - Default tool timeout is 300 s, overridable per server with `timeout` (`tools/mcp_tool_common.py:41-58`). The example config says 120 (`cli-config.yaml.example:1636`); that comment is stale.
  - Calls to one server are serialised unless `supports_parallel_tool_calls: true` (`tools/mcp_tool_discovery.py:385-393`, `814-821`).
  - With the default `trust: full` there is no approval gate. `trust: untrusted` gates any tool not marked read-only (`tools/mcp_tool_handlers.py:123-147`).
- **Circuit breaker [read].**
  - Every error payload counts as a strike, including the tool's own `isError` result (`tools/mcp_tool_handlers.py:273-280`).
  - Three strikes in a row open the breaker for 60 s for the whole server (`tools/mcp_tool.py:516`, `tools/mcp_tool_handlers.py:211-229`). During that time every call returns a "rejected the last N calls … Paused" error.
  - Domain validation errors reported as `isError` will therefore change agent behaviour in Hermes only.
- **Result size [read].** MCP results over 50,000 characters spill to a file with a preview (`tools/budget_config.py:13-20`). There is a hard cap of 2,000,000 characters (`tools/mcp_tool_content.py:25`). Finance results should stay far below both.

### Headless enablement through the `AIAgent` constructor

- **The parameter exists [read].** `AIAgent(enabled_toolsets=..., disabled_toolsets=...)` (`run_agent.py:243`) feeds `_select_tool_names` (`model_tools.py:333-358`).
- **Server names are valid toolset names [read, ran].** `validate_toolset` accepts registry-only toolsets and aliases (`toolsets.py:494-496`), and `get_toolset` resolves both (`toolsets.py:274-315`).
  - After registering a fake `mcp-fin` tool and the alias `fin`, the probe got `validate_toolset("fin") == True` and `resolve_toolset("fin") == ["mcp__fin__amortize"]`.
  - So `enabled_toolsets=["fin"]` and `enabled_toolsets=["mcp-fin"]` are equivalent.
- **Name clashes with built-in toolsets [read].** A server named like a built-in toolset (for example `memory`) is merged into that toolset (`toolsets.py:297-302`). Use a distinct server name.
- **Precedent in Hermes's own tests [read; not run].** One test builds `AIAgent(model=..., provider="openai", api_key="unused-test-key", base_url="http://127.0.0.1:9/v1", enabled_toolsets=["deadline-probe"], quiet_mode=True, skip_context_files=True, skip_memory=True)` around a runtime-registered toolset (`tests/agent/test_mcp_execution_deadline.py:31-38`). That is the same headless shape a harness would use.

Minimal headless shape. This is illustrative and was **not run**.

```yaml
# $HERMES_HOME/config.yaml (one home per trial)
mcp_servers:
  fin:
    command: /abs/path/.venv/bin/python   # absolute path: avoids the launcher rewrite and the OSV lookup
    args: ["-m", "finance_mcp", "--ledger", "/trial/ledger.json"]
    env: {FIN_TRIAL_ID: "t-001"}          # the child env is filtered; pass what the server needs here
    timeout: 60
tools:
  tool_search:
    enabled: "off"                        # otherwise fin tools hide behind tool_search/tool_call
```

```python
from tools.mcp_tool_discovery import discover_mcp_tools   # or register_mcp_servers({"fin": {...}})
from run_agent import AIAgent
discover_mcp_tools()
agent = AIAgent(base_url=..., api_key=..., model=..., enabled_toolsets=["fin"], quiet_mode=True,
                skip_context_files=True, skip_memory=True,
                tool_start_callback=on_start, tool_complete_callback=on_complete)
result = agent.run_conversation(task)   # dict with "messages", "final_response", "completed", "api_calls"
```

The `run_conversation` return keys are taken from how `main()` reads them (`run_agent.py:1536-1555`).

### Tool Search: the default that breaks schema parity

- **What it does [read].** `tools.tool_search.enabled` defaults to `"auto"` (`hermes_cli/config_defaults.py:1976-1984`). It activates whenever any deferrable tool exists (`tools/tool_search.py:204-213`).
  - Every MCP tool is deferrable, and so is any tool that is neither core nor a GUI tool, which includes plugin and runtime-registered tools (`tools/tool_search.py:150-162`).
  - When active, deferred tools are removed from the model's tool array and replaced by `tool_search`, `tool_describe` and `tool_call`, with a name and description listing embedded in the bridge description (`tools/tool_search.py:344-380`, `model_tools.py:536-554`).
- **How to turn it off [read].** It is read from config `tools.tool_search` (`tools/tool_search.py:113-126`). A YAML `off` or `false` both normalise to off (`tools/tool_search.py:88-94`).
- **Trace effect while on [read].** The bridge call has the shape `tool_call` with `{"calls": [{"name": "mcp__fin__amortize", "arguments": {...}}]}` (`tools/tool_search.py:307-327`). The executor unwraps it so that hooks, callbacks and guardrails see the underlying tool. The transcript keeps `tool_call` (`agent/tool_executor.py:390-432`).

### How MCP calls surface in callbacks and messages

All of this is **[read]**; none of it was exercised end to end.

- **Callbacks.**
  - `tool_progress_callback("tool.started", name, preview, display_args)` and `tool_start_callback(tool_call_id, name, display_args)` (`agent/tool_executor.py:1029-1030`).
  - `tool_complete_callback(tool_call_id, name, display_args, result)` (`agent/tool_executor.py:1055`).
  - `tool_progress_callback("tool.completed", name, None, None, duration=..., is_error=..., result=...)` (`agent/tool_executor.py:1171-1172`).
  - MCP progress notifications are relayed to `tool_progress_callback` (`tools/mcp_tool_handlers.py:717-722`).
  - `name` is the prefixed `mcp__fin__...` name. Arguments pass through display redaction first; finance arguments should be unaffected **[inferred]**.
- **Messages.**
  - The assistant row carries `tool_calls` (`agent/turn_tool_round.py:241-255`).
  - Each result row is `{"role": "tool", "name", "tool_name", "content", "tool_call_id", <timestamp>}` (`agent/tool_dispatch_helpers.py:448-479`).
  - Because the name starts with `mcp_`, content of 32 characters or more is wrapped as `<untrusted_tool_result source="mcp__fin__...">` plus a preamble telling the model to treat it as data (`agent/tool_dispatch_helpers.py:484-493`, `572-595`). This is decided by name prefix only; I found no config check.
- **Plugin hook alternative.** A `post_tool_call` plugin hook receives `tool_name`, `args`, `result`, the call IDs, `duration_ms` and `status` for every route (`model_tools.py:687-711`, `hermes_cli/plugins.py:109-110`). It could serve as a route-independent tracer.

### What is in `optional-mcps/`

- **Contents [read].** 66 directories, each holding a `manifest.yaml` that describes a vendor-hosted MCP server, for example `optional-mcps/context7/manifest.yaml`.
- **All are remote [read].** Every entry uses `transport.type: http`: 56 use OAuth and 10 use no auth. None is stdio.
- **How they are used [read].** `hermes mcp install <name>` writes an `mcp_servers.<name>` block (`hermes_cli/mcp_catalog.py:540`, `829-831`, `website/docs/user-guide/features/mcp.md:58-110`).
- **Relevance [inferred].** None for the finance tools, except as a format reference.

---

## Plugins

- **Mechanism [read].** The general plugin manager is `hermes_cli/plugins.py`.
  - It discovers plugins from four sources, later ones overriding earlier ones (`hermes_cli/plugins.py:1-9`, `hermes_cli/plugins_discovery.py:190-219`):
    - bundled `plugins/<name>/`;
    - `$HERMES_HOME/plugins/<name>/`;
    - `./.hermes/plugins/<name>/`, only with `HERMES_ENABLE_PROJECT_PLUGINS`;
    - pip entry points in group `hermes_agent.plugins` (`hermes_cli/plugins_discovery.py:29`).
  - A directory plugin needs `plugin.yaml` and an `__init__.py` with `register(ctx)`.
  - `plugins/plugin_loader.py` is a separate loader for category providers (memory, context engine, cron), not for general tools (`plugins/plugin_loader.py:1-4`).
- **Registering tools [read].** `ctx.register_tool(name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False, description="", emoji="", override=False)` (`hermes_cli/plugins.py:463-500`).
  - It writes into the same registry MCP uses.
  - Overriding a built-in requires `override=True` plus the operator opt-in `plugins.entries.<id>.allow_tool_override` (`tools/registry.py:764-799`).
  - A plugin can also register hooks such as `pre_tool_call` and `post_tool_call` (`hermes_cli/plugins.py:109-110`, `plugins/AGENTS.md:84-91`).
- **Opt-in gate [read].** A non-bundled plugin loads only if its key or name is listed in `plugins.enabled` in `config.yaml` (`hermes_cli/plugins_discovery.py:320-324`). Entry-point plugins need the same opt-in (`tests/hermes_cli/test_plugins.py:447-449`).
- **Installing into `HERMES_HOME` [read].** There are two ways.
  - **By hand**: copy the directory to `$HERMES_HOME/plugins/<name>/` and add the name to `plugins.enabled`. Hermes's own fixture does exactly this (`tests/hermes_cli/test_plugins.py:48-110`).
  - **By command**: `hermes plugins install <owner/repo|git url|catalog name>`, which clones and then runs a security scan (`hermes_cli/plugins_cmd_install.py:396-445`, `hermes_cli/plugins_cmd.py:191-229`).
- **When discovery runs [read].**
  - On `model_tools` import (`model_tools.py:163-164`) and again at every agent build (`agent/agent_init.py:1017-1022`).
  - It is memoised; a mid-run change needs `discover_plugins(force=True)` (`plugins/AGENTS.md:92-99`).
- **Loading [read].**
  - The plugin is imported as `hermes_plugins.<slug>` (`hermes_cli/plugins_loader.py:772-819`).
  - Default `plugins.isolation` is `in_process` (`hermes_cli/config_defaults.py:1721`). The `host` mode runs non-bundled plugins in a child process behind tool proxies (`hermes_cli/plugin_isolation.py:1-30`, `96-106`).
- **`plugin-catalog/` [read].** 977 files: one YAML per curated third-party plugin, plus `README.md` and `removed.yaml`.
  - Each entry is pinned to a 40-character commit SHA and admitted by human review (`plugin-catalog/README.md`, `plugins/AGENTS.md:63-80`).
  - Entries install through `hermes plugins install <name>`. Nothing in the catalog is needed for the finance tools.
- **Usable unmodified? Yes [read; not run].** The plugin is our code living in `HERMES_HOME`. Two costs follow:
  - The tool schemas are declared a second time in the plugin, unless they are generated from the same source as the MCP server.
  - Plugin tools are still deferred by Tool Search unless it is off (`tools/tool_search.py:150-162`).
- **Trace [read; inferred].** The registered name is bare, for example `amortize`. Results are not wrapped as untrusted (no `mcp_` prefix).

---

## Toolset registry and runtime registration

- **Static toolsets [read].** `TOOLSETS` in `toolsets.py:71-241` maps a name to `tools` and `includes`. `BUILTIN_TOOL_NAMES` is captured before any runtime addition (`toolsets.py:248`).
- **Tool registry [read].** A process-wide singleton, `tools.registry.registry` (`tools/registry.py:1094`).
  - Built-in tools self-register on import. Only `tools/*.py` and `tools/<pkg>/tool.py` inside the package are scanned (`tools/registry.py:112-175`).
  - No directory under `HERMES_HOME` is scanned for tools, apart from the plugin mechanism above. The only `HERMES_HOME` artefact is a verdict cache at `cache/tool_discovery_cache.json` (`tools/registry.py:178-185`).
- **Runtime registration from outside the package [read, ran].**
  - Call `registry.register(name, toolset, schema, handler, check_fn=None, ..., execution_timeout=None)` (`tools/registry.py:735-812`). A toolset that does not exist yet becomes a "registry-only" toolset that `get_toolset`, `resolve_toolset` and `validate_toolset` all recognise (`toolsets.py:274-315`, `363-407`, `494-496`).
  - `create_custom_toolset(name, description, tools, includes)` adds composite toolsets (`toolsets.py:499-501`).
  - The probe registered `fin_amortize` in toolset `finance` and got:
    - `validate_toolset("finance") == True`;
    - `resolve_toolset("finance") == ["fin_amortize"]`;
    - a description of `"Plugin toolset: finance"`;
    - `registry.dispatch` returned the handler's JSON, with the handler receiving keyword arguments `task_id` and `session_id`. Keyword arguments are filtered to the handler's signature (`tools/registry.py:1112-1122`).
  - Re-registering the same name under another toolset was rejected with a log message, as the code says (`tools/registry.py:792-799`).
  - Handlers must return a string or the multimodal envelope (`tools/registry.py:955-970`).
- **Stability [read; inferred].** `tools.registry` is an internal module, not a documented embedding API. `plugins/AGENTS.md:166-172` says internal import paths are not API, and old paths have already been removed once. Hermes's own tests do use this pattern (`tests/agent/test_mcp_execution_deadline.py:31-38`).
- **What `enabled_toolsets` accepts [read].**
  - `None`: every toolset except platform-gated ones (`model_tools.py:345-347`).
  - Static names (`toolsets.py:71-241`).
  - `"all"` or `"*"` (`toolsets.py:382-387`).
  - Registry toolsets, meaning plugin, runtime and `mcp-<server>` toolsets, plus MCP aliases (`toolsets.py:274-315`, `410-416`).
  - Legacy `*_tools` names (`model_tools.py:179-188`).
  - Unknown names are skipped. A warning is printed only when `quiet_mode` is off (`model_tools.py:324-326`).
- **What `disabled_toolsets` does [read].**
  - It is subtracted last (`model_tools.py:353-358`).
  - For a `hermes-*` bundle or posture name, only the tools beyond the core set are removed (`model_tools.py:300-330`).
  - The agent adds platform-gated toolsets to the disabled list, and in one-shot sessions also `clarify` (`toolsets.py:455-466`, `agent/oneshot_footprint.py:28`).

---

## Terminal tool fallback

All of this is **[read]**; the terminal tool was not run.

- **Schema** (`tools/terminal_tool.py:1614-1675`).
  - `command` is required.
  - Optional: `background`, `timeout` (an integer of at least 1), `workdir`, `pty`, `notify`, `heartbeat`, `persist_on_release`.
  - It is registered in toolset `terminal` with `max_result_size_chars=100_000` (`tools/terminal_tool.py:1747-1755`). The `terminal` toolset also contains `process_manage` (`toolsets.py:99`).
  - `terminal` is a core tool, so Tool Search never defers it (`toolsets.py:11-13`, `tools/tool_search.py:157-158`).
- **Result format** (`tools/terminal_tool_result.py:207-278`). The tool message content is a JSON string:
  - `{"output": "...", "exit_code": N, "error": null}`;
  - optionally `cwd`, `full_output_path`, `output_total_chars`, `truncation_note`, `exit_code_meaning`, `hint` and `approval`.
  - The local backend merges stderr into stdout (`tools/environments/local.py:1149`). The trace cannot tell the two streams apart.
- **Processing.**
  - Output is truncated head-and-tail to `tool_output.max_bytes`, default 50,000 characters: 40% from the head, 60% from the tail, with a marker in between (`tools/tool_output_limits.py:13`, `tools/tool_output_truncate.py:76-96`, `tools/terminal_tool_result.py:151-154`).
  - ANSI codes are stripped and secrets redacted (`tools/terminal_tool_result.py:233-243`).
  - `exit_code_meaning` and `hint` give the model a plain-language reading of failures.
- **Timeouts.**
  - Default 180 s (`TERMINAL_TIMEOUT`, `tools/terminal_tool.py:854`). Foreground commands are capped at 600 s (`tools/terminal_tool.py:78`); longer requests are promoted to background with a note (`tools/terminal_tool.py:1241-1286`).
  - A backend timeout returns exit code 124 with "Command timed out after N seconds" (`tools/terminal_tool.py:1377-1380`).
- **Approval.**
  - Dangerous-pattern commands go through an approval gate.
  - In a plain headless process (not interactive, not gateway, not `-q`) they are auto-approved with a warning (`tools/approval.py:1006-1042`). Hardline commands and user deny rules are still blocked (`tools/approval.py:1084-1100`).
  - In `-q` sessions the default is deny (`hermes_cli/config_defaults.py:1667`).
  - A finance CLI should never trip this gate **[inferred]**.
- **Trace quality.**
  - The assistant row shows `terminal` with `{"command": "fincalc amortize --principal 10000 ..."}`. The domain operation and its arguments must be parsed out of a shell string.
  - The schema the model sees is the generic terminal schema, not the finance schema, so cross-harness schema parity is lost by construction.
  - The model can also run arbitrary shell commands, for example editing the ledger file directly, so tool-boundary scoring is weaker.
  - Callbacks fire as for any tool, with `name="terminal"`.

---

## Skills route

All of this is **[read]**; no skill was loaded.

- **Where skills live.** `$HERMES_HOME/skills/<category>/<name>/SKILL.md`: YAML frontmatter (`name`, `description`, `platforms`, `metadata.hermes.*`) plus a Markdown body. Optional `scripts/`, `references/` and `templates/` folders sit alongside (`tools/skills_tool.py:1-5`, `88-97`, `skills/AGENTS.md:16-21`).
- **Conditional display.** The frontmatter can say when to show the skill: `requires_tools`, `requires_toolsets`, `fallback_for_*` and `session_platforms` (`agent/skill_utils.py:735-743`, `agent/prompt_builder.py:1169-1186`).
- **How a skill is invoked.**
  - The system prompt carries a skills index: name plus a description of at most about 60 characters per skill (`agent/prompt_builder.py:1233`, `1299-1340`).
  - The model loads a skill by calling `skill_view(name, file_path?)` (`tools/skills_tool.py:733-786`) and can list skills with `skills_list` (`tools/skills_tool.py:718-756`).
  - All three skill tools (`skills_list`, `skill_view`, `skill_manage`) are in toolset `skills` (`toolsets.py:100-104`). `skill_manage` lets the agent edit skills.
- **How it is traced.** A normal tool call `skill_view {"name": "fincalc"}` with JSON content, followed by whatever terminal calls the skill describes. Viewing a skill bumps `$HERMES_HOME/skills/.usage.json` (`tools/skills_tool.py:758-781`, `tools/skill_usage.py:1`, `52`).
- **Verdict.** A skill can teach the agent to use a CLI correctly, but it adds no tool and no schema. It is only a companion to the terminal route. It also adds system-prompt text that the other harnesses would not get, unless the same text is given to all five.

---

## Route comparison

| Route | Works unmodified at `6112c2a` | Setup | Trace appearance | Risks |
| --- | --- | --- | --- | --- |
| **MCP server** (shared by all harnesses) | Yes **[read]**. Not run end to end. | Install Hermes with `[mcp]`. Declare `mcp_servers.fin` in a per-trial `$HERMES_HOME/config.yaml` (absolute `command` path, ledger via `args`/`env`), or call `register_mcp_servers`. Call `discover_mcp_tools()` before `AIAgent(...)`. Pass `enabled_toolsets=["fin"]`. Set `tools.tool_search.enabled: "off"`. | Tool calls named `mcp__fin__<tool>`. Result content `{"result": "..."}` (or `{"error": ...}`) inside an `<untrusted_tool_result>` wrapper. Callbacks fire with the prefixed name. | Prefixed names and normalised schemas differ from other harnesses. The untrusted wrapper has no config switch found. Tool Search hides tools by default. Breaker pauses the server after 3 consecutive error results. Calls are serialised unless opted in. Discovery is the caller's job. Bare `npx`/`uv`/`uvx` rewriting and OSV network lookup. Filtered child env. |
| **Plugin** (`$HERMES_HOME/plugins/fin/`, or a pip entry point) | Yes **[read]**. Not run. | `plugin.yaml` plus `__init__.py` with `register(ctx)` calling `ctx.register_tool(...)` for each tool. Add `plugins.enabled: [fin]`. Pass `enabled_toolsets=["<toolset>"]`. Set Tool Search off. | Bare registered names. Raw handler JSON, not wrapped. Same callbacks. | Schemas declared a second time unless generated from one source. Runs inside the Hermes process. Tool Search defers it by default. Discovery is memoised. |
| **Runtime registration** (`tools.registry.registry.register` from the harness process) | Yes **[ran]** for the registry, toolset resolution and dispatch. Not run through `AIAgent`. | Register the tools before constructing `AIAgent`. Pass `enabled_toolsets=["<toolset>"]`. Set Tool Search off. | Same as plugin. | Internal API (`plugins/AGENTS.md:166-172`) that can break on a SHA bump. Same schema-duplication and deferral risks as the plugin route. |
| **CLI through `terminal`** | Yes **[read]**. Not run. | CLI on `PATH` or called by absolute path. Pass `enabled_toolsets=["terminal"]`. CLI usage described in the task prompt or a skill. | `terminal {"command": "..."}`. Result `{"output", "exit_code", ...}` with stdout and stderr merged. | Schema parity lost. Operation identity lives in a string. 50,000-character truncation. 180 s default timeout. Open shell (model can bypass the CLI or edit the ledger). Also exposes `process_manage`. |
| **Skill** (plus terminal) | Yes, as instructions only **[read]**. Not run. | `$HERMES_HOME/skills/finance/fincalc/SKILL.md`. Pass `enabled_toolsets=["terminal", "skills"]`. | Skills index in the system prompt, a `skill_view` call, then terminal calls. | Adds no tools. Extra prompt text other harnesses do not get. Model may skip loading the skill. `skill_manage` lets the agent edit skills. Writes usage telemetry. |

---

## Open questions

These need a decision from Rishi; none is settled here.

1. **Name parity.** Accept `mcp__fin__<tool>` in Hermes only, or give all five harnesses identical prefixed names?
2. **Tool Search.** Turn it off for schema parity, or leave the default on to evaluate "Hermes as shipped"?
3. **Untrusted wrapper.** I found no switch. Record it as a known limit of the MCP route, or use the plugin or runtime route to avoid it, which brings its own differences?
4. **Domain errors.** Should the finance server report validation errors as MCP `isError`, which counts toward the 3-strike breaker, or as normal results carrying an error field?
5. **stdio or HTTP for the shared server.** stdio gives one server process per Hermes process, which isolates the ledger per trial. HTTP shares one server and needs a per-trial ledger key.
6. **Per-trial `HERMES_HOME`.** Running each trial in its own home looks necessary to isolate the discovery lock, schema cache, MCP stderr log, plugin state and skill usage files **[inferred]**.

Things I could not determine:

- **[unknown]** Whether a headless agent refreshes MCP tools between turns. There is a refresh call in `agent/turn_context.py:570-572`, but I did not read its conditions. `agent/conversation_loop.py:775-800` refreshes only under a gateway policy or on desktop/TUI platforms.
- **[unknown]** The exact message and callback sequence for an MCP call, which was not exercised. The next step is a test using the project's fake LLM server, with the `mcp` extra installed, that asserts the shapes described above.

Doc discrepancies to copy into `docs/hermes-notes.md`:

- The user guide gives the name prefix as `mcp_<server>_<tool>`; the code uses `mcp__<server>__<tool>`.
- The example config gives the MCP tool timeout default as 120 s; the code uses 300 s.
