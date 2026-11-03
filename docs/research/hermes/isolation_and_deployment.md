# Hermes isolation and deployment audit

Pinned commit: `6112c2adb9e11f69734a29be9d2696f345ffa06a` (2 Nov 2026).
Scope: what it takes to run Hermes headless, isolated per trial, against a LiteLLM proxy, without leaking keys or state.
Feeds the open decision: container per trial versus process per trial with a fresh `HERMES_HOME`.

## How this was done

- **Read only.** The checkout was not modified. No Hermes code was executed. No LLM call, no API key, no docker.
- **One measurement outside Hermes:** `python3.14 -I -c 'import sqlite3; print(sqlite3.sqlite_version)'` on this machine printed `3.53.1`. And `sys.flags.thread_inherit_context` on the local Python 3.14.10 is `0`.
- Every citation is `path:line` relative to the Hermes repo root.
- Each finding is tagged:
  - **[V]** verified by reading the code at the cited lines.
  - **[I]** inferred: follows from the code, or from Linux / Python / uv behaviour, but not traced end to end or run.
  - **[?]** could not determine.
- The repo has about 80 files with direct HTTP calls, mostly under `hermes_cli/` (CLI, dashboard, auth flows). I traced the ones reachable from `AIAgent` construction and `run_conversation` with the `file` and `terminal` toolsets. The network table is complete for that path as far as I could trace it. It is not a full audit of every CLI command.

---

## 1. Install footprint

### Python version

- `requires-python = ">=3.11,<3.15"` (`pyproject.toml:15`). The comment above it says only 3.14 is supported, and the range exists so old installs can still run their updater (`pyproject.toml:10-14`). [V]
- Every core dependency has the marker `python_version >= '3.14'` (`pyproject.toml:40-223`). On 3.11 to 3.13 the install succeeds but pulls in **no** core dependencies, and Hermes fails at import. [V for the markers, I for the failure]
- `uv.lock` supports `python_full_version >= '3.14'` only (`uv.lock:8-10`), and `[tool.uv] environments` is 3.14 only (`pyproject.toml:634`). [V]
- PM pins CPython `3.14.9+20261021` (`pm/lock.json:512-551`). The installer takes its Python version from that pin (`setup-hermes.sh:106`). [V]
- **In practice Python 3.14 is required.** [V]

### Supported install path

- Wheel and sdist builds are blocked outside Nix (`setup.py:1-25`, `setup.py:34-74`). The same guard says editable installs (`uv sync`, `pip install -e .`) are allowed (`setup.py:22-24`). [V]
- The official path is `setup-hermes.sh`. It stages a pinned uv, installs Python, then runs `python -m pm.cli install` (`setup-hermes.sh:160-185`). It states there is no pip fallback on purpose (`setup-hermes.sh:13`). [V]
- The Docker image uses `python -m pm.build_env ... --sealed --extra all ...` (`Dockerfile:301-305`). [V]
- Bundled assets (skills, locales, plugin manifests) are found through the source-checkout layout, not through package data (`setup.py:4-8`). An editable install against the pinned checkout is therefore the natural fit. [V for the docstring, I for "natural fit"]
- **For us:** `uv sync --frozen --no-dev` with `UV_PROJECT_ENVIRONMENT` pointing outside the checkout, so the checkout stays clean. `default-groups = []` (`pyproject.toml:630`) means the dev group is skipped anyway. `exclude-newer = "3 days"` (`pyproject.toml:679`) should not matter with `--frozen`, which installs the lock as written. [I, from uv semantics; not run]

### Core dependencies versus extras

- Core is pinned exactly (`pyproject.toml:19-33`). Core already includes `openai` (`:40`), `httpx[socks]`, `pydantic`, `rich`, `prompt_toolkit`, `croniter`, `fastapi`, `uvicorn`, `browser-harness`, `websockets`, `Pillow`, `pillow-heif` (bundles libheif), `resvg-py`, `firecrawl-anydoc` (document extraction for `read_file`), `cryptography`, `psutil`, and the native `nemo-relay` runtime on linux x86_64/aarch64 (`pyproject.toml:209-223`). [V]
- Extras are opt-in per backend. Examples: `anthropic` (`:236`), `modal` / `daytona` / `vercel` (`:266-268`), `mcp` (`:423-427`), `messaging` (`:270-278`), `voice` (`:306-315`), `otlp` (`:459-462`), `all` (`:524-555`). [V]
- **Minimal headless install = core only, no extras.** The OpenAI-compatible chat path needs only `openai`, which is in core. You would need the `anthropic` extra only for the native Anthropic provider, and `mcp` only for MCP servers. The docker terminal backend needs the `docker` CLI, not a Python extra. [V for which packages, I that core alone is enough at runtime]
- Core cannot be trimmed further without `--no-deps`, which is untested. [I]

### Size

- **Not measured.** `uv.lock` resolves 356 packages across all extras (`grep -c '^\[\[package\]\]' uv.lock`). Core is a subset of that. It carries several compiled wheels (cryptography, pydantic-core, Pillow, pillow-heif, resvg-py, nemo-relay). [V for the count]
- My guess is a core venv in the low hundreds of MB. Treat that as a placeholder until SP1 measures it. [I]

### The custom SQLite in the Dockerfile

- **What the comment says** (`Dockerfile:1-4`): Debian 13 ships SQLite 3.46.1, which has the upstream WAL-reset corruption bug, so the image builds SQLite 3.53.4 (`Dockerfile:8-45`). At build time it asserts that the linked version is at least 3.51.3 (`Dockerfile:104-119`). [V]
- **What the code does without it:**
  - `is_sqlite_wal_reset_vulnerable` marks as vulnerable anything outside `>=3.51.3`, `3.50.7–3.50.x` and `3.44.6–3.44.x` (`hermes_cli/sqlite_runtime.py:23-30`). [V]
  - On a vulnerable build, Hermes never turns WAL on for a new `state.db` and uses `journal_mode=DELETE` instead (`hermes_state_wal.py:254-276` docstring, `:303-304`, `:450-485`). The docstring also notes it re-measured on a "bundled 3.50.4" (`hermes_state_wal.py:254-276`). [V]
- **What it means for us:**
  - The WAL-reset bug needs several connections writing to and checkpointing one WAL database. With **one Hermes process per `HERMES_HOME`**, nothing shares a `state.db`, so the bug cannot be hit. [I]
  - On a vulnerable SQLite the only cost is DELETE journal mode: writers block readers and writes are a bit slower. That is irrelevant at one writer. [I]
  - The local `python3.14` links SQLite 3.53.1, which is not vulnerable, so WAL would be on (measured, see top). [V for the version]
  - Which SQLite the PM-pinned python-build-standalone 3.14.9 bundles: [?]
  - **We do not need the custom SQLite build** unless several processes share one `HERMES_HOME`, which neither isolation option does. [I]

---

## 2. Connecting to LiteLLM

### The clean route: pass both `base_url` and `api_key` to the constructor

- `AIAgent.__init__` forwards to `agent.agent_init.init_agent` (`run_agent.py:236-288`, `agent/agent_init.py:2107`). [V]
- When **both** `api_key` and `base_url` are given, the client is built from them directly through `_explicit_client_kwargs` (`agent/agent_init.py:907-910`, `:733-752`). No provider discovery runs. [V]
- When either one is missing, Hermes falls back to `resolve_provider_client(agent.provider or "auto")` (`agent/agent_init.py:766-781`). That walks a long credential ladder: config, env keys, credential pools, OAuth stores, then an OpenRouter fallback (`hermes_cli/runtime_provider.py:1044-1058`). **So always pass both.** [V]
- For a custom URL the wire mode becomes `chat_completions` (`agent/agent_init.py:916-919`). There are model-based and host-based overrides in `_resolve_api_mode` (`agent/agent_init.py:294-343`). [V]
  - Whether real model names sent through LiteLLM can trip a model-based override is still open (see Open questions). [?]
