# Hermes: context assembly and self-modification audit

Pinned commit: `6112c2adb9e11f69734a29be9d2696f345ffa06a`. All citations are `path:line` relative to the Hermes repo root.

## How this was done

- Read-only audit of the checkout. Nothing in it was modified.
- No LLM call was made and no API key was used.
- I tried to import `run_agent` under `python3.14` with a throwaway `HERMES_HOME`. The import failed on a missing dependency (`dotenv`), so I did not install dependencies and did not execute Hermes. Everything below comes from reading code, except one observation: even the failed import created `<HERMES_HOME>/cache/scratch/`.
- Tags used throughout:
  - **[V]** verified by reading the cited code.
  - **[I]** inferred from the code, not confirmed by running it.
  - **[?]** could not determine.

The design rule this serves: any behaviour where the agent changes its own prompt, skills or memory must be an explicit setting that is off unless a config turns it on. The main finding is that Hermes does **not** meet that rule by default. Several self-modifying behaviours are on by default and switch on as soon as the matching toolset is enabled. Every one of them has an off switch, but some switches are config keys rather than constructor arguments, and one constructor argument (`skip_background_review`) does not cover every code path.

---

## 1. System prompt assembly

### Where it is built

- `build_system_prompt_parts` builds the prompt in three tiers: `stable`, `context` and `volatile`. `build_system_prompt` joins them with blank lines (`agent/system_prompt.py:738-801`, `agent/system_prompt.py:804-813`). [V]
- It is built **once per session** and cached on `agent._cached_system_prompt`. The first turn builds it fresh (`agent/conversation_loop.py:918`). A continuing session that has a `session_db` and `conversation_history` reuses the stored prompt verbatim (`agent/conversation_loop.py:811-892`). [V]
- It is rebuilt only in three cases [V]:
  - context compression, through `invalidate_system_prompt`, which also reloads memory from disk (`agent/system_prompt.py:816-834`);
  - an operator prompt-refresh epoch (`agent/prompt_refresh.py:80-118`);
  - a Bot Chat capability change (`agent/conversation_loop.py:825-857`).
- `ephemeral_system_prompt` is not part of the cached prompt. It is appended to the system message at API-call time (`agent/chat_completion_helpers.py:2161-2164`). [V]
- Tool schemas travel in the separate `tools[]` array, not in the prompt text. [V]

### Exact order of parts

This is the order of `build_system_prompt_parts`, `agent/system_prompt.py:750-800`. Each part is listed with what adds or removes it. All [V].

**Stable tier**

| # | Part | Source | What adds or removes it |
|---|---|---|---|
| 1 | Identity: `SOUL.md` from `HERMES_HOME`, else `DEFAULT_AGENT_IDENTITY` | `agent/system_prompt.py:550-556`, `agent/prompt_builder.py:1512-1560`, `agent/prompt_builder.py:160` | SOUL.md is read when `load_soul_identity or not skip_context_files` (`agent/system_prompt.py:554`). See note A. |
| 2 | Hermes-help guidance (one of two variants) | `agent/system_prompt.py:754-761` | The skill-pointer variant needs `skill_view` **and** a `hermes-agent` skill in the index. |
| 3 | Task-completion and parallel-tool-call guidance | `agent/system_prompt.py:562-568` | Only when any tools are loaded. Config `agent.task_completion_guidance` and `agent.parallel_tool_call_guidance` (default on, `agent/agent_init.py:1323-1326`). |
| 4 | Tool-aware guidance: memory guidance, `SESSION_SEARCH_GUIDANCE`, `SKILLS_GUIDANCE`, kanban | `agent/system_prompt.py:274-298` | Memory guidance when the `memory` tool is present and a store flag is on (`agent/prompt_builder.py:195-235`). Skills guidance when `skill_manage` is present (`agent/prompt_builder.py:261`). |
| 5 | Steer-channel note | `agent/system_prompt.py:573-575` | Tools present and not a one-shot session. |
| 6 | Tool-use enforcement, Google-model guidance, execution guidance | `agent/system_prompt.py:580-586` | Model-name gated. Config `agent.tool_use_enforcement` and `agent.execution_guidance` (`auto`, true, false, or a list). |
| 7 | Alibaba identity line | `agent/system_prompt.py:590-601` | Only when `provider == "alibaba"`. |
| 8 | `skills.auto_load`: full skill bodies pinned into the prompt | `agent/system_prompt.py:317-341`, `agent/skill_commands.py:1000-1028` | Needs skills tools and `skip_context_files=False`. Config `skills.auto_load` (default `[]`). |
| 9 | Coding brief (coding-posture prefix) | `agent/system_prompt.py:668-697` | Tools present. Mode from `agent.coding_context`: auto, focus, on or off (`agent/coding_context.py:192-195`), plus platform and cwd detection. |

**Context tier**

| # | Part | Source | What adds or removes it |
|---|---|---|---|
| 10 | Caller `system_message` (an argument to `run_conversation`) | `agent/system_prompt.py:775-776` | Present only if passed. |
| 11 | `# Project Context`. The first type found wins: `.hermes.md`/`HERMES.md`, then the `AGENTS.md` chain from git root to cwd, then `CLAUDE.md`, then `.cursorrules`. It also appends SOUL.md if SOUL.md was not already used as the identity. | `agent/system_prompt.py:717-730`, `agent/prompt_builder.py:1720-1750` | Removed by `skip_context_files=True`. |
| 12 | Workspace snapshot (a live git probe of cwd), coding trailing guidance, then the post-workspace parts | `agent/system_prompt.py:777-783` | Present only when the coding posture produces a workspace block. Otherwise the trailing and post-workspace parts move to the end of the stable tier. |

The post-workspace parts are [V]:

- the environment-probe line (host Python/pip facts), config `agent.environment_probe`, default on (`agent/system_prompt.py:705-710`, `tools/env_probe.py:170`);
- the Bot Mode protocol (`agent/system_prompt.py:344-365`);
- the platform hint (`agent/system_prompt.py:451-462`).

**Volatile tier**

