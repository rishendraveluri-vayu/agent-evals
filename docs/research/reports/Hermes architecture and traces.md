# Hermes architecture and traces

Hermes Agent at the pinned commit `6112c2adb9e11f69734a29be9d2696f345ffa06a`.
This is a synthesis of four code audits in `docs/research/hermes/`. Every `path:line` citation lives in those files; this page keeps only the conclusions.

**How much of this is verified.** Everything below comes from reading the code at the pin. Hermes was not run end to end, because its dependencies are not installed on this machine. One audit ran a partial probe of the tool registry. No LLM call was made. Section 9 lists what SP1 must confirm against the fake LLM server.

## The answer in brief

- **Shape.** Hermes is a single-threaded loop: one LLM call per iteration, tools dispatched between calls, until the model answers without tool calls or a budget runs out. The headless entry point is `AIAgent(...)` followed by `run_conversation(...)`.
- **Context.** The system prompt is built once per session in three tiers: stable, context and volatile. Tool schemas travel separately. Memory reaches the model only through the system prompt; the memory tool has no read action.
- **Self-improvement (R3).** It is on by default as soon as the memory or skills toolsets are enabled. Every behaviour has an off switch, but several switches are `config.yaml` keys rather than constructor arguments. A few behaviours have no switch at all, so only a before-and-after file hash catches them. R3 is achievable: self-improvement can be made explicit and verified per trial.
- **Traces.** Constructor callbacks cover only steps and tool calls. LLM requests, responses, tokens, latency and errors come through plugin hooks loaded from a plugin folder under `HERMES_HOME`. So the Hermes adapter is a small plugin we ship, with the LiteLLM request log as ground truth.
- **Tools (D14).** One shared MCP server works with Hermes unmodified. It carries five costs, listed in section 5.
- **Isolation (D3).** The prompt contains host paths, the kernel version and the working directory. Concurrent trials can only send byte-identical prompts if each runs in its own container. Several agents in one Python process is ruled out.

## 1. How one Hermes run works

```text
AIAgent(base_url, api_key, model, enabled_toolsets, ...)
  reads HERMES_HOME/config.yaml, resolves the tool list, loads the memory snapshot
  │
  └─ run_conversation(user_message)
       1. Admission      take a session lease (only with a session DB)
       2. Turn reset     re-read HERMES_HOME/.env            ← can swap key or base_url
       3. Build context  system prompt (built once, cached), user row,
                         external memory prefetch, pre_llm_call hooks
       4. Loop while api_calls < max_iterations:
            step_callback
            build request → [pre_api_request hook] → LLM call (streamed, retried)
            → [post_api_request hook, usage recorded]
            tool calls?  yes: save assistant row → run tools
                              (tool callbacks, pre/post_tool_call hooks) → maybe compress
                         no:  final answer (stop gates may nudge it to continue)
       5. Finalize       result dict, post_llm_call hooks, memory sync,
                         spawn background review thread   ← self-improvement
  returns {final_response, messages, api_calls, completed, failed,
           turn_exit_reason, token counters, estimated_cost_usd, ...}
```

**What stops the loop.**

| Stop | What happens | How the result shows it |
| --- | --- | --- |
| Model answers with no tool calls | Normal finish | `completed=True`, exit reason `text_response(...)` |
| `max_iterations` reached | Hermes makes **one extra summary call** that is missing from `api_calls`, the token totals and the hooks | `completed=False`, exit reason `max_iterations_reached(N/M)` |
| Provider errors after retries | Default 3 retries, then fallback model if configured | `failed=True`, `failure_reason`, `failure_retryable` |
| Context overflow that compression cannot fix | Gives up | `partial=True`, `failure_reason="context_overflow"` |
| Interrupt, guardrail, content policy | Stops | `interrupted`, `guardrail_halt`, `content_policy_blocked` |
| `run_budget_seconds` | **Not a stop.** It only injects a wrap-up notice at 80% | none |

`max_iterations` defaults to `sys.maxsize`, so the adapter must always set it, and the wall-clock hard stop must be ours.

## 2. How the agent's context is built

### System prompt

Built once per session and cached on `agent._cached_system_prompt`. It is rebuilt only after context compression, an operator prompt refresh, or a Bot Chat change.

| Tier | Main parts | Switch |
| --- | --- | --- |
| Stable | Identity from `SOUL.md`; tool-use guidance; memory guidance if the memory tool is present; skills guidance if `skill_manage` is present; model-specific guidance; coding brief | Toolsets; `agent.*` config keys; `agent.coding_context` |
| Context | Caller `system_message`; project files (`AGENTS.md`, `CLAUDE.md`, `.hermes.md`, `.cursorrules`); workspace git snapshot; environment-probe line | `skip_context_files`; `agent.environment_probe`; `agent.coding_context` |
| Volatile | Skills index; memory blocks; plugin sections; profile line with the `HERMES_HOME` path; date, model, provider, platform; runtime block with OS, kernel, home, cwd and scratch path | Skills toolset; memory files; plugins; always present for the rest |