- Pass `provider="custom"`. The config docs describe `custom` as "any other OpenAI-compatible endpoint" (`cli-config.yaml.example:78-117`). [V]
  - It also keeps context-length lookup off the OpenRouter catalog (see section 3, row 5). [I]
  - I did not trace what `provider=None` does end to end. [?]
- The api key is stored on the agent object (`agent/agent_init.py:931`). I saw no code that writes it back into `os.environ`. [I: absence of a write in the paths read, not a full proof]

### Env vars and config keys Hermes reads (relevant subset)

| Name | Where | Effect |
| --- | --- | --- |
| `HERMES_HOME` | `hermes_constants.py:194-200`, `:244-252` | State root. Default `~/.hermes` (`hermes_constants.py:64`). [V] |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | `hermes_cli/auth.py:177` (the `openai-api` provider) | Used only by provider resolution. Also on the terminal scrub list. [V] |
| `OPENROUTER_API_KEY` | `cli-config.yaml.example:113-117`; scrub list `tools/environments/local_env_policy.py:21` | Fallback key for the default OpenRouter route. [V] |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | scrub list `local_env_policy.py:21-22`; native client `agent/agent_init.py:658-693` | Native Anthropic path only. [V] |
| `AUXILIARY_<TASK>_API_KEY` / `_BASE_URL` | `local_env_policy.py:317-326` | Per-task side-LLM credentials (compression, vision and so on). [V that they exist and are scrubbed; where they are read: ?] |
| `TERMINAL_ENV`, `TERMINAL_CWD`, `TERMINAL_*` | `tools/terminal_tool.py:813-881`; config bridge `hermes_cli/config.py:2014-2026` | Terminal backend, cwd, timeouts, docker options. Read from the **process env**. [V] |
| `HERMES_TIMEZONE` | `hermes_time.py:3-5`, `:67-105` | Timezone in the prompt. Falls back to config `timezone`, then server local time. [V] |
| `HERMES_ENVIRONMENT_HINT` | `agent/prompt_builder.py:1007-1011` | Free text that we control, appended to the prompt's environment block. [V] |
| `HERMES_WRITE_SAFE_ROOT` | `agent/file_safety.py:223-229`, `:309-311` | Restricts file-tool **writes** to the listed roots. [V] |
| `HERMES_YOLO_MODE` | `tools/approval.py:44-46` | Read once at import. Bypasses approvals. [V] |
| `HERMES_INTERACTIVE` | `tools/approval_context.py:48-51` | Marks a human as present. **Must stay unset headless** (section 4). [V] |
| `HERMES_STARTUP_WATCHDOG` | `hermes_startup_watchdog.py:19-26` | Only matters for CLI and gateway (section 5). [V] |

- Config keys in `HERMES_HOME/config.yaml`: `model.default`, `model.provider`, `model.base_url`, `model.api_key`, `model.context_length` (`cli-config.yaml.example:78-117`). Also `terminal.*`, `timezone`, `agent.environment_probe`, `agent.environment_hint`, `memory`, `skills`, `approvals` (defaults `mode: smart`, `timeout: 300`, `hermes_cli/config_defaults.py:1663-1664`), and `shared_metrics` (both flags false by default, `hermes_cli/config_defaults.py:2323-2327`). [V for the defaults shown]

### Import-time side effect

- Importing `run_agent` loads `HERMES_HOME/.env` **and the `.env` in the Hermes checkout directory** into `os.environ` (`run_agent.py:95-97`). The user `.env` overrides shell values (`hermes_cli/env_loader.py:652-735`). [V]
- **Neither file may exist in our setup**, or keys get injected into the process env, and from there into the agent's shell if their names are not on the scrub list. [I]

---

## 3. Outbound network call sites

Path traced: `AIAgent(base_url=<LiteLLM>, api_key=..., provider="custom", enabled_toolsets=["file","terminal"])`, then `run_conversation`.

| # | Call site | Destination | When it fires | Bypasses `base_url`? | How to stop it |
| --- | --- | --- | --- | --- | --- |
| 1 | Main client `agent/agent_init.py:927` (built at `:907-930`) | `{base_url}/chat/completions` | Every model turn | No | n/a [V] |
| 2 | `fetch_endpoint_model_metadata` `agent/model_metadata.py:1027-1060`, reached from `:2288-2290` → `:2052-2054` → `:1086-1095` | `GET {base_url}/models` | First time the context length is needed. This is lazy (`agent/context_compressor.py:2187-2195`, `:2877`) | No: same host, different path | Pin `model.context_length`, which returns early at `agent/model_metadata.py:2221-2223`. Note that `_scope_context_length_to_default_runtime` drops the pin if the model or route differs from config (`agent/agent_init.py:1606-1650`), so set `model.default` and `model.base_url` to match. [V for the code; I that this suppresses the probe in our config] |
| 3 | `detect_local_server_type` `agent/model_metadata.py:723-770`, GETs at `:754-761` | `{root}/api/v1/models`, `/api/tags`, `/v1/props`, `/props`, `/version` | Only if `base_url` counts as **local** (loopback, RFC 1918, a dotless host such as a compose service name `litellm`: `agent/model_metadata.py:681-706`) and `/models` gave no context length (`:2059`) | No: same host, odd paths | Same as row 2 [V] |
| 4 | `_query_ollama_api_show` `agent/model_metadata.py:1410-1415`, via `:2064-2067` and `:2185-2190` | `POST {root}/api/show` | Same as row 3, and also for non-local custom endpoints (`:2063`) | No: same host | Same as row 2 [V] |
| 5 | `fetch_model_metadata` `agent/model_metadata.py:899-915`; URL `hermes_constants.py:1313` | `GET https://openrouter.ai/api/v1/models` | (a) OpenRouter prewarm thread, only when provider is openrouter (`agent/agent_init.py:422-427`). (b) Context steps 5f and 6 (`agent/model_metadata.py:2194`, `:2306-2307`), not reached for a custom endpoint because step 2 returns first (`:2288-2290`). (c) Pricing estimate `agent/usage_pricing.py:516`. (d) `agent/model_metadata.py:1939` | **Yes: third party** | No switch found. Use a cache seeded at `HERMES_HOME/cache/openrouter_model_metadata.json` (`agent/model_metadata.py:206-208`), or block egress. [V for (a) and (b); whether (c) or (d) fire for a custom route: ?] |
| 6 | Auxiliary client `agent/auxiliary_client.py` (chain described at `:1-8`) | Main provider and model first (`:4484-4525`) = LiteLLM | Context compression past the threshold, vision, web extract, session search, smart approval, title generation, background review | No by default. Yes if `auxiliary.<task>.*` or `AUXILIARY_<TASK>_*` points elsewhere. When the main provider is set but unavailable, the discovery chain refuses to guess another provider (`:4530-4541`) | Title generation needs a session DB (`agent/turn_context.py:205-208`), so `session_db=None` avoids it. Background review is gated by `skip_background_review` (`agent/turn_finalizer.py:603-616`). Smart approval does not run headless (section 4). Compression is real and can fire on long trials. [V] |
| 7 | `hermes_cli/source_check.py:145` (urlopen), `:160` onward | `api.github.com` (update check) | Only from the CLI banner (`hermes_cli/banner.py:285`) and update commands (`hermes_cli/update_cmd.py:1458`, `update_cmd_check.py:72,203`) | n/a | Not on the `AIAgent` path [V by caller grep] |
| 8 | `hermes_cli/observability/shared_metrics_sender.py:106` | Nous telemetry ingest | Only if `shared_metrics.enabled` and `send` are both true (defaults false, `hermes_cli/config_defaults.py:2323-2327`). Caller `hermes_cli/observability/relay_shared_metrics.py:1307`. Consent prompt skipped when non-interactive (`shared_metrics_consent.py:178`) | n/a | Keep the defaults [V] |
| 9 | Skills hub `tools/skills_hub*.py` (GitHub, skills.sh, clawhub) | Third party | Only when the skills hub tool or CLI is used. Bundled skill sync is a local copy, called only from CLI paths (`hermes_cli/main.py:1046,1620,2593`, `hermes_cli/setup_quick.py:261`, `hermes_cli/main_tui_launch.py:632`) | n/a | Leave the skills hub toolset out [V for the callers] |
| 10 | MCP `tools/mcp_tool_*.py` | Configured servers | Only if `mcp_servers` is configured | n/a | Configure none [V that discovery is config-driven, `tools/mcp_tool_discovery.py:539-559`] |
| 11 | Docker backend `docker pull` `tools/environments/docker.py:1000-1011` | Image registry | `TERMINAL_ENV=docker` with an image not present locally | n/a | Pre-pull or build locally [V] |
| 12 | Plugin discovery `agent/agent_init.py:1019-1020`; plugin update fetch `hermes_cli/plugins_updates.py:463` | ? | Discovery runs at every agent build. The update fetch appears to be on CLI paths only | ? | [?] whether discovery itself touches the network |
| 13 | Lazy installs `tools/lazy_deps.py:1-16` | none | That module is now a shim that raises `ImportError`, so it installs nothing at runtime | n/a | [V for that module; other PM-driven installs not traced] |
| 14 | Provider-specific: `agent/anthropic_credentials.py:436`, `agent/account_usage.py:604,808,881`, Nous auth | Provider APIs | Only for those providers | n/a | Not reached with `provider="custom"` [I] |