| # | Part | Source | What adds or removes it |
|---|---|---|---|
| 13 | Skills index: `## Skills` plus `<available_skills>` | `agent/system_prompt.py:301-314`, `agent/prompt_builder.py:1233-1360` | Only if `skills_list`, `skill_view` or `skill_manage` is in the tools. |
| 14 | Built-in memory: MEMORY.md and USER.md snapshot blocks, then the external provider block | `agent/system_prompt.py:522-547` | See section 3. The built-in block appears whenever a store was loaded and has entries, **even when the `memory` tool is not in the tool list**. |
| 15 | Plugin prompt sections (`## Plugin Context: ...`) | `agent/system_prompt.py:790`, `agent/system_prompt.py:113-135` | Only enabled plugins that register sections. |
| 16 | Active profile line (contains a HERMES_HOME path) | `agent/system_prompt.py:373-410` | Always present. |
| 17 | Timestamp and runtime trailer | `agent/system_prompt.py:495-519` | Always present. `Session ID` appears only with `pass_session_id=True`. |
| 18 | `# Hermes runtime environment` block | `agent/system_prompt.py:797-800`, `agent/prompt_builder.py:1014-1026` | Always present. |

- Part 17 holds `Conversation started: <date> (<tz>)`, then `Model:`, `Provider:` and `Platform:`.
- Part 18 holds, for a local backend, host OS and kernel, the user home directory, the current working directory and the scratch directory (`agent/prompt_builder.py:905-934`). For a remote backend it holds a backend probe instead (`agent/prompt_builder.py:973-995`). It also includes `HERMES_ENVIRONMENT_HINT` or `agent.environment_hint` if set (`agent/prompt_builder.py:1007-1011`).

**Note A.** The identity text is the same whichever path is taken. `ensure_hermes_home` seeds `SOUL.md` in any home that lacks one, using `DEFAULT_SOUL_MD` (`hermes_cli/config.py:527-560`, `hermes_cli/config_home.py:69`, `hermes_cli/default_soul.py:9`). I compared the literals: `DEFAULT_SOUL_MD == DEFAULT_AGENT_IDENTITY == repo SOUL.md`. So `skip_context_files=True` does not change the identity text. Only a custom SOUL.md would. [V]

### Context injected outside the system prompt

These change what the model sees during a run without touching the cached prompt. All [V].

- **External memory prefetch.** Added to the user message every turn when an external provider is active (`agent/turn_context.py:966-994`, `agent/turn_context.py:1261`).
- **`pre_llm_call` plugin hooks.** Their context is added to the user message (`agent/turn_context.py:849-911`).
- **Skills-index delta note.** If the skills on disk differ from the index in the prompt, a `[System: The skills available in this conversation changed ...]` note goes on the user message (`agent/turn_context.py:1254`, `agent/skills_index_delta.py:102-138`).
- **Subdirectory hints.** `AGENTS.md`, `CLAUDE.md` or `.cursorrules` found under directories the agent touches are appended to tool results (`agent/tool_executor.py:1135-1141`). Disabled by `skip_context_files=True` (`agent/agent_init.py:2074-2075`).
- **Todo list re-injection** after compression (`tools/todo_tool.py:1-4`).

### Parts that vary per run with identical config

| Varies with | Where | Note |
|---|---|---|
| Date and timezone | `agent/system_prompt.py:495-504`, `agent/system_prompt.py:176-222` | The date comes from the timestamp in `session_id` (`agent/agent_init.py:1099`), not from "now". A second "Today's date" line appears only if a rebuild happens on a later day than the session start (`agent/system_prompt.py:512-514`). [V] |
| HERMES_HOME path | Active profile line (`agent/system_prompt.py:373-410`); the scratch directory `<HERMES_HOME>/cache/scratch` (`agent/prompt_builder.py:923`, `hermes_constants.py:962-988`) | A random temp home per trial changes the prompt bytes. [V] |
| User home, cwd, host OS and kernel | `agent/prompt_builder.py:905-934` | [V] |
| Environment probe line (host Python/pip) | `tools/env_probe.py:128-200` | Cached per process. [V] |
| Workspace git snapshot (branch, dirty counts) | `agent/system_prompt.py:668-697` | Only when the coding posture is active and cwd is a git repo. [V] |
| Model, provider and platform names | `agent/system_prompt.py:517-519` | Fixed per config. [V] |
| Skills index, memory blocks, context files | parts 11, 13, 14 | Vary with the files on disk. [V] |
| Random IDs | none by default | `session_id` appears only with `pass_session_id=True`. `task_id` and `turn_id` (uuid4, `agent/turn_context.py:589-593`) never enter the prompt. [V] |

---

## 2. Skills

### Where skills live

- The local tier is `<HERMES_HOME>/skills/`, laid out as `[category/]<name>/SKILL.md` with optional `references/`, `templates/`, `scripts/` and `assets/` (`hermes_constants.py:1274-1276`, `tools/skill_manager_tool.py:1-8`). [V]
- Search order (`agent/skill_utils.py:413-424`). Defaults are in `hermes_cli/config_defaults.py:1436-1444`. [V]
  1. Trusted project dirs: `<git root>/.hermes/skills` and `<git root>/.agents/skills`. These load only if the root is in `skills.trusted_project_dirs` and `skills.project_discovery` is on (default on).
  2. Local `<HERMES_HOME>/skills`.
  3. `skills.create_dir`.
  4. `skills.external_dirs`.

### How skills are discovered and listed

- Every `SKILL.md` is parsed for frontmatter `name` and `description`. The category comes from the path (`agent/prompt_builder.py:1137-1166`). [V]
- Descriptions are clipped to 60 characters for the index (`agent/skill_utils.py:846`). [V]
- Skills are filtered by platform, environment and required apps, by `requires_*` and `fallback_for_*` conditions against the current tools (`agent/prompt_builder.py:1168-1186`), and by `skills.disabled` (`agent/skill_utils.py:281-293`). [V]
- The index is cached two ways: an in-process LRU keyed on file signatures (`agent/prompt_builder.py:1078`), and a disk snapshot `<HERMES_HOME>/.skills_prompt_snapshot.json` (`agent/prompt_builder.py:1085-1130`, written at `agent/prompt_builder.py:1445`). [V]
- The index text tells the model to load relevant skills, and also to modify them: "If a skill has issues, fix it with skill_manage(action='patch')" and "After difficult/iterative tasks, offer to save as a skill ... update it before finishing" (`agent/prompt_builder.py:1340-1356`). [V]

### How the agent uses a skill

- `skills_list` returns names, descriptions and categories (`tools/skills_tool.py:290-317`). [V]
- `skill_view(name[, file_path])` returns the SKILL.md body, or a linked file, **as a tool result** (`tools/skills_tool.py:613-716`). [V]
  - Skill content enters the context only through that tool result, or through `skills.auto_load` (stable tier).
  - The content is preprocessed: `skills.template_vars` is on by default; `skills.inline_shell` is off by default (`hermes_cli/config_defaults.py:1452-1455`).