**What varies between runs with an identical config.** Date and timezone, the `HERMES_HOME` path, the user home, the working directory, the kernel release, the scratch path, the environment-probe line and the git snapshot. The fix is fixed paths inside a container, `HERMES_TIMEZONE=UTC`, `agent.environment_probe: false` and `agent.coding_context: "off"`. The calendar date cannot be fixed without faking the clock, so the experiment should interleave its two arms in time.

Two traps. The working directory in the prompt comes from `TERMINAL_CWD` or the process cwd, not from the constructor's `cwd` argument. And a model alias that the proxy's `/models` does not describe gets an assumed 256k-token window, which also moves compression thresholds. Pin `model.context_length` in config.

### Memory

- **Storage.** Two plain-text files under `HERMES_HOME/memories/`: `MEMORY.md` for the agent's notes and `USER.md` for the user profile. Entries are separated by `§`. Caps are 2,200 and 1,375 characters.
- **Read.** Only by injection into the system prompt. The snapshot is frozen when `AIAgent` is constructed. The memory tool offers add, patch and remove, with no read. Memory is re-read from disk only when compression rebuilds the prompt.
- **Write.** Three writers: the agent's own `memory` tool, the background review thread every 10 user turns, and an external memory provider if one is configured.
- **Trap.** `skip_memory=True` is not a memory-off switch. It disables only external providers. With the memory toolset enabled, the built-in store still loads, injects and writes. Without the toolset, a non-empty `MEMORY.md` still lands in the prompt.

**What this means for the D9 memory axis.** In a single-turn trial, anything the agent writes to memory is invisible to it for the rest of that trial, because the snapshot is frozen. Memory can only help through what was seeded before construction. That makes "memory on and empty" versus "memory on and seeded" a clean comparison: both arms have the same tool and the same guidance text, and the prompts differ only by the memory block. "Memory off" additionally removes the tool, the guidance and the block, which is the confound already noted in D9.

### Skills

- **Storage.** Folders under `HERMES_HOME/skills/`. A fresh home starts empty; `AIAgent` never copies the bundled skills. Seeding means copying our skill folders in before construction.
- **Use.** The prompt carries an index of names and descriptions. The agent calls `skill_view` to load a body, and `skill_manage` to create, patch or delete one.
- **No read-only mode.** The skills toolset exposes all three tools together. The only way to keep reads and block writes is `skills.write_approval: true`, which stages every write in `pending/skills/` instead of applying it. Never seed through `skills.external_dirs`, because `skill_manage` edits those in place.

## 3. Self-improvement: every behaviour and its off switch

| Behaviour | Default | Off switch | How we prove it stayed off |
| --- | --- | --- | --- |
| Background review thread writes skills and memory after the run | On when memory or skills tools are enabled | `skip_background_review=True` and `auxiliary.background_review.enabled: false` and both nudge intervals set to 0 | No `bg-review` thread alive after the run; LiteLLM request count equals `api_calls` |
| Agent's own `memory` tool | On with the memory toolset | Leave out the toolset, or set `memory_enabled` and `user_profile_enabled` false | Hash of `memories/` unchanged; no `memory` tool call |
| Agent's own `skill_manage` tool | On with the skills toolset | Leave out the toolset, or `skills.write_approval: true` | Hash of `skills/` unchanged; `pending/skills/` empty |
| Prompt rebuilt from disk on compression | On | `compression.enabled: false`, which risks overflow failures | No `session:compress` event |
| External memory provider sync | Off unless configured | `skip_memory=True` | No memory manager on the agent |
| Session replay, prompt refresh, auto titles | Off without a session DB | `session_db=None` | No `state.db` in the home |
| Plugin prompt sections and hooks | Opt-in | `plugins.enabled: []` or `HERMES_SAFE_MODE=1` | No plugin section in the prompt |
| Lazy package installs from skills | On | `security.allow_lazy_installs: false` | Package list unchanged |
| Agent edits `config.yaml`, `SOUL.md` or `AGENTS.md` with file or shell tools | Possible | **No switch** | Hash before and after; keep `HERMES_HOME` out of the agent's reach |
| `.env` in the home re-read every turn | Always | **No switch** | Never put a `.env` in the home; pass credentials to the constructor |