Also seen, and local only:

- The env probe runs `python3`, `python`, `pip` and `uv` (`tools/env_probe.py:131-139`). [V]
- The git workspace probe runs `git -C <cwd> status/branch` (`agent/coding_context.py:434-441`). [V]
- Hermes patches urllib3 connects for Happy Eyeballs (`hermes_bootstrap.py:1-13`). That changes how it connects, not what it connects to. [V]

**Net:**

- With an explicit `base_url` and key, `provider="custom"`, `session_db=None`, `skip_background_review=True` and only `file` and `terminal` enabled, every LLM call I found goes to the LiteLLM host. [I]
- The one third-party call I could not rule out is the OpenRouter catalog through pricing (row 5 c/d).
- Rows 2 to 4 send non-chat requests to the LiteLLM host on first use. LiteLLM will log them as 404s.
- The agent's **shell** is a separate matter: on the local backend it has unrestricted network access (section 4).

---

## 4. Terminal backend and key leakage

### How the local backend spawns commands [V]

- Each command runs as `bash [-l] -c <cmd>` through `subprocess.Popen(..., env=run_env, start_new_session=True, cwd=self.cwd)` (`tools/environments/local.py:1134-1167`).
- `bash` comes from PM (`tools/environments/local.py` `_find_bash`, which calls `pm.shell.bash()`).
- The process group is owned so it dies with Hermes (`local.py:1155-1158`, `hermes_cli/process_identity.py:1015`).
- **No sandboxing at all.** There is no namespace, chroot, seccomp, rlimit or bubblewrap code in `tools/environments/local.py` (grep found none). The class itself says it runs "directly on the host" (`local.py:1039-1050`, `uses_host_filesystem = True`).
- The login invocation that snapshots the environment sources the user's rc files (`local.py:1138-1141`). Host `~/.bashrc` and `~/.profile` therefore shape the agent's environment.

### What environment the child gets [V]

- `_make_run_env` starts from **`os.environ.copy()`** merged with the backend env (`local.py:776-787`). It then filters through `_filter_secret_env` (`local.py:264-296`) and `_scrubbed_env` (`local.py:311-330`).
- The filter is a **name blocklist**:
  - A static list: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `GOOGLE_API_KEY`, `GH_TOKEN`, `MODAL_*`, `DAYTONA_API_KEY` and others (`tools/environments/local_env_policy.py:19-49`).
  - Names derived from every registered provider's `api_key_env_vars` and `base_url_env_var`, and from tool and messaging secrets in `OPTIONAL_ENV_VARS` (`local_env_policy.py:77-101`).
  - Dynamic names `AUXILIARY_*_API_KEY` / `_BASE_URL` and `GATEWAY_RELAY_*` (`local_env_policy.py:317-326`).
- Names prefixed `_HERMES_FORCE_` are a deliberate way to push a blocklisted var through (`local_env_policy.py:9-10`, `local.py:280-285`).
- **No `LITELLM*` name appears anywhere** in `hermes_cli/`, `providers/`, `agent/` or `tools/` (grep count 0). A `LITELLM_API_KEY` or `LITELLM_MASTER_KEY` in the harness env would therefore be **inherited by the agent's shell**, as would any other secret our harness holds under a name Hermes does not know. [V]
- `HOME`: on the host the child keeps the **real** `HOME`. In a container it gets `{HERMES_HOME}/home` if that directory exists (`hermes_constants.py:765-789`). `TMPDIR`, `TMP` and `TEMP` point at `HERMES_HOME/cache/scratch`, unless the caller already set a temp var (`hermes_constants.py:1035-1058`). [V]

### Can the agent's shell see the trial's key?

- **Through env:** only if the key sits in `os.environ` under an unlisted name. A key passed only as the constructor argument is not in the env. [I]
- **Through other routes on the same uid:** the shell runs as the same user as Hermes. It can:
  - `cat` `HERMES_HOME/.env` or `config.yaml`. The read denylist applies to the **file tools** only (`tools/file_tools.py:644-650`, `agent/file_safety.py:375-394`). The terminal ignores it.
  - Read `/proc/<hermes-pid>/environ` and `/proc/<pid>/cmdline`. On Linux these are readable by the same uid.
  - Reach the LiteLLM proxy over the network.
  - [I, from Linux semantics]
- **Conclusion:** on the local backend, assume anything the Hermes process can read, the agent can read too.
- The practical defences are outside Hermes:
  - A per-trial or per-run **LiteLLM virtual key with a hard budget**, so a leaked key is low value.
  - Hermes and the shell under different uids, which the local backend cannot do.
  - The docker terminal backend. [I]

### cwd [V]

- The terminal's default cwd is `TERMINAL_CWD`, otherwise the process cwd (`tools/terminal_tool.py:756-757`, `:768-780`).
- Each command then uses an explicit `workdir`, then the session's recorded cwd, then that default (`tools/terminal_tool.py:1014-1040`, `:255-282`).
- **`AIAgent(cwd=...)` does not set the terminal cwd.** It sets `agent.session_cwd`, which is used for context-file discovery and memory-provider kwargs only (`agent/agent_init.py:2161`, `:2069-2075`, `:1200-1201`). The only caller of `set_session_cwd` is `agent/skill_commands.py:605`.
- A per-task cwd can be set with `register_task_env_overrides(task_id, {"cwd": ...})` (`tools/terminal_tool.py:329-345`). That is a **process-global registry** keyed by task id.
- If `task_id` is not passed, `run_conversation` uses a fresh `uuid4` (`agent/turn_context.py:589`).