- `skill_view` has two side effects:
  - It bumps view and use counters in `<HERMES_HOME>/skills/.usage.json` (`tools/skills_tool.py:758-779`, `tools/skill_usage.py:497-509`). [V]
  - If the frontmatter declares `deps:`, it calls `pm.ensure(dep)`, which can **install packages** (`tools/skills_tool.py:676-695`). This is gated by `security.allow_lazy_installs` (default `true`, `hermes_cli/config_defaults.py:1782`) and `HERMES_DISABLE_LAZY_INSTALLS` (`pm/install.py:168-183`). [V]

### Can the agent create, edit or delete skills during a run?

Yes, through `skill_manage`, which is in the same `skills` toolset as the read tools (`toolsets.py:100-103`). All [V].

- **Actions:** create, edit, patch, delete, write_file and remove_file (`tools/skill_manager_tool.py:737-744`), plus an atomic batch form (`tools/skill_manager_tool.py:783-834`).
- **Delete:** a foreground delete is a hard `rmtree`. A background-review delete archives to `skills/.archive/` instead (`tools/skill_manager_tool.py:577-611`).
- **Bookkeeping after each successful write** (`tools/skill_manager_tool.py:746-781`):
  - a ledger entry in `skills/.curator_ledger.jsonl` with blobs under `.curator_backups/blobs/` (`tools/skill_ledger.py:84-89`);
  - the skills prompt cache and the disk snapshot are cleared;
  - provenance is recorded in `.usage.json`.
- **External skills are writable.** `skill_manage` modifies skills "wherever they live". `_find_skill` searches every skills dir, including `skills.external_dirs` (`tools/skill_manager_tool.py:252-305`, the loop at `tools/skill_manager_tool.py:280`). Only the curator treats external skills as read-only (`tools/skill_usage.py:274-288`). So a shared seed directory passed as `external_dirs` **can be patched by a trial**.
- **Write gate.** `skills.write_approval: true` makes every `skill_manage` mutation **stage** to `<HERMES_HOME>/pending/skills/<id>.json` instead of applying (`tools/skill_manager_tool.py:691-702`, `tools/write_approval.py:44-53`, `tools/write_approval.py:201-210`).
- **Locked skills** (the `locked` flag in `.usage.json`) refuse all mutation (`tools/skill_lock.py:1-12`).
- **Delegation.** Delegated children are not blocked from `skill_manage`. Only `delegate_task`, `clarify`, `memory`, `send_message` and `cronjob_manage` are blocked (`tools/delegate_tool_toolsets.py:14-21`).

### Are bundled skills synced into a fresh home?

**Not by `AIAgent`.**

- `sync_skills` (`tools/skills_sync.py:396`) is called only from these places [V]:
  - `hermes` CLI chat startup (`hermes_cli/main.py:1587-1626`);
  - TUI launch (`hermes_cli/main_tui_launch.py:631-632`);
  - the installer (`setup-hermes.sh:273`);
  - Docker stage 2 (`docker/stage2-hook.sh:767`);
  - `hermes profile create`.
- No caller exists in `agent/` or `run_agent.py`. [V by grep]
- A fresh home driven only through `AIAgent` therefore has an empty skills index. This matches the earlier measurement.
- The repo ships 44 `SKILL.md` under `skills/` and 149 under `optional-skills/`.
- `.no-bundled-skills` in the home limits any later sync to the essential `hermes-agent` skill (`tools/skills_sync.py:72`, `agent/skill_utils.py:278`). [V]

### Seeding a fixed skill set per config

1. Keep each config's skill set as a versioned directory tree in our repo.
2. Before constructing `AIAgent`, **copy** the tree into the fresh `<HERMES_HOME>/skills/`. Do not point `skills.external_dirs` at a shared seed, because `skill_manage` can patch it in place. [V for the risk]
3. Record a hash manifest of `skills/` before and after the run.
4. Do not create `.skills_prompt_snapshot.json` by hand. Hermes rebuilds it from the manifest. [V]

---

## 3. Memory

### What is stored, where, and in what format

- **Built-in store** `MemoryStore` (`tools/memory_tool_store.py:177`). It holds two files [V]:
  - `<HERMES_HOME>/memories/MEMORY.md`, the agent's notes;
  - `<HERMES_HOME>/memories/USER.md`, the user profile.
  - Paths: `tools/memory_tool.py:38-40`, `tools/memory_tool_store.py:301-303`.
- **Format.** Plain-text entries joined by `\n§\n` (`tools/memory_tool_store.py:26`). Writes are atomic under a lock file (`tools/memory_tool_store.py:707-714`). Drift backups `MEMORY.md.bak.<ts>` are written when a hand-edited file conflicts (`tools/memory_tool_store.py:725-740`). [V]
- **Limits.** 2,200 characters for MEMORY.md and 1,375 for USER.md (`agent/agent_init.py:1247-1248`, `hermes_cli/config_defaults.py:1306-1307`). An over-limit file still loads, but further adds are refused. [V]
- **Enable flags.** `memory.memory_enabled` and `memory.user_profile_enabled`, both default true (`tools/memory_tool.py:306-310`). When both are false, the tool's `check_fn` hides the `memory` tool (`tools/memory_tool.py:313-319`, `tools/memory_tool.py:475`). [V]
- **External providers.** `memory.provider` selects one, default `""` (`hermes_cli/config_defaults.py:1310-1312`). It loads from `plugins/memory/` (bundled: `byterover`, `retaindb`) or from user plugins (`agent/agent_init_memory_provider.py:50-82`). [V]

### When memory is read

- **Injected into the prompt at start. That is the only read path for built-in memory.** [V]
  - `load_from_disk()` runs in agent init (`agent/agent_init.py:1252`) and freezes a snapshot (`tools/memory_tool_store.py:223-257`). The prompt uses that frozen snapshot (`tools/memory_tool_store.py:649-652`, `agent/system_prompt.py:526-531`).
  - Entries that match threat patterns are replaced in the snapshot by a `[BLOCKED: ...]` placeholder (`tools/memory_tool_store.py:232-243`).
  - The `memory` tool has **no read action**. Its schema offers only add, patch and remove (`tools/memory_tool.py:373-439`).
- **Re-read on compression.** `invalidate_system_prompt` reloads from disk, so writes made earlier in the session appear in the rebuilt prompt (`agent/system_prompt.py:833-834`). [V]
- **External providers** are read every turn through `prefetch_all` into the user message (`agent/turn_context.py:966-994`), and may also expose their own tools (`agent/memory_manager_tools.py:63-106`). [V]

### When memory is written