The full frozen-agent configuration, constructor arguments plus `config.yaml`, is in section 7 of `docs/research/hermes/context_and_self_improvement.md`, with the exact deltas for memory-on and skills-on configs.

**Five checks to run on every trial**, so "stayed off" becomes evidence rather than a claim:

1. Hash `HERMES_HOME`, minus logs and caches, and the workspace context files, before and after.
2. List live threads after `run_conversation` returns, and flag any review, title or prefetch thread.
3. Compare the LiteLLM request count for the trial with `result["api_calls"]`.
4. Store the rendered system prompt and tool list as trial artifacts, and diff them against the config's expected prompt.
5. Confirm `pending/` is empty and no `state.db` or cron files exist.

## 4. Traces

### Where each trace element can be captured

| Trace element | Source |
| --- | --- |
| Rendered system prompt | `agent._cached_system_prompt`, or the system message in the LiteLLM log |
| Each LLM request | `pre_api_request` hook: full message list, plus a request body truncated at 50k characters; LiteLLM log for exact bytes |
| Each LLM response, tokens, latency, time to first token | `post_api_request` hook |
| Retries and provider errors | `api_request_error` hook |
| Tool call and result, with duration | `tool_start_callback` and `tool_complete_callback`, or `pre_tool_call` and `post_tool_call` hooks |
| Memory read | No event exists. Memory is part of the system prompt, so capture the prompt |
| Memory write | A `memory` tool call, plus a diff of the memory files |
| Skill invocation | `skill_view` and `skill_manage` tool calls; `on_skill_lifecycle` hook |
| Compression | `event_callback("session:compress")`; `post_compaction` hook |
| Auxiliary calls such as compression summaries or titles | `pre_auxiliary_call` and `post_auxiliary_call` hooks |
| Exit reason, totals, cost | The result dict |
| Correlation | `task_id`, `turn_id`, `api_request_id` and `tool_call_id` on every hook |

**How hooks are loaded.** A plugin is a folder under `HERMES_HOME/plugins/` with an `__init__.py` exposing `register(ctx)`. Hooks run in-process on the loop thread with a 30-second timeout. `HERMES_SAFE_MODE=1` disables them all, so the trace plugin and safe mode are mutually exclusive. No way to register hooks without a plugin folder was found.

**Gaps the adapter must cover.**

- The extra summary call at `max_iterations` appears in no hook and no total. Only the LiteLLM log sees it.
- Early-exit results carry no token keys at all. Record those tokens as unknown, never as zero.
- Compression replaces `messages` in place. The final message list is the compacted one, so the trace must be built from the hook stream, not from the result.
- Background review calls are auxiliary and absent from the result totals.

### How this bears on D12, the trace format

Hermes hooks map cleanly onto span-style events: request and response hooks become an LLM-call span, tool hooks become a tool span, and skill and memory tool calls become refinements of a tool span. The trace-standards brief in `docs/research/trace-standards.md` found:

- **OpenTelemetry GenAI conventions** are still all "Development" stability. They moved to a new repository in June 2026 that has no tagged release. Memory and skill attributes exist in the spec text but in no release.
- **OpenInference** is stable but has no concept of memory or skills.
- **Hermes has community OpenTelemetry plugins** for the current release. Whether they work at our pin is unverified.

The brief laid out three options without deciding: pure OpenTelemetry GenAI, OpenInference with Phoenix on our Postgres, or our own small schema on an OTLP-shaped envelope that borrows `gen_ai.*` attribute names. It said the evidence favours the third for this platform.

## 5. Getting the finance tools into Hermes (D14)

**One shared MCP server works unmodified.** Declare it under `mcp_servers` in the trial's `config.yaml`, call `discover_mcp_tools()` before constructing the agent, and pass the server's toolset in `enabled_toolsets`. Stdio, Streamable HTTP and SSE all work.

Five costs:

1. **Prefixed names.** Hermes shows the model `mcp__fin__<tool>`, and normalises the schemas slightly. The other harnesses may see bare names.
2. **Tool Search hides the tools by default.** MCP tools sit behind `tool_search` and `tool_call` bridge tools unless `tools.tool_search.enabled: "off"`.
3. **Results are wrapped as untrusted.** MCP results are wrapped in an `<untrusted_tool_result>` block with a "treat as data" preamble. No config switch was found.
4. **A circuit breaker.** Three consecutive error results pause every tool on that server for 60 seconds. If the finance server reports domain errors as MCP errors, a trial can lose its tools mid-run.
5. **Discovery is the caller's job.** A headless agent never runs it on its own.

**The alternatives.** A Hermes plugin that registers the tools directly gives bare names and no wrapper, but duplicates the schemas in Python inside the Hermes process. A CLI through the terminal tool works but gives the weakest trace, since every operation becomes a shell string.