### Approvals when headless [V]

- `check_all_command_guards` (`tools/approval.py:1161-1193`) runs these checks in order:
  1. The container skip.
  2. **Hardline floor blocks**, which always apply (`:1170-1172`).
  3. YOLO, or `mode: off`.
  4. The permanent allowlist.
  5. With no CLI, gateway or ask presence, it applies any unattended-context rule (cron, single-query, unattended platform), **otherwise approves** (`:1186-1193`).
- **So headless library use auto-approves "dangerous" commands** short of the hardline list, and never calls the smart-approval LLM.
- Setting `HERMES_INTERACTIVE` would make Hermes wait up to `approvals.timeout` (300 s) for a human who never comes.
- File-tool writes to protected instruction files fail closed when no human is present (`tools/file_tools_write_guards.py:349-359`, `:403`). If a task needs the agent to edit such a file, it will be refused. Which files count is set by `_protected_instruction_config()`, which I did not trace. [?]

### Docker backend (`TERMINAL_ENV=docker`) [V unless marked]

- **Needs:** a `docker` or `podman` CLI with a reachable daemon (`tools/environments/docker.py:286-296`, `_ensure_docker_available`), and the image. The default image is `nousresearch/hermes-sandbox:desktop` (`hermes_cli/config_defaults.py:13`, `:338`), a desktop stack (see the comment at `config_defaults.py:2531`). Override with `TERMINAL_DOCKER_IMAGE`.
- **Lifecycle:** `docker run -d --init ... sleep infinity`, then one `docker exec` per command (`docker.py:1022-1037`, `:1107`).
- **Isolation it applies:**
  - `--cap-drop ALL` plus `DAC_OVERRIDE`, `CHOWN` and `FOWNER`, and `no-new-privileges` (`docker.py:328-334`, `:400-410`).
  - tmpfs `/tmp` and `/var/tmp`.
  - CPU 1, memory 5120 MB and disk 51200 MB by default, when cgroup delegation allows (`tools/terminal_tool.py` config lines 12-14 of `_get_env_config`; `docker.py:814-821`, `:452-470`).
  - A pids limit (`docker.py:336-345`).
- **Env:**
  - Only `docker_env`, `docker_forward_env` and skill or config passthrough names are forwarded.
  - Passthrough names still go through the provider blocklist. `docker_forward_env` is an explicit opt-in that bypasses it (`tools/environments/remote_common.py:23-60`).
  - Values go in name-only (`-e KEY`), so they do not appear in argv (`docker.py:539-542`, `:786-812`).
  - **Provider keys do not reach the container unless we forward them.**
- **Network:** **on** by default (`hermes_cli/config_defaults.py:358`). Set `TERMINAL_DOCKER_NETWORK=false` for `--network=none`.
- **Mounts:**
  - Persistent mode bind-mounts `HERMES_HOME/sandboxes/docker/<task>/{home,workspace}` to `/root` and `/workspace` (`docker.py:905-916`, `tools/environments/base.py:187-193`).
  - Non-persistent mode uses tmpfs (`docker.py:917-919`).
  - The host cwd is mounted only if `docker_mount_cwd_to_workspace` is set (`tools/terminal_tool.py:768-789`).
  - Credential files, skill dirs and cache dirs are mounted read-only (`docker.py:545-572`).
- **Reuse defaults are wrong for trials:**
  - `container_persistent` defaults to `true` (`tools/terminal_tool.py:871`), described as "ONE long-lived container shared across sessions" (`:421-423`).
  - `docker_persist_across_processes` also defaults to `true` (`:881`). The backend reattaches to an existing labelled container (`docker.py:755-782`). The reuse fingerprint covers image, mounts and `hermes_home` (`docker.py:159-176`).
  - For trials set `TERMINAL_CONTAINER_PERSISTENT=false` and `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES=false`.
- **Other effects:**
  - File tools act inside the container. `DockerEnvironment` keeps `uses_host_filesystem = False` (`tools/environments/base.py:282`, `tools/file_tools_paths.py:23`).
  - Dangerous-command guards are skipped when no host path is mounted (`tools/approval.py:1051-1056`).
  - The prompt's environment block becomes a probe of the container's OS and kernel instead of host paths (`agent/prompt_builder.py:1014-1020`, `:973-985`).
- **What docker does not isolate:** the Hermes process itself stays on the host, holds the docker socket (root-equivalent on the host), and keeps its state in the host `HERMES_HOME`. [I]

---

## 5. File tools

- **No read root.** [V]
  - Absolute paths resolve anywhere.
  - Relative paths resolve against the task's workspace root, in this order: the session's cwd record, then a registered task cwd override, then `TERMINAL_CWD`, then the process cwd as a last resort (`tools/file_tools_paths.py:131-144`, `:262-278`).
- **Read denylist** (`agent/file_safety.py:375-394`, applied at `tools/file_tools.py:644-650`) [V]:
  - Hermes-internal files: `auth.json`, `state.db`, `HERMES_HOME/.env`, `mcp-tokens/`, `browser-profile/`, `vault/`, `webapp/`.
  - Project `.env` files anywhere on disk.
  - Search results that hit such paths are dropped (`tools/file_tools.py:235`, `:1108-1115`).
- **Write guards** [V]:
  - Hard deny on `/etc/`, `/boot/`, `/usr/lib/systemd/`, the docker socket (`tools/file_tools_write_guards.py:31-36`, `:147-170`).
  - Hard deny on `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.config/gh`, `~/.config/gcloud` (`agent/file_safety.py:211-220`).
  - Hard deny on Hermes's own `config.yaml` (`file_tools_write_guards.py:166-170`).
  - Optional `HERMES_WRITE_SAFE_ROOT` restricts writes to the listed roots (`agent/file_safety.py:223-229`, `:309-311`). Hermes's own image sets it to `/opt/data` (`Dockerfile:492`).
  - Protected instruction files and approval-required paths fail closed headless (section 4).
- **So, on the host, the agent can read outside the task workspace** with the file tools: any file the uid can read, apart from the denylist. The terminal tool has no denylist at all. [V for the file tools, I for the overall picture]
- `HERMES_WRITE_SAFE_ROOT=<workspace>` is the only built-in way to confine writes, and it covers the file tools only. [V]

---

## 6. State, locks and concurrency

### Written under `HERMES_HOME`