| Writer | Trigger | Code |
|---|---|---|
| Foreground `memory` tool | The model calls it. The write goes to disk at once; the prompt is unchanged until the next build. | `tools/memory_tool.py:222-290`; dispatch at `agent/inline_tool_executors.py:141-162` with `store=agent._memory_store` [V] |
| Background review fork | After a turn, every `memory.nudge_interval` user turns (default 10), when the `memory` tool and a store exist | `agent/turn_context.py:765-775`, `agent/turn_finalizer.py:591-616` [V] |
| External provider sync | After every non-interrupted turn: `sync_all`, then `queue_prefetch_all`, on a background worker | `run_agent.py:888-918`, `agent/memory_manager.py:444-475` [V] |
| External provider session end | `close()` or `shutdown_memory_provider()` calls `on_session_end` | `run_agent.py:867-886` [V] |
| Mirror of built-in writes to external providers | After each committed built-in write | `agent/memory_manager.py:783-832` [V] |

Notes on the background review fork [V]:

- Unattended, it may only `add`. A `patch` or `remove` is staged to `pending/memory/` instead (`tools/memory_tool.py:179-219`).
- `memory.write_approval: true` stages **all** memory writes. A foreground write with no interactive approval channel also stages (`tools/write_approval.py:201-216`). Whether our harness has no approval callback is [I].

The main loop does **not** write built-in memory by itself. Only the tool call and the review fork do. [V]

### What `skip_memory` gates, line by line

All in `agent/agent_init.py`. [V]

- `:1230-1234`. The built-in `MemoryStore` is loaded when `not skip_memory` **or** when `"memory"` is explicitly in `enabled_toolsets` and not in `disabled_toolsets`. So `skip_memory=True` together with `enabled_toolsets=[..., "memory"]` still loads MEMORY.md and USER.md, injects them into the prompt, and lets the tool write.
- `:1256-1259`. A `memory_manager=` passed in is adopted only when `not skip_memory`.
- `:1261-1279`. The external provider (`memory.provider`) is built only when `not skip_memory`.
- `:1281`. `inject_memory_provider_tools` is a no-op without a manager. As a result, prefetch (`agent/turn_context.py:972`), sync (`run_agent.py:901`) and session-end (`run_agent.py:873`) are no-ops too.

What `skip_memory` does **not** do:

- It does not remove the `memory` tool from `tools[]`. Tools are resolved earlier from toolsets (`agent/agent_init.py:2222` runs before `:2245`).
- It does not gate the background review.

A related trap. With `skip_memory=False` (the default) and **no** `memory` toolset, the store is still loaded, so a non-empty MEMORY.md still lands in the prompt. `_memory_parts` never checks for the tool (`agent/system_prompt.py:526-531`). [V]

### What `skip_background_review` gates, line by line

- Stored at `agent/agent_init.py:2170`.
- Checked in exactly one place: `_mirror_turn_to_memory`, which skips `_spawn_background_review` (`agent/turn_finalizer.py:604-616`). [V]
- It does **not** cover the `codex_app_server` loop, which calls `_spawn_background_review` directly without checking the flag (`agent/codex_runtime.py:719-722`). [V] `_spawn_background_review` itself checks only delegate depth and `auxiliary.background_review.enabled` (`run_agent.py:762-769`). [V]
- It does not stop:
  - external-provider sync (`run_agent.py:888-918`);
  - foreground memory or skill writes;
  - `.usage.json` telemetry;
  - compression;
  - titles.

### Seeding and tracing memory

- **Seed.** Before constructing `AIAgent`, write `memories/MEMORY.md` (and USER.md if wanted): entries joined by `\n§\n`, under the character limits, with no threat-pattern text. The snapshot is taken at construction. [V]
- **Capture reads.** There is no callback for the injected memory. Read `agent._cached_system_prompt` after the run, or take the system message from the proxy request log. The proxy log is ground truth for what was sent. [V that no callback exists, by reading the callback list `agent/agent_init_params.py:23-33`]
- **Capture writes.** Three ways, all [V]:
  - `tool_complete_callback(call_id, name, args, result)` fires for every tool call, including `memory` (`agent/tool_executor.py:1048-1055`);
  - diff the `memories/*.md` hashes before and after;
  - list `pending/memory/`.
- Background-review writes happen in a fork whose callbacks I did not trace [?]. That is why the file diff is the reliable check.

---

## 4. Background and post-run processes