Costs 1 and 3 are Hermes-only. In a within-Hermes experiment such as the memory axis, they are identical in both arms and cancel out. In a cross-harness comparison they are part of what "Hermes" means, which is arguably fair, but it should be stated as a known limit.

## 6. Isolation (D3)

| Concern | Container per trial | Process per trial | Process, with Hermes's docker backend for the shell |
| --- | --- | --- | --- |
| Byte-identical prompts for concurrent trials | Yes, with fixed paths | No, paths differ | Partly |
| Agent can read the LLM key | Yes, inside the container | Yes, same host user | Not through env |
| Agent's filesystem reach | Container only | Whole user account | Container only |
| Agent's network reach | What we allow | Unrestricted | What we allow |
| Leftovers between trials | None | Home dir, caches, processes | Host `HERMES_HOME` only |
| Harness complexity | Highest | Lowest | Medium |

**Facts behind the table.**

- **Several agents in one process are ruled out.** Terminal settings and the working directory are process-global. `.env` is loaded into the environment at import. The home override does not carry into threads. Caches are process-wide.
- **The local terminal backend has no sandbox.** Commands run as plain `bash` with our user. Hermes strips a fixed list of key names from the shell's environment, and no `LITELLM_*` name is on it.
- **Headless, dangerous commands are auto-approved**, apart from a hard-coded block list. `HERMES_INTERACTIVE` must never be set in trials.
- **A container does not hide the key from the agent.** The agent shares a user with Hermes, so it can read the key from `/proc` or files. Whatever D3 decides, each trial needs its own budgeted LiteLLM virtual key on a network that reaches only LiteLLM.
- **The custom SQLite build is not needed.** Hermes already avoids WAL mode on vulnerable SQLite, and the bug needs several processes sharing one database.

A minimal image is Debian slim with Python 3.14, the Hermes checkout at the pin installed core-only with `uv sync --frozen --no-dev`, plus `bash`, `git` and `ripgrep`. It needs none of the gateway, Node, browser or desktop pieces. Section 9 of `docs/research/hermes/isolation_and_deployment.md` has the full spec and run flags.

Docker cannot run on this machine yet: your user is not in the `docker` group and the compose plugin is missing.

## 7. What the Hermes adapter must do whatever you decide

- Pass `api_mode="chat_completions"` and `provider="custom"`. Otherwise a model name starting with `gpt-5` silently switches to the Responses API, and a `base_url` ending in `/anthropic` switches SDKs.
- Set temperature through `request_overrides`. Hermes's own per-model temperature rules never run on the proxy path, so the platform owns sampling parameters completely.
- Pin `model.context_length` in config. This also stops the extra network probes Hermes sends to the proxy at startup.
- Keep the LiteLLM hostname identical in every arm. Hermes adds prompt-cache markers only when the hostname contains `litellm` and the model name contains `claude`. Caching does not change outputs, but it changes cost and latency, and only for Claude models.
- Always set `max_iterations`, and enforce our own wall-clock stop.
- Put no `.env` in the home. Pass credentials to the constructor.
- Run each trial in a fresh process, call `agent.close()`, and wait for or kill leftover daemon threads before archiving the home as evidence.

## 8. Decisions this raises for you

- **D3, isolation.** The evidence points to a container per trial, mainly for prompt determinism and to contain an auto-approved shell. Process per trial is simpler but loses both.
- **D12, trace format.** Three options are above. Hermes needs a trace plugin under any of them.
- **D14, tool delivery.** MCP works unmodified, with the five costs in section 5. The Hermes plugin route avoids the wrapper and the prefix at the price of duplicated schemas.
- **New, Hermes settings that are design calls**, logged as D15:
  - compression on, which risks rewriting the transcript, or off, which risks overflow failures;
  - Tool Search off for schema parity, or on to test "Hermes as shipped";
  - in a skills-on config, allow `skill_manage` writes and measure them, or stage them;
  - whether to accept the untrusted wrapper as a known limit.

## 9. What SP1 must confirm against the fake LLM server

1. The exact rendered prompt for frozen, memory-seeded and skills-seeded homes, using the existing measurement script.
2. That `request_overrides` puts `temperature` in the request body.
3. That pinning `model.context_length` stops every non-chat probe to the proxy.
4. Retry count, backoff and result shape on a dead or failing endpoint, which decides how infra failures are labelled.
5. Whether any request body carries `session_id`, `user`, `metadata` or a cache key that would differ per trial.
6. The full message and hook sequence for one MCP tool call.
7. Whether a headless run ever creates `state.db` or edits `config.yaml` with `session_db=None`.