| What | Where | Trigger |
| --- | --- | --- |
| Skeleton dirs `cron`, `sessions`, `logs`, `logs/curator`, `memories`, `pairing`, `hooks`, `image_cache`, `audio_cache`, `skills` | `hermes_cli/config.py:564-566` | `ensure_hermes_home()` on every locked config load (`hermes_cli/config.py:2237-2238`) [V] |
| `SOUL.md`, seeded with the default persona | `hermes_cli/config.py:528-539` via `hermes_cli/config_home.py:68-69` | Same as above [V] |
| `logs/agent.log`, `logs/errors.log` | `hermes_logging.py:3`, `:351-369`; `agent/agent_init.py:630-637` | Agent init [V] |
| `cache/scratch/` (TMPDIR), prune stamp, `logs/scratch-prune.log` | `hermes_constants.py:962-1031` | Bootstrap at import (`hermes_bootstrap.py:456-465`, `:622`) [V] |
| `state.db` with `-wal`/`-shm` or a journal | `hermes_state.py:181`, `:201-204` | Only when a `SessionDB` is opened: a passed `session_db`, or the lazy recall path when `session_search` is used (`run_agent.py:288-306`) [V]. Whether anything else opens it with `session_db=None`: [?] |
| `sessions/<id>.jsonl` | `hermes_state.py:435-449` | Fallback transcript when state.db was replaced [V] |
| `context_length_cache.yaml`, `cache/openrouter_model_metadata.json`, local-probe cache | `agent/model_metadata.py:1098-1101`, `:206-208`, `:154-155`, `:192-203` | Context-length resolution [V] |
| `memories/MEMORY.md`, `USER.md`; `skills/*` | `tools/memory_tool.py`, skill tools, background review | Only if those toolsets or the review run [V for the gates, section 3 row 6] |
| `sandboxes/docker/<task>/` | `tools/environments/base.py:187-193` | Docker backend, persistent mode [V] |
| `telemetry/shared_metrics/metrics.sqlite3`, `outbox/` | `hermes_cli/observability/shared_metrics.py:212-215` | When the metrics store is built. Whether `record_*` calls from `run_agent.py` and `tools/terminal_tool.py` build it while `enabled: false`: [?] |
| `config.yaml` | `hermes_cli/config_version_stamp.py:102-112` | `stamp_missing_config()` writes one if missing. It is called from `migrate_config` (`hermes_cli/config.py:1179`). Whether the `AIAgent` path creates it: [?] |

### Written outside `HERMES_HOME`