| Process | Trigger | What it writes, where | Knob that disables it |
|---|---|---|---|
| Background review fork, thread `bg-review` (`run_agent.py:752-820`, `agent/background_review.py:1175-1335`) | At the end of `run_conversation`, inside `finalize_turn`, before returning. The thread is a **daemon and outlives the call.** It fires if `skill_manage` is present and the tool iterations since the last skill write reach `skills.creation_nudge_interval` (default **10**, `agent/agent_init.py:1288`, counter at `agent/turn_iteration_prep.py:166-167`, reset at `agent/tool_executor.py:739`), or on the memory trigger above. | Up to 16 iterations (`agent/background_review.py:173`) of an LLM fork on the **same endpoint** as the main model by default (`agent/background_review.py:253-292`). It writes skills, memory (add only), `.usage.json` and ledger entries. Its tools are whitelisted to `skills` and `memory` plus `read_file` and `search_files` (`agent/background_review.py:1102-1144`). | `skip_background_review=True` (chat_completions path only); config `auxiliary.background_review.enabled: false` (all paths; the default is true and it fails open on a config read error, `agent/background_review.py:228-250`); `skills.creation_nudge_interval: 0`; `memory.nudge_interval: 0`; or no skills or memory toolset. [V] |
| Review idle queue (`agent/review_idle_queue.py:218`) | Only for reviews routed to a managed local llama-server | The same as above, but deferred | Same knobs. [V] |
| External memory worker (`agent/memory_manager.py:444-516`) | Each turn, when a provider is active | The provider's own store | `skip_memory=True`, or `memory.provider: ""`. [V] |
| Auto title (thread `auto-title`, `agent/title_generator.py:736-800`) | Turn start, when `session_db` is set (`agent/turn_context.py:201-207`) | Session title in `state.db`. An auxiliary LLM call. | `session_db=None`, or `auxiliary.title_generation.enabled: false` (`hermes_cli/config_defaults.py:761-763`). [V] |
| Context compression (`agent/context_compressor.py:5434`, preflight at `agent/turn_context_compaction.py:129-141`, post-tool at `agent/turn_preflight.py:244`) | Context over the threshold (`compression.enabled`, default true, `agent/agent_init.py:1453`) | Rewrites messages through an auxiliary LLM summary call, rebuilds the system prompt (fresh memory from disk, skills index, plugin sections) and may rotate `session_id` | `compression.enabled: false`. **Design decision:** this risks context overflow. [V] |
| Micro-compaction after a turn (`agent/turn_finalizer.py:303-344`) | Opt-in | Rewrites history | `compression.micro_compact`, default false (`agent/agent_init.py:1484`). [V] |
| Prepared compaction (`agent/turn_finalizer.py:881`) | Opt-in | A background summary thread | `compression.prepare_ahead`, default false (`agent/agent_init.py:1497`). [V] |
| Idle compaction (`agent/turn_context_compaction.py:144-200`) | Opt-in | Summarizes after an idle gap | `compression.idle_compact_after_seconds`, default 0. [V] |
| Prompt-refresh epoch (`hermes_state_prompt_refresh.py:15-54`, `agent/prompt_refresh.py:80-118`) | Only after an operator runs `hermes sessions refresh-prompts` | Rebuilds the stored prompt of continuing sessions in `state.db` | `session_db=None`, or never run the command. The agent cannot trigger it. [V] |
| Curator (`agent/curator.py:1200-1213`) | Only from the gateway (`gateway/run.py:4353`), CLI/TUI (`hermes_cli/cli_tui_runtime_mixin.py:403`) or web server (`hermes_cli/web_server_sessions.py:526`). **Never from `AIAgent`.** | Marks skills stale and archives them; an optional LLM consolidation (default off, `hermes_cli/config_defaults.py:1493`); writes `skills/.curator_state` | `curator.enabled: false` (default true, `agent/curator.py:106-107`), or do not run the gateway or CLI. [V] |
| Cron scheduler | Started only by the gateway (`gateway/run_bootstrap.py:432`). The `cronjob_manage` tool can still write jobs. | `cron/` | Exclude the `cronjob` toolset. [V] |
| Plugin hooks | Enabled plugins only. Standalone plugins are opt-in through `plugins.enabled` (`hermes_cli/plugins_discovery.py:122-131`). Backend and platform kinds auto-load when bundled (`hermes_cli/plugins_manifest.py:373-377`). | `pre_llm_call` context, prompt sections, `on_session_end` actions. For example the bundled `disk-cleanup` deletes temporary files (`plugins/disk-cleanup/__init__.py:122-234`). | Leave `plugins.enabled` empty, or set `HERMES_SAFE_MODE=1`, which skips plugin discovery, shell hooks, outbound webhooks and MCP (`hermes_cli/plugins.py:1225-1228`, `agent/shell_hooks.py:283`, `agent/outbound_webhooks.py:82`). [V] |
| Lazy installs | `skill_view` with skill `deps:`; provider and feature recovery at agent init (`agent/agent_init.py:1014-1015`, `agent/agent_init_memory_provider.py:63-66`) | Installs packages | `security.allow_lazy_installs: false`, or `HERMES_DISABLE_LAZY_INSTALLS=1`. [V] |
| Per-turn `.env` credential refresh (`agent/client_lifecycle.py:755-790`) | Every turn on chat_completions | Re-reads `<HERMES_HOME>/.env` and can switch key or base URL mid-run | None found. Do not edit `.env` during a run. [V] |
| Shared-metrics telemetry (`hermes_cli/observability/shared_metrics.py:212`) | Only if `telemetry.shared_metrics.enabled` | `telemetry/shared_metrics/` | Default `enabled: false`, `send: false` (`hermes_cli/config_defaults.py:2322-2331`). [V] |
| Update checks | `hermes` CLI only (`hermes_cli/main.py:1587-1605`) | `.update_*` files | Not reachable from `AIAgent`. [V] |
| Model-metadata caches (`agent/models_dev.py:3-7`, `agent/model_metadata_cache.py:21-28`) | Context-length lookup | `models_dev_cache.json` and `context_length_cache.yaml`; a network fetch to models.dev is possible | No knob found. Whether it fires for a neutral model name and a custom base URL is [?]. |
| Trajectories and checkpoints | Constructor args | Trajectory JSONL; filesystem checkpoints | `save_trajectories=False` and `checkpoints_enabled=False` (both default). [V] |

---

## 5. Self-modification inventory

These are behaviours by which Hermes changes its own future behaviour.

| # | Behaviour | Trigger | What changes | Storage path | Knob that disables it | How to verify it stayed off |
|---|---|---|---|---|---|---|
| 1 | Background **skill** review | End of turn; `skill_manage` in tools; at least `creation_nudge_interval` (default 10) tool iterations | Skills created, patched, supporting files added, archived | `skills/`, `skills/.archive/`, `skills/.usage.json`, `skills/.curator_ledger.jsonl`, `.curator_backups/` | `skip_background_review=True` plus `auxiliary.background_review.enabled: false` plus `skills.creation_nudge_interval: 0` | No `bg-review` thread in `threading.enumerate()` after the run; proxy request count equals `result["api_calls"]` [I]; `skills/` hash unchanged; no new ledger lines |
| 2 | Background **memory** review | End of turn; every `memory.nudge_interval` (default 10) user turns; memory tool present | Entries added to MEMORY.md and USER.md; deletes staged | `memories/`, `pending/memory/` | Same as row 1, plus `memory.nudge_interval: 0` | `memories/` hash; `pending/` empty |
| 3 | Foreground `memory` tool | The model calls `memory` (the prompt guidance invites it) | MEMORY.md and USER.md on disk; the current prompt is unchanged until a rebuild | `memories/` | Exclude the `memory` toolset, or set `memory_enabled` and `user_profile_enabled` to false; `memory.write_approval: true` stages instead | `memory` absent from `agent.valid_tool_names`; no `tool_complete_callback` with name `memory`; file hash |
| 4 | Foreground `skill_manage` | The model calls it (the index text and `SKILLS_GUIDANCE` invite it) | Skills anywhere, **including `external_dirs`**; delete is a hard `rmtree` | `skills/`, external dirs | Exclude the `skills` toolset (this also removes the read tools); `skills.write_approval: true` stages every write to `pending/skills/` | `tool_complete_callback` name `skill_manage`; skills hash; ledger; `pending/skills/` |
| 5 | Prompt rebuild on compression | Context over the threshold | System prompt re-rendered with **current** memory and skills from disk; history summarized | In memory; `state.db` if a session DB exists | `compression.enabled: false` (decision), or keep trials under the threshold | `event_callback("session:compress", ...)` fires (`agent/conversation_compression.py:3421-3425`); `agent.log` compression lines |
| 6 | Skills-index delta note | Turn start, when skills on disk differ from the prompt index | A note added to the user message describing new or removed skills | Transcript | No direct knob; it only happens with skills tools present and skills changing | Search request messages for "skills available in this conversation changed" |
| 7 | External memory provider sync and prefetch | Every turn, when `memory.provider` is set | The provider's store; recall injected into user messages | Provider-specific | `skip_memory=True` (or `memory.provider: ""`) | `agent._memory_manager is None` |
| 8 | Stored-prompt replay and session continuation | `session_db` plus `conversation_history` | Reuses an old prompt and hydrates todos and nudge counters from history | `state.db` | `session_db=None`; no carried-over history | No `state.db` in the home |
| 9 | Operator prompt-refresh epoch | `hermes sessions refresh-prompts` | Prompt rebuilt on the next turn | `state.db` `state_meta` | `session_db=None` | No `state.db` |
| 10 | Todo state | The model calls `todo_list` | In-memory list, re-injected after compression, hydrated from history | Transcript only | Exclude the `todo` toolset (deferred behind `tool_search` by default, `hermes_cli/config_defaults.py:2003-2005`) | No `todo_list` calls in the callback log |
| 11 | `skills.auto_load` pins | Config | Full skill bodies in the stable prompt tier | Config | `skills.auto_load: []` (default) | Prompt text |
| 12 | Skill usage counters | `skill_view` | `use_count` and `last_used_at`, which feed curator staleness | `skills/.usage.json` | No knob except no skills toolset; harmless in a fresh home | File present or absent |
| 13 | Curator prune and consolidation | Gateway, CLI or web idle tick only | Skills archived or merged | `skills/.archive/`, `skills/.curator_state`, `logs/curator/` | `curator.enabled: false`; do not run the gateway or CLI | No `.curator_state` |
| 14 | Cron jobs | `cronjob_manage` tool | Scheduled future runs (gateway only) | `cron/` | Exclude the `cronjob` toolset | `cron/` empty |
| 15 | Context files edited by the agent | The agent's file tools write `AGENTS.md`, `CLAUDE.md` or `.hermes.md` in cwd | A future session loads them | cwd | `skip_context_files=True`; a fresh cwd per trial | Hash the context files in cwd |
| 16 | `config.yaml`, `.env` and `SOUL.md` edited by the agent | File tools or terminal. `config.yaml` is **not** write-denied (`agent/file_safety.py:193-195`); `.env` is write-denied (`agent/file_safety.py:197-198`) | Config, credentials and persona for later turns. `.env` is re-read every turn. | `HERMES_HOME` | No Hermes knob. Keep `HERMES_HOME` outside the terminal backend's reach (for example a docker backend) — decision | Hash `config.yaml`, `.env` and `SOUL.md` before and after |
| 17 | Plugin hooks and prompt sections | Enabled plugins | User-message context, prompt sections, session-end actions | `plugins/`, `plugin-data/` | `plugins.enabled: []`, or `HERMES_SAFE_MODE=1` | Prompt lacks `## Plugin Context`; plugin manager list is empty |
| 18 | Lazy package installs | Skill `deps:`; init recovery | The Python and tool environment | pm install dirs [?] | `security.allow_lazy_installs: false`, or `HERMES_DISABLE_LAZY_INSTALLS=1` | Environment package list before and after |
| 19 | SOUL.md seeding | First config load in a home without SOUL.md | Writes the default persona (the same text as the built-in identity) | `SOUL.md` | No knob. Pre-write our own SOUL.md, or accept the default. | Hash SOUL.md |
| 20 | Delegated children writing skills | `delegate_task` with the skills toolset inherited | As row 4 | As row 4 | Exclude the `delegation` toolset | No `delegate_task` calls |

---

## 6. HERMES_HOME layout and carry-over

### What a run creates

| Path under HERMES_HOME | Created by | Tag |
|---|---|---|
| `cron/`, `sessions/`, `logs/`, `logs/curator/`, `memories/`, `pairing/`, `hooks/`, `image_cache/`, `audio_cache/`, `skills/` | `ensure_hermes_home` on first config load (`hermes_cli/config.py:564-583`, `hermes_cli/config_home.py:56-80`) | [V] |
| `SOUL.md` | Seeded default (`hermes_cli/config.py:527-560`) | [V] |
| `cache/scratch/` | `get_scratch_dir` (`hermes_constants.py:962-988`); observed even after my failed import | [V] |
| `logs/agent.log`, `logs/errors.log` | `setup_logging` (`hermes_logging.py:351-372`, `agent/agent_init.py:629-637`) | [V] |
| `sessions/`, plus `request_dump_*.json` on provider errors | `agent/agent_init.py:1103-1104`, `agent/agent_runtime_helpers.py:1518-1550` | [V] |
| `memories/MEMORY.md`, `USER.md`, lock files, `.bak.<ts>` | Memory store and tool | [V] |
| `.skills_prompt_snapshot.json` | Skills index build (`agent/prompt_builder.py:1445`) | [V] |
| `skills/.usage.json`, `skills/.locks/`, `skills/.curator_ledger.jsonl`, `.curator_backups/blobs/`, `skills/.archive/` | Skill tools and the review fork | [V] |
| `pending/{memory,skills}/` | Write approval or the unattended delete gate (`tools/write_approval.py:65-71`) | [V] |
| `state.db` (+ `-wal`, `-shm`) | Only if `session_db` is passed, or if `session_search` lazily opens it (`run_agent.py:290-306`); default path at `hermes_state.py:181-204` | [V] |
| `cache/spillover/`, `cache/terminal*`, `cache/tool_discovery_cache.json` | Large tool results, terminal backends, the tool registry (`tools/tool_result_storage.py:43-46`) | [I] that these appear in an ordinary run |
| `models_dev_cache.json`, `context_length_cache.yaml` | Model metadata lookups | [I] |
| `telemetry/`, `verification_evidence.db`, trajectories, checkpoints | Only when their feature is enabled | [V] gating, [I] paths |

**Everything under the home persists across runs if the home is reused.** That includes memory, skills, `.usage.json`, the ledger, `state.db`, `cron/` and `SOUL.md`.

### Is a fresh HERMES_HOME per trial enough?

It is enough for on-disk state. It is **not** enough on its own when several trials share one Python process. [V unless marked]