- **The real `HOME`** of subprocesses on the host (`hermes_constants.py:765-789`). The agent's own commands populate `~/.cache`, `~/.npm`, `~/.gitconfig` and so on. That is shared across trials. [I]
- `trajectory_samples.jsonl` / `failed_trajectories.jsonl` with a relative filename, when `save_trajectories=True` (`agent/trajectory.py:37-41`), so they land in the process cwd. [V for the name, I for the location]
- A detached Python child that prunes the scratch dir. It is spawned at most once an hour per home, so **once per fresh home** (`hermes_constants.py:1005-1031`, `hermes_constants_scratch_detach.py:28-50`). It deliberately outlives the parent. [V]
- Docker daemon state (containers and labels) when the docker backend is used. [V]
- Python bytecode in the checkout, unless `PYTHONDONTWRITEBYTECODE=1` (Hermes's own image sets it, `Dockerfile:53`). [I]
- Reads (not writes) of `<checkout>/.env` and `HERMES_HOME/.env` at import (`run_agent.py:95-97`). [V]

### Locks, PID namespaces and workers [V]

- **All lock files I found live under `HERMES_HOME`**: `active_sessions.lock`, `.mcp-discovery.lock`, auth, plugin-state, update, kanban, backup, shell-hook and trajectory locks (from grepping `fcntl.flock`, `msvcrt.locking` and `*.lock` across `agent`, `tools`, `hermes_cli` and `hermes_state*`). `gateway.lock` is gateway only.
- `hermes_state_lockguard.py:1-24`: adds OFD locks on the descriptors SQLite holds, so that a stray `open()`/`close()` of `state.db` **within one process** cannot cancel SQLite's POSIX locks. It is a guard for one shared `state.db`. It does not create cross-process contention.
- `hermes_state_lockowners.py:1-8`, `:81-112`: diagnostics only. It reads `/proc/locks` to name who holds the writer lock after a timeout.
- `hermes_state_pidns.py:1-16`: stamps lease holders with the PID-namespace inode, so that two **containers sharing one volume** do not reclaim each other's live leases. It matters only if several PID namespaces share one `state.db`, which neither option does.
- `hermes_state_runtime_workers.py:1-60`: **not threads.** It is SQL bookkeeping for gateway session workers (the `worker_executions` table). Not relevant headless.
- `hermes_startup_watchdog.py:1-26`: armed only by `cli.py:1608-1609` and the gateway (`hermes_cli/gateway.py:4439-4459`). `AIAgent` never arms it.
- `hermes_dir_acl.py:1-14`: Windows only.
- `hermes_bootstrap.py`: Windows UTF-8, import-path hardening (`:434`, `:508`), Happy Eyeballs, and the TMPDIR export plus scratch prune (`:622`).

### Background threads and processes on the `AIAgent` path [V]

- The env-probe worker thread (`tools/env_probe.py:227-232`, started from `agent/agent_init.py:1328-1332`).
- The terminal idle-cleanup thread. It reaps environments idle longer than `TERMINAL_LIFETIME_SECONDS` (default 300) (`tools/terminal_tool.py:898-905`, started at `:1297` and `tools/terminal_tool_lifecycle.py:226`).
- The background review daemon thread after each turn, unless `skip_background_review` (`agent/turn_finalizer.py:603-616`, `agent/background_review.py:1-6`).
- The OpenRouter prewarm thread, for the OpenRouter provider only (`agent/agent_init.py:422-427`).
- Docker teardown threads (`tools/environments/docker.py:394`).
- The detached scratch-prune process (above).

### Is `set_hermes_home_override` per instance? No: per context [V]

- It is a `ContextVar` (`hermes_constants.py:13-49`). `get_hermes_home()` checks the override, then `HERMES_HOME`, then the default (`hermes_constants.py:194-200`).
- `ContextVar`s do not carry into `threading.Thread` on the default Python 3.14 build. Locally `sys.flags.thread_inherit_context == 0` (measured). Hermes itself notes this (`agent/system_prompt.py:225-239`).
- Background threads such as the env probe, review fork and cleanup thread therefore fall back to the process `HERMES_HOME`. [I for each thread]
- **Process-global state an override does not cover:** [V]
  - `os.environ` as a whole: `TERMINAL_*`, `TERMINAL_CWD` (`agent/runtime_cwd.py:62-73`), and everything loaded from `.env`.
  - `run_agent._hermes_home`, frozen at import (`run_agent.py:95`).
  - YOLO mode, frozen at import (`tools/approval.py:46`).
  - The env-probe cache (`tools/env_probe.py:21-27`).
  - The terminal environment registry and session-cwd dict (`tools/terminal_tool.py:255-282`, `tools/terminal_tool_lifecycle.py:184-240`).
  - The task override registry (`tools/terminal_tool.py:329-345`).
  - The approval session state, the in-process metadata caches (`agent/model_metadata.py`), and the `SessionDB` registry (`hermes_state_registry.py:1-30`).
- Hermes does multiplex several profiles inside one gateway process. It does so with extra machinery: secret scopes and a multiplex flag (`tools/environments/local.py:397-405`, `hermes_cli/env_loader.py:671-692`). That machinery is built for the gateway, not for parallel eval trials. [V that it exists; I that it does not fit us]

### Concurrency verdict

- **Two `AIAgent`s at once in one process:** not safe for trials. Terminal backend, cwd and env come from the shared process env. Caches and registries are shared. Threads lose the home override. [I, from the globals listed above]
- **Sequential `AIAgent`s in one process:** they share the warmed caches (env probe, context-length memo, endpoint metadata, terminal environment registry), so trials are not independent. [I]
- **Parallel processes with separate `HERMES_HOME`:** I found no lock or state shared through Hermes itself. What they still share is the host: the real `HOME` of subprocesses, the toolchain and caches, the docker daemon, the network, and `/tmp` if `TMPDIR` is overridden. [I]

---

## 7. Update and telemetry behaviour

- **Update checks:** only in the CLI banner and update commands (`hermes_cli/banner.py:285` → `hermes_cli/source_check.py:145`). Not on the `AIAgent` path. [V by caller grep]
- **Telemetry upload:** opt-in. `shared_metrics.enabled` and `send` both default to false (`hermes_cli/config_defaults.py:2323-2327`). The consent offer is skipped when non-interactive (`hermes_cli/observability/shared_metrics_consent.py:178`). [V]
  - The `nemo-relay` native runtime "installs no network exporter" (`pyproject.toml:209-212`, comment). [V that the comment says so]
- **Skills:**
  - The bundled skill copy (`tools/skills_sync.py:396`) runs from CLI entry points only (`hermes_cli/main.py:1046,1620,2593`, `hermes_cli/main_tui_launch.py:632`, `hermes_cli/setup_quick.py:261`, update paths). [V]
  - A fresh home used through `AIAgent` has an empty `skills/`, which matches the earlier measurement in `hermes-notes.md`. [V]
  - The skills hub network fetch runs only when the hub is used. [V]
- **Plugins:** discovered at every agent build (`agent/agent_init.py:1019-1020`). Whether discovery reads anything from the network: [?] It looks filesystem-based.
- **To disable:**
  - Nothing to turn off for update checks or telemetry on this path.
  - Keep `shared_metrics` false.
  - Configure no MCP servers.
  - Leave web, browser, skills-hub and image toolsets out.
  - Block egress at the network layer as a backstop.

---

## 8. Prompt determinism checklist

For two trials on the same config to send byte-identical first requests, every row must be fixed or deliberately equal.
Prompt assembly order is stable, then context, then volatile (`agent/system_prompt.py:738-801`).

| # | Item | Source | Varies with | How to fix |
| --- | --- | --- | --- | --- |
| 1 | `Conversation started: <Weekday, Month DD, YYYY> (<IANA>, <abbr>, UTC±hh:mm)` | `agent/system_prompt.py:495-505`, `:480-491` | Calendar date and timezone (`hermes_time.py:3-5`) | `HERMES_TIMEZONE=UTC`. The date itself cannot be fixed without faking the clock (for example libfaketime in a container). Otherwise record it and interleave arms so dates balance [V] |
| 2 | Extra "Today's date (as of the last context rebuild)" line | `agent/system_prompt.py:512-514` | A rebuild after compression on a later day | Rare. It only affects requests after compression [V] |
| 3 | `Model:`, `Provider:`, `Platform:` lines; `Session ID:` only if `pass_session_id` | `agent/system_prompt.py:519-521` | Config | Keep identical. Leave `pass_session_id=False` [V] |
| 4 | Active-profile line with the **absolute `HERMES_HOME` root** | `agent/system_prompt.py:373-392` | `HERMES_HOME` path | Fixed path per trial [V] |
| 5 | `Host: Linux (<kernel release>)` | `agent/prompt_builder.py:909-913` | Host kernel. Containers report the **host** kernel too | Run all trials on one host or kernel [V for the code, I for containers] |
| 6 | `User home directory: <~>` | `agent/prompt_builder.py:914` | `HOME` | Fixed `HOME` [V] |
| 7 | `Current working directory: <path>` | `agent/prompt_builder.py:916`, `agent/runtime_cwd.py:105-107` | `TERMINAL_CWD`, otherwise the process cwd. **Not** `AIAgent(cwd=)` | Fixed workspace path [V] |
| 8 | `Scratch directory: <HERMES_HOME>/cache/scratch` | `agent/prompt_builder.py:919-922` | `HERMES_HOME` path | Fixed `HERMES_HOME` [V] |
| 9 | Remote backend block (docker): OS and kernel probed in the container | `agent/prompt_builder.py:973-985`, `:870-893` | Image and kernel | Same image and host. It replaces rows 5 to 8 [V] |
| 10 | Bot-screen and WSL hints | `agent/prompt_builder.py:1023-1025` | Host desktop or WSL | Empty on a plain Linux box [I] |
| 11 | `HERMES_ENVIRONMENT_HINT` / `agent.environment_hint` | `agent/prompt_builder.py:1007-1011` | Our choice | Keep constant [V] |
| 12 | Env-probe line (python3/python versions, pip, PEP 668, uv) | `tools/env_probe.py:1-5`, `:131-139`; `agent/system_prompt.py:702-708` | Toolchain on `PATH` | Fixed image, or `agent.environment_probe: false` (`agent/agent_init.py:1322-1327`) [V] |
| 13 | Skills index | `agent/system_prompt.py:301-314` | Contents of `HERMES_HOME/skills` | Seed identically, or leave empty [V] |
| 14 | Memory and `USER.md` blocks; the "you have memory" guidance | `agent/agent_init.py:1210-1281`, `agent/system_prompt.py` `_memory_parts` | Memory files and toolsets | Same seed per arm [V] |
| 15 | `SOUL.md` identity | `agent/system_prompt.py:550-556`, seeded by `hermes_cli/config.py:528-539` | Home contents | Fixed seed. `skip_context_files=True` also drops SOUL unless `load_soul_identity=True` (`:554`) [V] |
| 16 | Project context files: `.hermes.md` / `HERMES.md` / `AGENTS.md` / `.cursorrules` from cwd up to the git root | `agent/prompt_builder.py:142-147`, `:1651` | Workspace contents | Part of the task, or `skip_context_files=True` [V] |
| 17 | Git / workspace snapshot (branch, status counts, project facts) | `agent/system_prompt.py:668-693`, `agent/coding_context.py:262-279`, `:434-441` | Workspace git state | Identical task fixture per trial [V] |
| 18 | Plugin prompt sections | `agent/system_prompt.py:785-787`; discovery `agent/agent_init.py:1019-1020` | Installed plugins | Same checkout and home [V] |
| 19 | Tool list and schemas | `enabled_toolsets`, plugins, MCP | Config, and possibly binaries or keys present | Fix toolsets. Whether any schema text varies with the environment: [?] |
| 20 | Context-file char cap and compression thresholds | `agent/prompt_builder.py:1043-1054` | Resolved context length (section 3, row 2) | Pin `model.context_length` [V] |
| 21 | Request fields beyond messages: `session_id` is passed into request building (`agent/chat_completion_helpers.py:1425`, `:1473`); `prompt_cache_key` appears in the codex transport (`agent/transports/codex.py:50-65`) | Session id | Whether either lands in the body for `chat_completions` to a custom URL: [?] |
| 22 | HTTP headers from the OpenAI SDK (`X-Stainless-*`, User-Agent) | openai package | SDK version, OS and arch | Same image. They are headers, not model input [I] |

**Minimum to get byte-identical first requests:**

- Fixed `HERMES_HOME` path, fixed `HOME`, and a fixed workspace path set through `TERMINAL_CWD`.
- Same kernel, same image or toolchain, `HERMES_TIMEZONE=UTC`.
- Identical home seed (SOUL, skills, memory, config) and identical workspace fixture.
- The same calendar day.

On one host, rows 4, 6, 7 and 8 can only be equal for **concurrent** trials if each trial gets its own mount namespace, which in practice means a container.

---

## 9. Isolation trade-offs: container versus process

Not a decision. These are the options with the evidence for each.

### Option A: one container per trial (Hermes and the agent shell together, local backend inside)

**For:**

- Fixed paths inside every container: `HERMES_HOME`, `HOME`, `/workspace` and scratch. That satisfies prompt rows 4, 6, 7 and 8 even with many trials running at once. [V for the rows, I for the outcome]
- The agent shell sees only the container filesystem. A fresh `HOME` and caches per trial make trials independent (section 6, "outside HERMES_HOME"). [I]
- The network can be restricted with docker networking, for example an internal network that contains only LiteLLM. That also blocks the one possible third-party call (OpenRouter catalog, section 3 row 5) and any direct provider access. [I]
- Leftovers die with the container: the detached prune child, background threads and any processes the agent spawned. [I]
- Matches how Hermes itself is packaged, with `HERMES_HOME` at a fixed path and `HERMES_WRITE_SAFE_ROOT` (`Dockerfile:491-492`). [V]

**Against:**

- **The key is still readable by the agent inside the container.** Hermes and the shell share a uid and filesystem (section 4). A container per trial does not hide the key. It limits where the key can be used, if the network is restricted. A budgeted per-trial virtual key is still needed. [I]
- Kernel release (prompt row 5) is the host's, so cross-host runs still differ. [I]
- Cost:
  - We must build and keep an image with Python 3.14 and the core deps.
  - The harness gains a docker dependency, including for any integration test that exercises isolation.
  - Every trial pays container start-up plus Hermes import time. [?: not measured]
- Results and traces must come out through a mounted volume or stdout. Callbacks run inside the container, so traces need a writer in the container. [I]

### Option B: one process per trial on the host, fresh `HERMES_HOME`, local backend

**For:**

- Simplest, with no docker, fast start-up and easy debugging. [I]
- Separate homes share no Hermes locks or state (section 6). [I]

**Against:**

- Per-trial absolute paths reach the prompt: the `HERMES_HOME` root (row 4), scratch dir (row 8) and cwd (row 7). Concurrent trials therefore cannot be byte-identical. One way out is a single fixed path reused **sequentially**, wiped between trials, at a concurrency of 1. [V for the rows]
- **No sandbox.** The agent shell runs as our user on the host: [V for no sandbox, I for the consequences]
  - It reads any file we can read. The file tools' denylist does not apply to the terminal.
  - It writes to the real `HOME`.
  - It has full network access.
  - It can read the harness's `/proc/*/environ` and any `.env` or `config.yaml`.
  - It can signal our other processes.
- Env leakage: any secret in the harness env under a name not on Hermes's list (for example `LITELLM_*`) reaches the shell (section 4). [V]
- Trials share host state: `~/.cache`, package caches and the git config. That makes them less independent. [I]

### Option B′: process per trial on the host, with `TERMINAL_ENV=docker` for the shell

**For:**

- The shell runs in a container with dropped caps, resource limits and name-only env forwarding that excludes provider keys (section 4). [V]
- The prompt's host block (rows 5 to 8) is replaced by a container probe (row 9). [V]

**Against:**

- The profile line still carries the host `HERMES_HOME` root (row 4). [V]
- Reuse defaults must be turned off (`TERMINAL_CONTAINER_PERSISTENT=false`, `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES=false`). [V]
- The default image is a heavy desktop stack. [V]
- Network is on by default. [V]
- Dangerous-command guards are skipped. [V]
- The Hermes process on the host needs the docker socket. [I]
- The agent's tools see `/workspace` in the container while Hermes's own state stays on the host. [V]

### Option C: many `AIAgent`s in one process

- Ruled out by the evidence in section 6: process-global env-driven config, shared caches and registries, and the home override lost in threads. [I]

### Quick comparison

| Concern | A: container per trial | B: process per trial | B′: process + docker shell |
| --- | --- | --- | --- |
| Byte-identical prompts with concurrent trials | Yes (fixed paths) | No (paths differ) | Partly (row 4 still differs) |
| Agent can read the LLM key | Yes (same container) | Yes (same host user) | No through env. Yes if mounted or forwarded |
| Agent filesystem reach | Container only | Whole user account | Container only |
| Agent network reach | What we allow | Unrestricted | What we allow (default on) |
| Cross-trial leftovers | None | `HOME`, caches, processes | Host `HERMES_HOME` only |
| Harness complexity | Highest | Lowest | Medium |

### What a minimal container image for Hermes would contain [I unless cited]

- **Base:** Debian trixie slim. Hermes pins `debian:trixie-20261020@sha256:4c25…` (`Dockerfile:8`, `:47`).
- **Python 3.14:** uv-managed, pinned to PM's `3.14.9+20261021` (`pm/lock.json:512-551`), using uv `0.13.5` (`pm/lock.json`). Or `python:3.14-slim`. Check which SQLite it links (section 1).
- **Hermes checkout** at the pinned SHA, for example `/opt/hermes`, read-only, plus a venv from `uv sync --frozen --no-dev` (core only).
- **Runtime tools:** `bash` (the local backend needs it, from `pm.shell.bash()`), `git` (workspace probe and tasks), `ripgrep` (Hermes's image installs it, `Dockerfile:216`; which tool uses it I did not trace [?]), coreutils, procps, ca-certificates. Plus whatever the benchmark tasks need.
- **Not needed:** s6-overlay (`Dockerfile:121-175`), node/npm, chromium, ffmpeg, docker-cli, tmux, compilers, the UI/TUI/web builds, the custom SQLite build (section 1).
- **Env:**
  - `HERMES_HOME=/hermes`, `HOME=/home/agent`, `TERMINAL_ENV=local`, `TERMINAL_CWD=/workspace`.
  - `HERMES_TIMEZONE=UTC`, `TZ=UTC`, `LANG=C.UTF-8`, `PYTHONDONTWRITEBYTECODE=1`, `HERMES_WRITE_SAFE_ROOT=/workspace` (optional).
  - No provider-key env vars.
- **Seeded `/hermes`:** `config.yaml` (model, `context_length`, timezone, probe toggle, `shared_metrics` off), a fixed `SOUL.md`, and the agreed skills and memory seed. No `.env`.
- **Run flags:** `--network <internal net with LiteLLM only>`, `--hostname trial`, a non-root `--user`, `--cap-drop ALL`, pids, memory and CPU limits, a read-only rootfs with writable volumes for `/hermes`, `/workspace` and the results dir.

---

## 10. Minimal headless run recipe

Not executed. A dry run with no LLM call points `base_url` at a dead port, so the first model call fails with connection refused. How long Hermes's retry and backoff takes before giving up on that is [?], so bound it with `run_budget_seconds`.

**Environment** (set before the interpreter imports `run_agent`, because `.env` loading and the bootstrap run at import, `run_agent.py:9-13`, `:95-97`):

```bash
export HERMES_HOME=/hermes            # fixed path; seeded, no .env inside
export HOME=/home/agent
export TERMINAL_ENV=local
export TERMINAL_CWD=/workspace        # this, not AIAgent(cwd=), sets the shell cwd and prompt cwd
export HERMES_TIMEZONE=UTC
export PYTHONDONTWRITEBYTECODE=1
unset HERMES_INTERACTIVE HERMES_YOLO_MODE OPENAI_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY
# make sure /opt/hermes/.env does not exist (run_agent.py:96 loads it)
```

**`/hermes/config.yaml` seed.** Key names are from `cli-config.yaml.example:78-117` and `hermes_cli/config_defaults.py`. Whether the pin suppresses the context probe is unverified (section 3, row 2).

```yaml
model:
  default: trial-model          # the LiteLLM alias; must equal the model passed to AIAgent
  provider: custom
  base_url: http://litellm:4000/v1
  context_length: 128000        # pin to skip /models and local-server probes
timezone: UTC
agent:
  environment_probe: false      # or keep it, with a fixed image
shared_metrics:
  enabled: false
  send: false
```

**`run_one_trial.py`.** The constructor arguments are verified against `run_agent.py:236-280`, and the result keys against `agent/conversation_loop.py:676-677`, `:1146-1147`, `:1158-1159`.

```python
import json, os, sys

# Key arrives on stdin so it is never in os.environ or argv
# (os.environ is what the terminal child inherits; local.py:784-787).
api_key = sys.stdin.readline().strip()

from run_agent import AIAgent   # import after env is set

agent = AIAgent(
    base_url=os.environ.get("TRIAL_BASE_URL", "http://127.0.0.1:9/v1"),  # dead port for a dry run
    api_key=api_key or "sk-fake",
    provider="custom",
    model="trial-model",
    max_iterations=30,                 # default is sys.maxsize (run_agent.py:241)
    run_budget_seconds=600,
    enabled_toolsets=["file", "terminal"],
    skip_memory=True,
    skip_background_review=True,       # no review fork (agent/turn_finalizer.py:603-616)
    skip_context_files=False,          # decide per experiment; True also drops SOUL.md
    session_db=None,                   # no title generation (agent/turn_context.py:205-208)
    quiet_mode=True,
    request_overrides={},              # temperature route still unverified
    # step_callback=..., tool_start_callback=..., tool_complete_callback=..., event_callback=...
)

result = agent.run_conversation(
    open("/workspace/TASK.md").read(),
    task_id="trial-0001",              # else a random uuid4 (agent/turn_context.py:589)
)
out = {k: result.get(k) for k in ("final_response", "completed", "failed", "partial", "error", "api_calls")}
out["messages"] = result.get("messages")
json.dump(out, open("/results/result.json", "w"), default=str)
```

**Harness side, for Option A (sketch):** create a per-trial volume from the task fixture, then run:

```bash
docker run --rm -i --network evals-internal \
  -v trialN-ws:/workspace -v trialN-res:/results <image> \
  python -I /opt/run_one_trial.py <<< "$TRIAL_KEY"
```

---

## 11. Open questions

1. **Retry behaviour on a dead or failing endpoint:** how many retries, what backoff, and which result shape (`failed` or `partial`) comes back. This decides how infra failures get labelled. [?]
2. **Does pinning `model.context_length` stop every probe** in rows 2 to 4, given the scoping in `agent/agent_init.py:1606-1650`? Check with the fake LLM server by counting requests to non-chat paths.
3. **Does `usage_pricing.py:516` or `model_metadata.py:1939` fetch the OpenRouter catalog for a custom route?** It would be the only third-party egress on the path.
4. **Request body for `chat_completions` to a custom URL:** does it carry `session_id`, `user`, `metadata` or `prompt_cache_key`? (Row 21; also "prompt-cache markers through the proxy" in `hermes-notes.md`.)
5. **Does `request_overrides` carry `temperature`?** (Still open from `hermes-notes.md`.)
6. **Does the `AIAgent` path ever open `state.db` or write `config.yaml`, or build the shared-metrics store, with `session_db=None` and metrics disabled?** A fresh-home file listing after one fake-LLM run would answer this.
7. **Which files count as protected instruction files** for the fail-closed write gate (`tools/file_tools_write_guards.py:349-359`)? This matters if tasks edit `AGENTS.md` or similar.
8. **Model-based `api_mode` overrides** (`agent/agent_init.py:294-343`) when real model names go through LiteLLM aliases.
9. **Measured install size and cold import time** of a core-only venv, and the SQLite version linked by PM's Python 3.14.9.
10. **Do tool schemas** for `file` and `terminal **vary with the environment**, for example with binaries present? (Row 19.)

---

## Corrections to `docs/hermes-notes.md`

1. **Python.** The note is right that core deps need 3.14, but it is incomplete. `requires-python` is `>=3.11,<3.15` (`pyproject.toml:15`), so pip or uv on 3.11 to 3.13 installs **with no core deps** and fails later. PM pins 3.14.9 (`pm/lock.json:512-551`).
2. **"`set_hermes_home_override` offers a per-context override."** That is correct, but it is not per-instance isolation. It does not carry into `threading.Thread` on Python 3.14 (`thread_inherit_context=0`). Much of the relevant state is process-global: `TERMINAL_*` env, `.env` loaded into `os.environ` at import (`run_agent.py:95-97`), `run_agent._hermes_home` frozen at import, YOLO frozen at import, and the probe and metadata caches.
3. **The constructor's `cwd` argument** is listed as useful, but it does **not** set the terminal cwd or the prompt's "Current working directory" line. Those come from `TERMINAL_CWD` or the process cwd (`tools/terminal_tool.py:756-780`, `agent/runtime_cwd.py:105-107`). `cwd` feeds context-file discovery and the memory provider only (`agent/agent_init.py:2069-2075`, `:1200-1201`).
4. **System prompt contents** are incomplete. Besides the date, model and a `HERMES_HOME` path, the prompt also carries:
   - timezone abbreviation and UTC offset, and the provider and platform lines;
   - kernel release, home dir, cwd and scratch path;
   - an env-probe line with Python, pip and uv versions;
   - the skills index, `SOUL.md`, and a git workspace snapshot (section 8).
5. **Dockerfile and SQLite.** The note is correct, but it should add that Hermes already refuses to enable WAL on a vulnerable SQLite and uses DELETE mode instead (`hermes_state_wal.py:303-304`). The bug only matters when several connections share one `state.db`. The local Python 3.14 links SQLite 3.53.1, which is not vulnerable.
6. **Terminal backends.** The list is incomplete. `tools/environments/` also has `vercel_sandbox`, `managed_modal` and plugin backends. Docker's defaults reuse one long-lived container across sessions and processes (`tools/terminal_tool.py:871`, `:881`), which is wrong for trials.
7. **Answered: "Do trial API keys reach the agent's terminal tool?"**
   - Names on Hermes's blocklist (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …) are stripped.
   - Any other name is inherited, including every `LITELLM_*` name (none is on the list).
   - A key passed only to the constructor is not in the env. The shell can still read it from files or `/proc` as the same user (section 4).
8. **Answered: "Are bundled skills synced in any path other than the installer?"** Yes, from several CLI entry points, but **never** from `AIAgent` construction (section 7). Library use always starts with an empty `skills/` unless we seed it.
9. **Partly answered: "Does `skip_background_review=True` stop all background writes?"** It stops the end-of-turn review fork (`agent/turn_finalizer.py:603-616`). Memory and skill writes the agent makes itself during the turn still happen if those toolsets are on.
10. **Missing: import side effects.** Importing `run_agent` loads `HERMES_HOME/.env` and the checkout's `.env` into `os.environ`. It also exports `TMPDIR` to `HERMES_HOME/cache/scratch`, and for a fresh home it spawns a detached scratch-prune child process (`hermes_bootstrap.py:622`, `hermes_constants.py:1005-1031`).
11. **Missing: approvals.** Headless, dangerous commands are **auto-approved**, apart from the hardline floor (`tools/approval.py:1161-1193`). `HERMES_INTERACTIVE` must never be set in trials.
12. **Missing: network.** The first context-length lookup sends `GET /models`. For a "local" host such as `litellm` or 127.0.0.1 it also probes `/api/tags`, `/v1/props`, `/version` and `POST /api/show` on the LiteLLM host, unless `model.context_length` is pinned (section 3).