1. **Import-time `.env` load.** `run_agent` loads `.env` from the import-time home into `os.environ` at import (`run_agent.py:95-96`). `load_hermes_dotenv` uses the process home, not the per-context override (`hermes_cli/env_loader.py:666-669`). Environment variables then stay set for the life of the process.
2. **The override is a ContextVar.** `set_hermes_home_override` sets `_HERMES_HOME_OVERRIDE` (`hermes_constants.py:18`, `hermes_constants.py:32-49`) and wins inside `get_hermes_home` (`hermes_constants.py:194-201`). But `get_process_hermes_home` ignores it (`hermes_constants.py:243-252`). And a plain `threading.Thread` does not inherit it, a pitfall the code itself documents (`agent/system_prompt.py:225-252`).
3. **Daemon threads outlive `run_conversation`.** `bg-review` uses `propagate_context_to_thread`, so it carries the override (`run_agent.py:820`). If trials switch homes by changing `os.environ["HERMES_HOME"]` instead, a still-running review thread could resolve to the **next** trial's home. [I]
4. **Module-level caches that survive a new `AIAgent`:**
   - skills prompt LRU (`agent/prompt_builder.py:1078`), keyed by path and file signatures, so safe;
   - tool-definition cache (`model_tools.py:202-270`), keyed by profile scope and config signature;
   - config load cache;
   - `_HERMES_HOME_ENSURED` (`hermes_cli/config.py:563`). If a home is recreated at the same path inside one process, the skeleton and SOUL.md are not re-seeded (`hermes_cli/config.py:580-581`);
   - environment-probe cache, process-wide;
   - backend-probe cache, keyed by home;
   - `_HOME_KEY_CACHE` and `_default_hermes_root_memo` (`hermes_constants.py:209`, `hermes_constants.py:299`);
   - per-home plugin managers;
   - review idle `QUEUE` (`agent/review_idle_queue.py:218`);
   - `MemoryManager._PREFETCH_GATE`, class-level (`agent/memory_manager.py:209`);
   - warned-provider set (`agent/agent_init_memory_provider.py:11`);
   - per-home migration `_attempted` sets.
5. **Paths frozen at import.** Several modules freeze `HERMES_HOME` paths at import, but each re-resolves through a live accessor unless patched (`tools/skill_manager_tool.py:68-81`, `tools/skills_sync.py:36-67`, `hermes_state.py:179-204`).
6. **Terminal environments are keyed by `task_id`.** `task_id` defaults to a fresh uuid4 per turn (`agent/turn_context.py:589`), so trials are isolated unless we pass a repeated `task_id`.

**Recommendation** [I]: run one OS process per trial (a subprocess or container), with a fresh `HERMES_HOME` created at the **same absolute path** every trial. A fixed path keeps the prompt bytes identical. A process per trial removes every item in the list above.

After the trial, move the home into the trial's results folder. Do not delete it: it is evidence. Wait for, or kill, daemon threads before archiving, and record any thread still alive as an infra event.

---

## 7. Recommended config knobs for a frozen agent

Inline items marked "decision" are design calls for Rishi. They are not defaults I chose.

### Frozen baseline: nothing self-modifies

Constructor arguments:

```python
AIAgent(
    base_url=..., api_key=..., model=...,            # via LiteLLM
    max_iterations=N,                                 # default is sys.maxsize (run_agent.py:241)
    enabled_toolsets=["file", "terminal"],            # no memory, skills, todo, session_search,
                                                      # cronjob, delegation
    disabled_toolsets=["memory", "skills", "session_search", "cronjob", "delegation", "todo"],  # belt and braces
    skip_memory=True,               # no external provider; no store unless memory toolset requested
    skip_background_review=True,    # blocks the review fork on the chat_completions path
    skip_context_files=True,        # no AGENTS.md/CLAUDE.md, no auto_load, no subdirectory hints
    load_soul_identity=False,
    session_db=None,                # no state.db, no titles, no prompt replay or refresh
    save_trajectories=False, checkpoints_enabled=False, pass_session_id=False,
    memory_manager=None,
    cwd=<fixed per-trial workspace path>,
    quiet_mode=True,
)
```

`<HERMES_HOME>/config.yaml`, written before construction:

```yaml
memory:
  memory_enabled: false          # hides the memory tool (check_fn) and empties the prompt block
  user_profile_enabled: false
  nudge_interval: 0
  provider: ""
skills:
  creation_nudge_interval: 0
  auto_load: []
  external_dirs: []
  project_discovery: false
  inline_shell: false
auxiliary:
  background_review:
    enabled: false               # the only switch that also covers the codex_app_server path
  title_generation:
    enabled: false
curator:
  enabled: false
compression:
  enabled: true                  # decision: false freezes the prompt but risks overflow failures
  micro_compact: false
  prepare_ahead: false
  idle_compact_after_seconds: 0
agent:
  environment_probe: false       # removes host-dependent probe line
  coding_context: "off"          # removes coding brief and live git snapshot (aliases: agent/coding_context.py:143-147)
telemetry:
  shared_metrics: {enabled: false, send: false}
security:
  allow_lazy_installs: false
tools:
  tool_search:
    enabled: "off"               # decision: keeps tools[] a plain list (see correction 5)
```

Environment for the trial process:

- `HERMES_HOME=<fixed path>`
- `HERMES_DISABLE_LAZY_INSTALLS=1`
- Optionally `HERMES_SAFE_MODE=1`, which skips all plugin discovery, shell hooks, webhooks and MCP. Decision: it also skips bundled backend plugins; confirm that `file` and `terminal` do not need any.
- No `.env` in the home. Pass credentials as constructor arguments.

### Memory-on configs

The difference from the frozen baseline is only the following.

**Memory on, empty.** [V]

- Add `"memory"` to `enabled_toolsets` and remove it from `disabled_toolsets`.
- Keep `skip_memory=True`. The built-in store still loads because the toolset was requested explicitly (`agent/agent_init.py:1230-1234`), and the external provider stays off.
- Set `memory.memory_enabled: true`. `user_profile_enabled` is a decision. Keep `nudge_interval: 0` and the background review off, so the only writes are explicit tool calls.
- Result: the `memory` tool is advertised, and the memory guidance is in the prompt (it says the agent "has persistent memory"). There is no memory block, because the files are empty.

**Memory on, seeded.**

- Same as above, plus write `memories/MEMORY.md` (and USER.md) before construction.
- Store the seed file in our repo and record its hash per trial.
- The memory block then appears in the volatile tier.

**Memory off removes:**

- the `memory` tool;
- the memory guidance (`agent/system_prompt.py:280-286`);
- the memory blocks (`agent/system_prompt.py:526-531`);
- the memory nudge (`agent/turn_context.py:767-768`).

[V] Note that `skip_memory=True` alone does **not** do this. You need both `memory_enabled` and `user_profile_enabled` false, or the toolset excluded **and** `skip_memory=True`.

**Optional ablation:** `memory.write_approval: true` keeps the tool and prompt identical but stages every write instead of applying it. The model sees "staged" results, so this is a different condition, not a free freeze. [V for the gate; I for "no approval callback" in our harness]

### Skills-on configs

The difference from the frozen baseline is only the following.

- Add `"skills"` to `enabled_toolsets`. This exposes `skills_list`, `skill_view` **and** `skill_manage` together (`toolsets.py:100-103`).
- Seed by copying into `<HERMES_HOME>/skills/`. Do not use `external_dirs`.
- Keep `creation_nudge_interval: 0`, `background_review.enabled: false` and `skip_background_review=True`. Otherwise any trial with 10 or more tool iterations triggers a post-run review fork that calls the LLM and writes skills.
- Decision: either allow foreground `skill_manage` writes and measure them, or set `skills.write_approval: true` so writes stage to `pending/skills/` and never apply. Hermes has no per-tool switch to drop `skill_manage` while keeping the read tools.
- `security.allow_lazy_installs: false` so `skill_view` cannot install `deps`.

### Checks to run on every trial

These turn "stayed off" into evidence. [I]

1. A hash manifest of `HERMES_HOME` (excluding `logs/` and `cache/`) and of the cwd's context files, before and after.
2. `threading.enumerate()` after `run_conversation` returns. Flag `bg-review`, `auto-title`, `curator-review` and `memory-prefetch-*`.
3. The proxy request count for the trial equals `result["api_calls"]`. Auxiliary calls for review, compression or titles would add requests.
4. Store `agent._cached_system_prompt` and the tool name list as trial artifacts. Diff them against the config's expected prompt, with the date line normalised.
5. `pending/` is empty, and there is no `state.db`, `cron/` content or `.curator_state`.

---

## 8. Open questions

1. **Not executed.** I could not run Hermes, because the `python3.14` environment lacks `dotenv` and I did not install dependencies. The prompt order, the variance list and the `skip_memory` trap should be confirmed with a no-LLM measurement in a Hermes environment. The existing `scripts/measure_hermes_overhead.py` can be extended to dump the prompt with a seeded MEMORY.md and `skip_memory=False` without the memory toolset.
2. Exact wording of the active-profile line for an arbitrary `HERMES_HOME`. Whether ambient resolution reports `default` or `custom` (`agent/system_prompt.py:373-410`, `agent/file_safety.py:439`). [?] Either way the line contains a home path.
3. Whether `models_dev` or context-length probing makes a network call and writes caches at init for a neutral model name behind a custom base URL. [?]
4. Which code path creates `cache/scratch` on a bare import. I observed it, but `export_scratch_tmp_env` is called from `hermes_bootstrap.py:622` and `hermes_cli/main.py:674`, not from `run_agent` directly. [?]
5. Whether the review fork's tool calls fire the parent's `tool_complete_callback`. [?] The file diff covers this either way.
6. Decisions for Rishi:
   - compression on or off;
   - `tool_search` on or off;
   - a skills-on condition that allows writes, versus write-approval staging;
   - `HERMES_SAFE_MODE`;
   - a terminal backend that keeps `HERMES_HOME` out of the agent's reach (row 16).
7. The `codex_app_server` loop ignores `skip_background_review` (`agent/codex_runtime.py:719-722`). It does not matter on our LiteLLM chat_completions path, but it belongs in `docs/known-limits.md` if that path is ever used.
8. What happens to a daemon `bg-review` thread at interpreter exit when a trial subprocess ends mid-write. Writes are atomic (temp file and rename), so partial files are unlikely. [I]

---

## 9. Corrections to `docs/hermes-notes.md`

1. **`skip_memory` is not a memory-off switch.**
   - It disables only the external provider and the passed-in `memory_manager`.
   - It does not remove the `memory` tool.
   - With `"memory"` in `enabled_toolsets` it still loads, injects and writes MEMORY.md and USER.md (`agent/agent_init.py:1230-1261`).
   - Conversely, with `skip_memory=False` and no memory toolset, a non-empty MEMORY.md still enters the prompt (`agent/system_prompt.py:526-531`).
   - The note "skip_memory=True changed neither tools nor prompt" is correct only because the home was empty.
2. **The answer to "Does `skip_background_review=True` stop all background skill and memory writes?"**
   - It stops the post-turn review fork on the chat_completions path (`agent/turn_finalizer.py:604-616`). That fork is the only automatic built-in writer.
   - It does not stop the `codex_app_server` path (`agent/codex_runtime.py:719-722`), external-provider sync, foreground tool writes or `.usage.json` bumps.
   - Add `auxiliary.background_review.enabled: false` and `skills.creation_nudge_interval: 0` to be safe.
3. **The answer to "Are bundled skills synced in any path other than the installer?"** Yes: `hermes` CLI startup, TUI launch, Docker stage 2 and profile create. Never `AIAgent` (`tools/skills_sync.py:396` and its callers in section 2).
4. **The answer to "Does memory injected into the prompt show up in any callback?"** No. Read `agent._cached_system_prompt`, or take the system message from the proxy log.
5. **"`file` + `terminal` also returned `tool_search`, `tool_describe` and `tool_call`."**
   - Cause: the `terminal` toolset includes `process_manage` (`toolsets.py:99`), which is on the default `tools.tool_search.defer` list (`hermes_cli/config_defaults.py:2003-2005`).
   - Knob: `tools.tool_search.enabled: "off"`.
6. **The list of per-run prompt variance is incomplete.**
   - Beyond the date, model name and home path, it also includes provider, platform, host OS and kernel, user home directory, cwd, the scratch directory (under HERMES_HOME), the environment-probe line and a live git workspace snapshot.
   - The date comes from the `session_id` timestamp (`agent/system_prompt.py:176-222`).
7. **Add: the identity text is the same with or without `skip_context_files`.** The seeded `SOUL.md`, `DEFAULT_AGENT_IDENTITY` and the repo `SOUL.md` are identical (Note A).
8. **Add: `set_hermes_home_override` is not full isolation.** `.env` is loaded into `os.environ` from the import-time home (`run_agent.py:95-96`); there are process-wide caches; daemon threads outlive the call. Use one process per trial.
9. **Add: default self-modification is on.**
   - `skills.creation_nudge_interval` defaults to 10 in code. `cli-config.yaml.example` says 15, but that file is only copied by the installer.
   - `memory.nudge_interval` defaults to 10.
   - `auxiliary.background_review.enabled` defaults to true.
   - `curator.enabled` defaults to true, but the curator is unreachable from `AIAgent`.
   - `security.allow_lazy_installs` defaults to true.
10. **Add: `skill_manage` can patch skills in `skills.external_dirs` in place.** Never seed through a shared external dir.
