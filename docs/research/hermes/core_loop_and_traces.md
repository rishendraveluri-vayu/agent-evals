# Hermes Agent: core loop and trace surfaces

Pinned commit: `6112c2adb9e11f69734a29be9d2696f345ffa06a`. Every path below is relative to the Hermes repo root.

**Method.** Read-only audit of the source. No Hermes code was executed: no interpreter on this machine has Hermes' dependencies (`openai`, `fire`, ...), and installing them was out of scope. Each finding is tagged:

- **[V]** verified by reading the code at the cited lines.
- **[I]** inferred from the code (the conclusion follows from what was read, but the exact branch was not traced end to end or not run).
- **[?]** could not determine from reading alone.

Hermes is heavily factored into mixins. `run_agent.AIAgent` (run_agent.py:214-218) is a shell over fourteen mixins; the constructor body lives in `agent/agent_init.py`, the public `run_conversation` in `agent/turn_facade.py`, the loop in `agent/conversation_loop.py`, and each loop phase in an `agent/turn_*.py` module. Line numbers below point at the real implementation, not the forwarder.

---

## 1. Entry points

| Candidate | What it is | Verdict for one headless task |
| --- | --- | --- |
| `run_agent.AIAgent(...)` + `agent.run_conversation(...)` | The agent object and one user turn. Returns a structured dict (section 6). | **Use this.** [V] run_agent.py:236-287, agent/turn_facade.py:22-33 |
| `batch_runner.py` | A `multiprocessing.Pool` + `fire` CLI over a JSONL prompt file. Inside it just builds `AIAgent(...)` and calls `run_conversation(prompt, task_id=...)` per prompt, then converts to ShareGPT trajectories. Forces `skip_memory=True`, `skip_context_files=True`, `save_trajectories=False`, `platform="batch"`. | A reference for how Nous drives the agent headlessly, not a library to call: it writes its own `batch_N.jsonl` files and checkpoint. [V] batch_runner.py:251-281 |
| `mini_swe_runner.py` | A separate, tiny tool-calling loop with its own `OpenAI` client and a single `terminal` tool. **Does not use `AIAgent`** or the Hermes loop at all; it only reuses Hermes execution environments and the trajectory format. | Not relevant for evaluating Hermes. [V] mini_swe_runner.py:130-162, 241-305 |

### 1.1 `AIAgent.__init__` full signature with defaults [V] run_agent.py:236-281

```python
AIAgent(
    base_url: str | None = None, api_key: str | None = None, provider: str | None = None, api_mode: str | None = None,
    acp_command: str | None = None, acp_args: list[str] | None = None, command: str | None = None, args: list[str] | None = None,
    model: str = "",
    max_iterations: int = sys.maxsize,           # unlimited by default
    tool_delay: float | None = None,             # deprecated, ignored (warns)
    enabled_toolsets: list[str] | None = None, disabled_toolsets: list[str] | None = None,
    save_trajectories: bool = False, verbose_logging: bool = False, quiet_mode: bool = False,
    tool_progress_mode: str = "all", ephemeral_system_prompt: str | None = None,
    log_prefix_chars: int = 100, log_prefix: str = "",
    providers_allowed: list[str] | None = None, providers_ignored: list[str] | None = None, providers_order: list[str] | None = None,
    provider_sort: str | None = None, provider_require_parameters: bool = False, provider_data_collection: str | None = None,
    openrouter_min_coding_score: float | None = None,
    session_id: str | None = None,
    tool_progress_callback=None, tool_start_callback=None, tool_complete_callback=None,
    thinking_callback=None, reasoning_callback=None, clarify_callback=None,
    read_terminal_callback=None, read_preview_callback=None, drive_preview_callback=None, read_window_below_callback=None,
    connection_callback=None, tour_callback=None, theme_callback=None, setup_beat_callback=None,
    step_callback=None, stream_delta_callback=None, interim_assistant_callback=None,
    tool_gen_callback=None, status_callback=None, notice_callback=None, notice_clear_callback=None,
    event_callback: Callable[[str, dict], None] | None = None,
    reaction_callback: Callable[[str], None] | None = None,
    max_tokens: int | None = None, reasoning_config: dict | None = None, service_tier: str | None = None,
    request_overrides: dict | None = None, prefill_messages: list[dict] | None = None,
    platform: str | None = None, user_id: str | None = None, user_id_alt: str | None = None, user_name: str | None = None,
    chat_id: str | None = None, chat_name: str | None = None, chat_type: str | None = None, thread_id: str | None = None,
    gateway_session_key: str | None = None,
    skip_context_files: bool = False, load_soul_identity: bool = False,
    skip_memory: bool = False, skip_background_review: bool = False,
    session_db=None, parent_session_id: str | None = None,
    iteration_budget: IterationBudget = None, run_budget_seconds: float | None = None,
    fallback_model: dict | None = None, credential_pool=None,
    checkpoints_enabled: bool = False, checkpoint_max_snapshots: int = 20,
    checkpoint_max_total_size_mb: int = 500, checkpoint_max_file_size_mb: int = 10,
    pass_session_id: bool = False, requested_provider: str | None = None,
    capabilities: dict[str, bool] | None = None, cwd: str | None = None,
    side_agent: bool = False, memory_manager=None,
    tool_result_metadata_callback: Callable[..., dict] | None = None,
)
```

The constructor forwards every kwarg to `agent.agent_init.init_agent` (run_agent.py:282-287; agent/agent_init.py:2107-2262). Init order is load-bearing: routing → callbacks → client → tools → session state → config → memory → compression → context engine (agent/agent_init.py:2192-2260).

Init-time side effects worth knowing [V]:

- Reads `config.yaml` under `HERMES_HOME` (agent/agent_init.py:2229-2235) and `.env` (run_agent.py:92 `load_hermes_dotenv`).
- Plugin discovery (`discover_plugins`, agent/agent_init.py:1019-1023) from `HERMES_HOME/plugins` and `cwd/.hermes/plugins` (hermes_cli/plugins_discovery.py:210-214).
- Resolves the model's context window; for an unknown custom `base_url` this issues a live `GET /models` probe to that URL (agent/model_metadata.py:2288-2290) and caches the answer in files under `HERMES_HOME` (agent/model_metadata.py:153-262). A window below 64k tokens raises `ValueError` at construction (agent/agent_init.py:1956-1994, `MINIMUM_CONTEXT_LENGTH` agent/model_metadata.py:278).
- Spawns an environment-probe warm thread that runs subprocesses (agent/agent_init.py:1330-1332) unless config `agent.environment_probe: false`.
- Prints a tools banner to stdout unless `quiet_mode=True` (agent/agent_init.py:1047-1076).

### 1.2 `run_conversation` signature [V] agent/turn_facade.py:22-33

```python
agent.run_conversation(
    user_message, system_message: str | None = None,
    conversation_history: list[dict] | None = None, task_id: str | None = None,
    stream_callback=None, persist_user_message=None, persist_user_timestamp=None,
    persist_user_display_kind=None, persist_user_display_metadata=None, persist_user_platform_id=None,
    moa_config: dict | None = None, turn_author: dict | None = None, relay_metadata: dict | None = None,
    title_user_message: str | None = None, prelude=None,
) -> dict
```

`system_message` is **appended to** Hermes' own system prompt as the "context" tier (agent/system_prompt.py:775-776); it does not replace it. `ephemeral_system_prompt` (constructor) is appended at API time only and never cached (agent/turn_context.py:1424-1427). `agent.chat(msg)` is `run_conversation(msg)["final_response"]` (agent/turn_facade.py:220-222). `task_id` isolates the terminal/VM per task and defaults to a uuid (agent/turn_context.py:588-590).

---

## 2. The loop

`run_conversation` (facade) → `conversation_loop.run_conversation` → `_run_conversation_turn`. Steps in order:

1. **Admission** (agent/turn_facade.py:80-147). Cancel any background review, take a durable cross-process turn lease on the session row **only if a `session_db` is attached** (agent/turn_facade_lease.py:308-311), open a NeMo Relay "conversation" (a no-op runtime when no relay plugin is configured, agent/relay_runtime.py:1010-1012, 1343-1360), then call the loop. [V]
2. **Per-turn reset** (agent/conversation_loop.py:1668-1678): compression flags, then `_try_refresh_env_client_credentials()`, which **re-reads `HERMES_HOME/.env` every turn** and may swap `api_key`/`base_url` on `chat_completions` routes (agent/client_lifecycle.py:755-785). [V]
3. **`build_turn_context`** (agent/turn_context.py:1093-1294):
   - bind `task_id`, `turn_id = f"{session_id}:{task_id}:{8hex}"` (agent/turn_context.py:588-597); reset per-turn counters; **recreate `IterationBudget(max_iterations)`** and stamp `_run_budget_started_at` (agent/turn_context.py:663-667).
   - `messages = list(conversation_history)`; append the user row (agent/turn_context.py:1169-1179).
   - **System prompt**: built once per session and cached on `agent._cached_system_prompt` (agent/turn_context.py:1201-1203 → agent/conversation_loop.py:802-955 → agent/system_prompt.py:804-811). The `on_session_start` plugin hook fires here (agent/conversation_loop.py:932-936).
   - Create the SessionDB row if a DB is attached (agent/turn_context.py:1217, run_agent.py:315-348; it stores `system_prompt`, `model`, `model_config`).
   - `pre_llm_call` plugin hooks; their text is injected into the **user message**, never the system prompt (agent/turn_context.py:849-910, 1233-1238). A hook can veto the turn.
   - Turn-start compaction (idle/preflight) (agent/turn_context.py:1242-1247 → agent/turn_context_compaction.py:129).
   - External memory prefetch (only with a memory provider plugin) → `<memory-context>` block stamped into the user row's `api_content` sidecar (agent/turn_context.py:1261-1284, 966-995, 119).
   - Session titling thread (aux LLM call) **only when a `session_db` is attached** (agent/turn_context.py:205-207).
4. **Main loop** (agent/conversation_loop.py:1745-1797). Condition: `(api_call_count < max_iterations and iteration_budget.remaining > 0) or _budget_grace_call`. Per iteration, each phase is a function in `agent/turn_*.py` returning a verdict with `action` in `{fallthrough, continue, break, return}`:
   1. `begin_iteration` (agent/turn_iteration_prep.py:352-420): drain redirect, interrupt check → `break`; **`api_call_count += 1`** (:402-403); consume one budget unit or `break` with exit reason `budget_exhausted` (:412-416).
   2. `prepare_iteration` (:144-258): **`step_callback(api_call_count, previous_tool_round)`** (:158-163); run-budget wrap-up notice at 80% (:185-186 → agent/conversation_loop.py:126-159); iteration-budget warning; tool-arg sanitising; role-alternation repair.
   3. `assemble_api_request` (agent/turn_request_assembly.py:106-286): `build_api_messages` makes a **wire copy** of `messages` with the system prompt prepended (agent/turn_context.py:1316-1429, system row at :1424-1428), inserts `prefill_messages`, sanitises, canonicalises, then applies the prompt-cache plan (:207-231) and estimates request pressure.
   4. `run_preflight_gate` → pre-API compression if over threshold (agent/turn_preflight_gate.py:20 → agent/turn_preflight.py:57-227).
   5. `announce_api_call` (stdout/spinner only).
   6. `api_request_id = f"{turn_id}:api:{api_call_count}"` (agent/conversation_loop.py:1763).
   7. **Retry loop** `_run_api_retry_loop` (agent/conversation_loop.py:1571-1600), bounded by `agent._api_max_retries` (config `agent.api_max_retries`, default 3; agent/agent_init.py:1340-1345):
      - `build_api_request` (agent/turn_api_request.py:177-217): `agent._build_api_kwargs(api_messages)` (section 4), `llm_request` middleware, **`pre_api_request` hook** (:60-107), optional `HERMES_DUMP_REQUESTS` dump (:201-202).
      - `perform_api_call` (agent/turn_api_call.py:72-163): streaming by default (:46-69) via `_interruptible_streaming_api_call`, wrapped in `llm_execution` middleware (:139-145).
      - `check_api_response` (agent/turn_response_check.py:92-218): `api_duration = time.time() - api_start_time` (:119); shape validation → retry/fallback/terminal; `finish_reason`; `content_filter` and `length` handling; **`record_response_usage`** (:195-199 → agent/turn_usage.py:73-304).
      - `handle_api_error` (agent/turn_api_error.py:52) classifies exceptions, rotates credentials, activates `fallback_model`, compresses on context overflow.
   8. `apply_retry_restarts` (agent/turn_iteration_prep.py:437-566): compressed/redirected/rebuilt restarts **refund** `api_call_count` and the budget (:487-488, 497-498, 540-541); exhausted retries → `break` with `all_retries_exhausted_no_response` (:557-561).
   9. `normalize_model_response` (agent/turn_response_intake.py:165-244): **`post_api_request` hook** (:66-108, 188-192).
   10. If the assistant message has tool calls → `run_tool_round` (agent/turn_tool_round.py:49-238): validate, append the assistant row, **persist before executing** (:130-153), `agent._execute_tool_calls` (:171 → run_agent.py:1308-1342 → `agent/tool_executor.py`, sequential or concurrent by a segment planner), guardrail halt (:184-198), `execute_code`-only rounds refund the budget (:207-208), then post-tool compression (:210-226). Else → `finish_text_response` (agent/turn_final_response.py:106) which may be held back by stop gates (verify-on-stop, `pre_verify` hook, kanban) that append a user nudge and continue (agent/turn_stop_gates.py:134-223); exit reason `text_response(finish_reason=...)` (agent/turn_final_response.py:417).
   11. Outer exceptions → `handle_outer_loop_error`, capped at `min(_MAX_OUTER_LOOP_ERRORS, max_iterations)` = `min(8, max_iterations)` escaped exceptions per turn (agent/turn_loop_errors.py:149; agent/conversation_loop.py:239).
5. **`finalize_turn`** (agent/turn_finalizer.py:619-901): budget fallback (section 2.1), `completed` computed (:685-690), trajectory save, `_persist_session`, output transforms (`transform_llm_output`, `post_llm_call` hooks :470-508), result dict (:786-820), memory sync + background review spawn (:591-616), `on_session_end` hook (:886-897).
6. **Wrapper** (agent/conversation_loop.py:1802-1865): stamps `turn_id`/`current_turn_user_idx`, `user_intervened`, and closes a failed turn's open tool tail in `messages` and the DB (:1908-1955).

### 2.1 What stops the loop

| Stop | Mechanism | Result signature |
| --- | --- | --- |
| `max_iterations` / `IterationBudget` | Loop condition (agent/conversation_loop.py:1745-1747) and `begin_iteration` budget consume (agent/turn_iteration_prep.py:412-416). Then **the finalizer makes one extra tool-less API call asking the model to summarise** (`_resolve_budget_fallback` agent/turn_finalizer.py:124-195 → `handle_max_iterations` agent/chat_completion_helpers.py:2279-2331). That call appends a synthetic user row `MAX_ITERATIONS_SUMMARY_REQUEST` and an assistant row to `messages`, is **not** counted in `api_calls`, **does not** go through `record_response_usage` (so it is missing from the session token/cost totals), and **does not** fire `pre/post_api_request` hooks. [V for the path; the omission from counters is [I] from the absence of those calls in :2201-2278 and :2279-2331] | `completed=False`, `turn_exit_reason="max_iterations_reached(N/M)"`, `failed=False` (agent/turn_finalizer.py:138, 685-690). |
| `run_budget_seconds` | **Not a hard stop.** At 80% of the budget a one-shot `[SYSTEM NOTICE ... run time budget nearly exhausted]` is appended to the newest tool result (agent/conversation_loop.py:126-159, 78-82; agent/turn_iteration_prep.py:185-186). It also caps implicit stale-stream timeouts at half the remaining budget (agent/chat_completion_helpers.py:678-687). Normalised by agent/agent_init.py:230-239; config fallback `agent.run_budget_seconds` (:1300-1303). A wall-clock hard stop must come from the wrapper. [V] | none |
| `max_tokens` (`finish_reason == "length"`) | Not a stop: `recover_from_truncation` boosts the output cap and continues (agent/turn_response_check.py:173-191; agent/turn_iteration_prep.py:549-552). [V] | — |
| Model finishes (text, no tool calls) | `finish_text_response` unless a stop gate nudges it to continue. [V] | `completed=True`, `turn_exit_reason="text_response(finish_reason=stop)"` |
| Provider errors | Retries (`api_max_retries`), credential rotation, `fallback_model` chain, then `break`. [V] agent/turn_api_error.py:52-236, turn_response_check.py:236-352 | `failed=True`, `error`, `failure_reason`, `failure_retryable` (turn_failure_copy.py:42-46, 120-138) |
| Interrupt | `agent.interrupt()` (InterruptControlMixin) → `begin_iteration` break or `InterruptedError` during the call (agent/turn_api_call.py:177-217). | `interrupted=True`, `completed=False` |
| Tool guardrail halt | agent/turn_tool_round.py:184-198 | `turn_exit_reason="guardrail_halt"`, `result["guardrail"]` |
| Session-DB write failure | agent/turn_tool_round.py:145-153, 176-182 | `failed=True`, `failure_reason="session_persistence_failed:<cause>"` |
| Context overflow that compression cannot fix | agent/conversation_loop.py:1198-1223, 1435-1452 | `partial=True`, `compression_exhausted=True`, `failure_reason="context_overflow"` |
| Content-policy refusal | agent/conversation_loop.py:1140-1149 | `failed=True`, `failure_reason="content_policy_blocked"` |
| Turn lease not acquired (another process on the same session) | agent/turn_facade_lease.py:443-493 | `api_calls=0`, `failure_reason="session_busy"` or `interrupted=True` |
| Repeated outer-loop exceptions | agent/turn_loop_errors.py:149-168 | `turn_exit_reason` starts with `repeated_outer_errors(` or `error_near_max_iterations(` |

---

## 3. Model routing

### 3.1 How `api_mode` resolves [V] agent/agent_init.py:294-342 (`_resolve_api_mode`), then :345-427 (`_finalize_routing`)

Ordered ladder, first match wins (`host`/`url` are the lower-cased `base_url` hostname/URL):

1. Actual route (`provider == "actual"` or host `api.actual.inc`) → `chat_completions`.
2. **Explicit `api_mode`** in `{chat_completions, codex_responses, anthropic_messages, bedrock_converse, codex_app_server}` (:288-291) or a plugin-registered transport → used as-is.
3. `provider in {openai-codex, xai, xai-oauth}` → `codex_responses`.
4. No provider and host `chatgpt.com` + `/backend-api/codex`, or host `api.x.ai` → `codex_responses`.
5. `provider == "anthropic"` or host `api.anthropic.com` → `anthropic_messages`.
6. **URL ends with `/anthropic`** → `anthropic_messages` (:316-318).
7. Bedrock → `bedrock_converse`.
8. Nous → dual-wire by model.
9. Otherwise `host_mandated_api_mode(base_url)` (hermes_cli/providers.py:399-430: exact hostnames `api.anthropic.com`, official OpenAI hosts and a list of Responses-native hosts) else **`chat_completions`**.

Then `_finalize_routing`:

- `normalize_model_for_provider(model, provider)` unless the provider is an aggregator (hermes_cli/model_normalize.py:203-262). For an empty or `custom` provider the name passes through unchanged (:261-262). [V] For `provider="anthropic"` dots become hyphens (:36-37, 226-228).
- **GPT-5.x auto-upgrade to `codex_responses`** (agent/agent_init.py:393-418): applies when `api_mode` was **not** passed explicitly, the resolved mode is `chat_completions`, the URL is not ACP/Azure, and either the host is `api.openai.com` or `_provider_model_requires_responses_api(model, provider)` is true. That predicate (run_agent.py:635-657) returns **False for `provider in {"nous", "custom"}`** and for external-process providers, consults a provider profile if one exists, and otherwise falls back to `model.lower().rsplit("/",1)[-1].startswith("gpt-5")` (run_agent.py:629-632).

### 3.2 Consequences for the platform (custom `base_url`, e.g. a LiteLLM proxy)

| Call | Result | Why |
| --- | --- | --- |
| `AIAgent(base_url="http://proxy/v1", model="claude-sonnet-5-5")`, no provider | `chat_completions` | No branch matches; falls to the default (:342). The model name is not inspected for routing. [V] |
| same with `model="gemini-3.8-flash"` | `chat_completions` | same [V] |
| same with `model="gpt-5.5"` (or `openai/gpt-5.5`), **no provider** | **`codex_responses`** (Responses API `/responses`) | provider `""` is not `nous`/`custom`; no profile; name starts with `gpt-5` (agent/agent_init.py:403-415, run_agent.py:629-657). A proxy that only serves `/chat/completions` would 404. [V] |
| same with `provider="custom"` | `chat_completions` | `_provider_model_requires_responses_api` returns False for `custom` (run_agent.py:641-642). [V] |
| any model with `api_mode="chat_completions"` | `chat_completions` | explicit mode is respected everywhere (:301-304, :404). [V] |
| `base_url` ending in `/anthropic` | `anthropic_messages` (Anthropic SDK) | :316-318 [V] |

**Recommendation [I]:** always pass `api_mode="chat_completions"` and `provider="custom"` for proxy runs, so neither the host nor the model name can move the wire protocol.

### 3.3 Behaviour that keys off the model name on the `chat_completions` path

- **Context window** (drives compression threshold): `get_model_context_length` (agent/model_metadata.py:2211-2325). Order: config `model.context_length` → custom_providers entry → endpoint cache → provider profile → persistent cache → **for a custom URL, `_resolve_custom_endpoint_context_length`** (:2288-2290 → :2052-2081): live `GET {base_url}/models` → local-server probes → hard-coded table keyed by longest substring match (`DEFAULT_CONTEXT_LENGTHS` :296-365, e.g. `"claude-sonnet-5": 1000000`, `"claude": 200000`, `"gemini": 1048576`, `"gpt-5": 400000`) → `DEFAULT_FALLBACK_CONTEXT = CONTEXT_PROBE_TIERS[0] = 256_000` (:259-260, 2081). [V] So the window the proxy reports in `/models` wins; a real model name not reported there gets the catalog value; a **neutral alias** such as `trial-model` gets 256k, so with the default `compression.threshold: 0.50` it compresses at about 128k tokens whatever the real window is. [I]
- **`max_tokens` wire key**: `max_completion_tokens` for `gpt-4o*`, `gpt-4.1*`, `gpt-5*`, `o1/o3/o4` (utils.py:840-843, run_agent.py:659-672), else `max_tokens`.
- **Prompt-cache markers**: `"claude" in model` is the gate for envelope `cache_control` on OpenAI-wire LiteLLM routes (agent/agent_runtime_helpers.py:1767, 1786-1788, 1833-1834). See section 4.
- **Reasoning params**: `_supports_reasoning_extra_body` (agent/reasoning_params.py:92-123) returns **False for a generic custom URL** (only Nous, Vercel, LM Studio, Ollama Cloud, OpenRouter with a known family pass), so `reasoning_config` is **not sent** on the wire to a plain proxy. Gemini `thinking_config` is added only when `provider == "gemini"` (agent/transports/chat_completions.py:629-640). Kimi/TokenHub `reasoning_effort` only by host (:594-603). [V]
- **Temperature omission predicates** exist for Kimi, OpenAI reasoning families and Gemini ≥ 3.6 (agent/auxiliary_client.py:663-678, 644-649, 595-598; agent/gemini_native_adapter.py:136-139) but on the main loop's legacy path they are **dead**: see section 4.1.
- **Compression threshold overrides** for Arcee and Codex-route GPT-5.x (agent/auxiliary_client.py:681-696).
- **Mistral tool-id rewriting** by model marker (agent/transports/chat_completions.py:433-440); **Moonshot schema sanitising** `is_moonshot_model` (:405).
- **Reasoning carrier replay** (`reasoning_content`/`reasoning_details`) by provider/host table (agent/message_sanitization.py:654-679).

Vendor prefixes (`openai/`, `anthropic/`) are stripped before most of these checks (`_strip_provider_prefix`, `rsplit("/",1)[-1]`), so `anthropic/claude-sonnet-5-5` and `claude-sonnet-5-5` behave the same. [V]

---

## 4. Request parameters

`build_api_kwargs` (agent/chat_completion_helpers.py:1503-1539) dispatches by `api_mode`; for `chat_completions` it calls `_build_chat_completions_kwargs` (:1437-1500) → `ChatCompletionsTransport.build_kwargs` (agent/transports/chat_completions.py:565-649). Two paths: a **profile path** when the provider has a registered `ProviderProfile` (`_build_kwargs_from_profile` :651-702) and a **legacy flag path** otherwise (:583-649). `provider=None/""/"custom"` has no profile (providers/__init__.py:218-255, unless a `custom_providers` entry names it), so the **legacy path** is what a proxy run uses. [V]

### 4.1 Temperature [V]

- Not a constructor argument. The agent never passes `params["temperature"]` (`_common` at agent/chat_completion_helpers.py:1466-1481 has no temperature key).
- `_base_kwargs` (agent/transports/chat_completions.py:388-404) sets `temperature` **only on the profile path**, from `profile.fixed_temperature` or `params["temperature"]`. On the legacy path (`profile=None`) nothing sets it.
- The `fixed_temperature`/`omit_temperature` params that `_build_chat_completions_kwargs` passes (:1496-1497) are **never read** by `build_kwargs` (the only consumers are :391-402, profile path). So `_fixed_temperature_for_model` has no effect on main-loop requests through a proxy.
- **`request_overrides` does reach the body**: legacy path `api_kwargs.update(params["request_overrides"])` (:644-645); profile path merges `extra_body` dicts and sets every other key top-level (:681-685). So `request_overrides={"temperature": 0.0, "top_p": 1.0, "seed": 7}` lands as top-level `chat.completions.create` kwargs. Keys the OpenAI SDK does not know must go under `request_overrides["extra_body"]`.
- Consumed via `effective_request_overrides(agent)` (agent/fast_mode.py:77-94), which copies `agent.request_overrides` and may add `speed`/service-tier keys only when `service_tier` is set.
- Caveat [?]: on a 400 "unsupported temperature" the loop's error classifier may rotate/fallback; whether it strips the override and retries was not traced.

### 4.2 `max_tokens`, `top_p`, `seed`, reasoning

- `max_tokens` (constructor) → `_apply_max_tokens` (agent/transports/chat_completions.py:376-385) through `agent._max_tokens_param` (run_agent.py:659-672). `None` → key omitted (legacy path has no profile default). A `length` truncation sets an ephemeral boosted cap for the retry (`_ephemeral_max_output_tokens`, agent/turn_iteration_prep.py:543-547). [V]
- `top_p`, `seed`: no constructor args; only via `request_overrides`. [V]
- `reasoning_config` (constructor, e.g. `{"effort": "low"}`) → `extra_body["reasoning"]` only when `_supports_reasoning_extra_body()` is true (:618-628), which is false for a generic custom URL (section 3.3). Effort vocabulary is clamped to the OpenAI-compat set (:158-168). [V]
- `prompt_cache_key` (OpenAI's server-side cache routing) is added only for `api.openai.com` or a profile declaring support (:646-648, 77-120). Not for a proxy. [V]
- `extra_body` additions on legacy path: OpenRouter provider prefs, Kimi thinking, reasoning, Gemini thinking, custom_providers `extra_body` (agent/agent_init.py:180-229 merges into `request_overrides`; not read in detail [I]). [V/I]

### 4.3 Prompt-cache markers (`cache_control`) [V]

Policy: `anthropic_prompt_cache_policy` (agent/agent_runtime_helpers.py:1739-1850) → `(agent._use_prompt_caching, agent._use_native_cache_layout)` at init (agent/agent_init.py:574-619). On `chat_completions` the markers are the "envelope" layout: `cache_control` on message dicts and tool entries, applied per request by `build_prompt_cache_plan` (agent/turn_request_assembly.py:207-231; re-applied per attempt agent/conversation_loop.py:1284-1333). They are sent when:

- the route is a **LiteLLM route** — the token `litellm` appears as a whole delimited token in the provider id or the `base_url` **hostname** (`_is_litellm_route` :1669-1679) — **and** `"claude" in model.lower()` (:1786-1788, :1833-1834); or
- a `custom_providers` config entry for that base_url/model declares `prompt_caching: true/false` (:1789-1803), which wins either way; or
- OpenRouter/Nous Portal with Claude/Kimi, Alibaba/Qwen families (:1818-1848).

Otherwise `(False, False)`: **no markers**. Also `prompt_caching.cache_ttl` set to an "off" value disables caching entirely (agent/agent_init.py:606-611). Part-level markers on `role:tool` are suppressed on LiteLLM routes (agent/prompt_caching.py:23-32).

**Consequence [I]:** whether a Claude trial through the proxy carries `cache_control` depends on the proxy's **hostname** (e.g. `http://litellm:4000/v1` yes, `http://127.0.0.1:4000/v1` no). The platform should pin this explicitly (hostname choice, or a `custom_providers` capability entry) so it is identical across arms.

### 4.4 Streaming, headers, timeouts

- Streaming is on by default even with no display consumers (`_should_stream` agent/turn_api_call.py:46-69); `stream_options={"include_usage": true}` is requested (agent/chat_completion_helpers.py:2944-2947) so usage arrives in the final chunk. Disable per agent with config `model.streaming: false` (agent/agent_init.py:1151-1154) or by setting `agent._disable_streaming = True` after init [I]. Usage-less streams are still counted as calls (agent/turn_usage.py:85-99).
- Request timeout: `agent._resolved_api_call_timeout()` (run_agent.py:533) from `hermes_cli/timeouts.py:33-35` config (`providers.<id>.timeout_seconds`); default value not traced [?].
- Per-request headers: provider route hooks (first call of a user turn) and session-affinity headers (agent/turn_api_request.py:43-57; agent/chat_completion_helpers.py:1503-1520). A `User-Agent` comes from `providers/base.py:28`. [V]

---

## 5. Callbacks

All constructor callbacks are stored verbatim as `agent.<name>` (agent/agent_init.py:2196-2198; list agent/agent_init_params.py:23-33) and are called synchronously on the loop thread, exceptions swallowed. Payload shapes:

| Callback | Signature | Payload | When it fires |
| --- | --- | --- | --- |
| `step_callback` | `(api_call_count: int, previous_tool_round: list)` | `previous_tool_round` = `[{"name", "arguments", "result"}]` for the newest assistant tool batch (agent/turn_iteration_prep.py:261-282) | Start of **every** iteration, after `api_call_count` is incremented, **before** the request is built (:158-163). Not fired for the final-response iteration's result. [V] |
| `tool_start_callback` | `(tool_call_id, function_name, display_args)` | `display_args` = args with secrets redacted | Just before a tool runs (agent/tool_executor.py:1007-1030). [V] |
| `tool_complete_callback` | `(tool_call_id, function_name, display_args, result)` | raw `result` (str or multimodal dict) | After the tool returns and the row is persisted; **not** fired for blocked calls (:1047-1055). [V] |
| `tool_progress_callback` | `(event: str, tool_name, preview, display_args, **kw)` | events: `"tool.started"` (:1023-1029), `"tool.completed"` with `duration=`, `is_error=`, `result=` (:1166-1172), `"tool.output_risk"` with `tool_call_id=`, `risk_metadata=` (:1056-1060), `"reasoning.available"` with first 500 chars of reasoning (agent/turn_response_intake.py:160), `"_thinking"` (:145), plus `tool.progress` relayed from tools (agent/tool_progress_relay.py) | Tool lifecycle; the only callback carrying **tool duration**. [V] |
| `tool_result_metadata_callback` | `(tool_call_id, function_name, display_args, function_result) -> dict` | return value stored as `display_metadata` on the tool row | Before the tool row is appended (:1153-1161). [V] |
| `event_callback` | `(event_type: str, context: dict)` | **only** `"session:compress"` with `{platform, session_id, old_session_id, in_place, compression_count}` (agent/conversation_compression.py:3421-3430; codex variant agent/codex_runtime.py:247-252) | After a committed compaction. Nothing else uses it. [V] |
| `stream_delta_callback` | `(text: str \| None)` | text deltas; `None` = flush before tools (agent/turn_tool_round.py:162-164) | Streaming (agent/stream_delivery.py:332). [V] |
| `reasoning_callback` | `(text: str)` | reasoning deltas, or whole reasoning when not streaming (agent/stream_delivery.py:370-382; agent/chat_completion_helpers.py:1569-1571) | [V] |
| `thinking_callback` | `(text: str)` | spinner label, `""` to clear (agent/turn_iteration_prep.py:321-324; agent/turn_api_call.py:26-32) | UI only. [V] |
| `interim_assistant_callback` | `(visible: str, already_streamed: bool)` | mid-turn assistant commentary (content that accompanied tool calls) (agent/stream_delivery.py:209-220) | [V] |
| `status_callback` | `(kind: str, message)` | `kind` in `"lifecycle"`, `"warn"`, `"compacted"`; `message` may be a `DiagnosticText` (agent/status_output.py:89-97, 110-121; agent/conversation_compression.py:99, 2130) | Diagnostics: retries, fallback, compression, budget exhaustion, memory recall indicator. [V] |
| `notice_callback` / `notice_clear_callback` | `(notice)` / `(key)` | UI notices (agent/status_output.py:195-201) | [V] |
| `tool_gen_callback` | `(tool_name)` | tool call being generated in the stream (agent/stream_delivery.py:398) | [V] |
| `reaction_callback` | `(kind: str)` | emoji reaction kind (agent/turn_context.py:777-795) | gateway UX. [V] |
| `connection_callback`, `clarify_callback`, `read_*`, `drive_preview_callback`, `tour_callback`, `theme_callback`, `setup_beat_callback` | various | connector auth, clarifying questions, TUI panes | Tool-driven UI; not trace surfaces. [V for existence] |
| `stream_callback` (run_conversation arg) | `(text)` | text deltas for TTS (agent/turn_context.py:583) | [V] |

**What has no constructor callback:** the LLM request/response itself, token usage, latency, memory reads/writes, skill invocations, errors, and budget stops. Those surface through the **plugin hook system** (`hermes_cli/lifecycle.py:30-37` → `hermes_cli/plugins.py:1800-1818`), `VALID_HOOKS` at hermes_cli/plugins.py:109-203:

| Hook | Payload (kwargs) | Fires |
| --- | --- | --- |
| `pre_api_request` | `task_id, turn_id, api_request_id, session_id, user_message, conversation_history, platform, model, provider, base_url, api_mode, api_call_count, retry_count, request_messages (list), system_prompt, message_count, tool_count, approx_input_tokens, request_char_count, max_tokens, started_at, middleware_trace, request={"method","body"}` | Before every provider attempt (agent/turn_api_request.py:60-107). `request["body"]` is the full `api_kwargs` minus `timeout`/`http_client`, **JSON-sanitised and size-capped** (strings cut at 8000 chars, 200 items per list, 50k chars total by default via `HERMES_PLUGIN_PAYLOAD_MAX_CHARS`; agent/api_request_hooks.py:52-140). `request_messages` and `system_prompt` are the un-truncated lists. [V] |
| `post_api_request` | `... api_duration, started_at, ended_at, first_chunk_at, finish_reason, message_count, response_model, response={model, upstream_provider, finish_reason, assistant_message{role,content,tool_calls}, usage}, usage (normalised buckets), context_length, assistant_message (raw SDK object), assistant_content_chars, assistant_tool_call_count` | After every successful response (agent/turn_response_intake.py:66-108). `first_chunk_at - started_at` = TTFB (agent/chat_completion_helpers.py:3972-3973). **Not** fired for the max-iterations summary call or auxiliary calls. [V] |
| `api_request_error` | `... api_duration, status_code, retry_count, max_retries, retryable, reason, error={type,message}, request` | Each failed/invalid attempt (agent/api_request_hooks.py:163-198; agent/turn_response_check.py:259-266). [V] |
| `pre_tool_call` | `tool_name, args, task_id, session_id, tool_call_id, turn_id, api_request_id, middleware_trace`; may return `{"action": "block"/"approve"/"modify"}` | Before dispatch (hermes_cli/plugins.py:1907-1960; agent/tool_executor.py:661-676). [V] |
| `post_tool_call` | `tool_name, args, result, task_id, session_id, tool_call_id, turn_id, api_request_id, duration_ms, status, error_type, error_message, middleware_trace` | Once per tool call, including blocked/cancelled (model_tools.py:687-711 via agent/inline_tool_executors.py:31-60). [V] |
| `pre_llm_call` | `session_id, task_id, turn_id, user_message, conversation_history, is_first_turn, model, platform, ...` ; return `{"context": ...}` or `{"action": "block"}` | Once per turn before the first call (agent/turn_context.py:849-910). [V] |
| `post_llm_call`, `transform_llm_output` | final response text | Finalizer (agent/turn_finalizer.py:470-508). [V] |
| `on_session_start` / `on_session_end` | `session_id, model, platform` / `+ task_id, turn_id, completed, failed, interrupted, turn_exit_reason` | First prompt build (agent/conversation_loop.py:932-936) / every finalize (agent/turn_finalizer.py:886-897). [V] |
| `on_stream_start/delta/end`, `on_interim_message` | normalised text/lifecycle | Streaming observers (agent/plugin_stream_hooks). [V for names] |
| `post_compaction` | compaction record (agent/compaction_events.py:175-262) | Once per committed compaction. [V] |
| `on_skill_lifecycle` | `action in {loaded, created, patched, edited, installed}, skill_name, provenance, task_id, session_id, use_count, reused, reuse_after_patch` | After a skill state change (tools/skill_usage.py:470-542). Viewing a skill is otherwise just a `skill_view` tool call. [V] |
| `pre_auxiliary_call` / `post_auxiliary_call` | same shape as the api hooks plus `aux_task` | Compression summaries, titling, vision, review forks. [V for names, hermes_cli/plugins.py:119-124] |
| middleware `llm_request` / `llm_execution` | `request` (deep copy) / `next_call(request)` | Can rewrite the payload or wrap the actual provider call; the execution wrapper sees the raw SDK response object (hermes_cli/middleware.py:88-141, 162-215). [V] |

**Registration.** Hooks are registered by a plugin package (directory with `__init__.py` exposing `register(ctx)`; `ctx.register_hook(name, cb)` / `ctx.register_middleware(kind, cb)`, hermes_cli/plugins.py:935-943) discovered from `HERMES_HOME/plugins` or `cwd/.hermes/plugins` (hermes_cli/plugins_discovery.py:210-214). Hook callbacks are time-bounded (`plugins.hook_callback_timeout`, default 30s) and run in-process on the loop thread. A programmatic in-process registration without a plugin directory was not found [?] (`get_plugin_manager().track_hook` needs a `PluginContext`). Hooks are globally disabled under the "safe worker" policy (hermes_cli/lifecycle.py:30-37; agent/safe_worker_policy.py:72-74).

---

## 6. Result dict

### 6.1 Normal path (`finalize_turn`) [V] agent/turn_finalizer.py:786-853, plus agent/conversation_loop.py:1855-1861

```
final_response: str | None          last_reasoning: str | None
messages: list[dict]                api_calls: int
completed: bool                     turn_exit_reason: str
failed: bool                        partial: False
interrupted: bool                   response_transformed: bool
pre_transform_response              response_previewed: bool
response_reused: bool               model, requested_model/served_model (result_model_fields), provider, base_url
input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
prompt_tokens, completion_tokens, total_tokens        # agent.session_* cumulative counters
last_prompt_tokens                  estimated_cost_usd, cost_status, cost_source
service_tier                        session_id
user_intervened: bool               turn_id, current_turn_user_idx (only when provable)
# optional:
guardrail, error, failure_reason, failure_retryable, cleanup_errors, pending_steer, interrupt_message,
compression_exhausted, compression_deferred
```

`completed = final_response is not None and not failed and not interrupted and (api_calls < max_iterations or exit reason starts with "text_response(")` (:685-690). `partial` is always `False` here (set `True` only by `_partial_turn_result`). The token keys are **per-agent cumulative** (`agent.session_*`, reset only by `reset_session_state` run_agent.py:379-395), so one `AIAgent` per trial makes them per-trial. Cost comes from `estimate_usage_cost` (agent/turn_usage.py:232-252 → agent/usage_pricing.py); `cost_status`/`cost_source` say whether a price table was found. The pricing source for an arbitrary proxy model was not traced [?].

### 6.2 Early-return shapes (no token/cost keys) [V]

| Builder | Keys |
| --- | --- |
| `_partial_turn_result` (agent/conversation_loop.py:1152-1160) | `final_response, messages, completed=False, api_calls, error, partial=True` + flags (`failed`, `compression_deferred`, `compression_exhausted`, `turn_exit_reason`, `failure_reason`, `failure_retryable`, `session_id`) |
| `_content_policy_blocked_result` (:1140-1149) | `..., failed=True, error="content_policy_blocked: ...", failure_reason, failure_retryable=False` |
| invalid response after retries (agent/turn_response_check.py:326-333) | `final_response, messages, completed=False, api_calls, error, failed=True, failure_reason, failure_retryable=True` |
| interpreter shutdown (agent/turn_api_error.py:118-119) | `completed=False, failed=True, error, failure_reason="interpreter_shutdown"` |
| lease not acquired (agent/turn_facade_lease.py:443-493) | `messages=history, api_calls=0, completed=False` + `interrupted=True` or `failed=True, failure_reason="session_busy"` |
| preflight compression timeout (:1435-1452) | partial result with `api_calls=0`, `failure_reason="context_overflow"` |

A wrapper must read token totals with `.get(..., None)` and treat their absence as "unknown", never zero.

### 6.3 Messages and the system prompt [V]

- `result["messages"]` is the live transcript: the copied `conversation_history`, the user row (with a `timestamp` and an `api_content` sidecar that holds the exact user text sent, including any injected memory/plugin context; agent/turn_context.py:997-1043), assistant rows from `build_assistant_message` (agent/chat_completion_helpers.py:1638-1700: `role, content, reasoning, finish_reason, timestamp`, optional `tool_calls`, `reasoning_content`, `reasoning_details`), and tool rows from `make_tool_result_message` (agent/tool_dispatch_helpers.py:448-470: `role="tool", name, tool_name, content, tool_call_id, timestamp`; high-risk tool output is wrapped in untrusted-data delimiters). Persistence-only fields are listed at agent/message_metadata.py:46-54.
- **The system prompt is not in `messages`.** It lives on `agent._cached_system_prompt` (set at agent/turn_context.py:1201-1203) and is prepended only to the wire copy (agent/turn_context.py:1424-1428, `effective_system = cached + ephemeral_system_prompt`). Read it verbatim from `agent._cached_system_prompt` after the first turn, from the `system_prompt` kwarg of `pre_api_request` (agent/turn_api_request.py:96), from `request["body"]["messages"][0]`, or from the `sessions.system_prompt` column when a `session_db` is attached (run_agent.py:329-339).
- The wire messages differ from `messages` (sanitising, `api_content` substitution, cache markers, prefill, dropped thinking-only rows). The exact bytes per call are available only via `pre_api_request`'s `request` (truncated by default, see 5), an `llm_request` middleware (deep copy, untruncated), or `HERMES_DUMP_REQUESTS=1`, which writes `request_dump_<session>_<ts>.json` to `HERMES_HOME/sessions/` (agent/agent_runtime_helpers.py:1518-1565; agent/agent_init.py:1103).
- Compaction and alternation repair **rewrite `messages` in place** (section 8); the returned list is the post-rewrite view.
- `save_trajectories=True` appends a ShareGPT-style `{"from","value"}` conversion to `trajectory_samples.jsonl`/`failed_trajectories.jsonl` in the **current working directory** (agent/session_persistence.py:599-604; agent/trajectory.py:37-56; agent/agent_runtime_helpers.py:169-195). It is lossy (text only) and not a substitute for `messages`.

---

## 7. Trace capture map

| Trace element | Where to capture | Cite |
| --- | --- | --- |
| Rendered system prompt (verbatim) | `agent._cached_system_prompt` after the first `run_conversation`; or `pre_api_request` kwarg `system_prompt`; or `request["body"]["messages"][0]["content"]` | agent/turn_context.py:1201-1203, 1424-1428; agent/turn_api_request.py:96 |
| Each LLM request (exact body) | `pre_api_request` hook `request` (sanitised/truncated) or `request_messages` (full list) + `api_kwargs`; `llm_request` middleware for the untruncated deep copy; `HERMES_DUMP_REQUESTS=1` for an on-disk JSON per attempt | agent/turn_api_request.py:60-107, 156-166, 201-202; agent/api_request_hooks.py:134-140; agent/agent_runtime_helpers.py:1518-1565 |
| Each LLM response | `post_api_request` hook (`response`, `assistant_message`, `finish_reason`, `usage`); `llm_execution` middleware returns the raw SDK/stream-stub object | agent/turn_response_intake.py:66-108; hermes_cli/middleware.py:136-141 |
| Retries / provider errors | `api_request_error` hook (status, retry_count, reason, request); `status_callback("warn"/"lifecycle", ...)` | agent/api_request_hooks.py:163-198; agent/turn_response_check.py:259-266 |
| Tool call start | `tool_start_callback(call_id, name, args)`; `pre_tool_call` hook; `tool_progress_callback("tool.started", ...)` | agent/tool_executor.py:1030, 1029, 661-676 |
| Tool result + duration | `tool_complete_callback(call_id, name, args, result)`; `tool_progress_callback("tool.completed", duration=, is_error=, result=)`; `post_tool_call` hook (`duration_ms`, `status`, `error_type`); the tool row in `result["messages"]` (persisted/elided content) | agent/tool_executor.py:1049-1055, 1166-1172; model_tools.py:687-711 |
| Memory read (built-in MEMORY.md/USER.md) | Appears only inside the system prompt volatile tier (`_memory_parts`); read `agent._cached_system_prompt` or the `MEMORY.md`/`USER.md` files under `HERMES_HOME/memories/` | agent/system_prompt.py:522-548, 787; tools/memory_tool.py:38-40 |
| Memory read (external provider prefetch) | `<memory-context>` block inside the user row's `api_content` sidecar and in `pre_api_request.request_messages`; `status_callback("lifecycle", recall_indicator)` | agent/turn_context.py:119, 966-995, 1261-1284 |
| Memory write (model-initiated) | It is a tool call named `memory` → tool callbacks/hooks; effect is a write to `HERMES_HOME/memories/{MEMORY,USER}.md` | tools/memory_tool.py:222-238; tools/memory_tool_store.py:303 |
| Memory/skill write (background review) | Daemon thread `bg-review` spawned after the turn when `_should_review_memory`/skills nudge fires; gate with `skip_background_review=True` (or config `background_review.enabled: false`). Its calls are auxiliary (`pre/post_auxiliary_call`), not in result totals | agent/turn_finalizer.py:591-616; run_agent.py:752-823; agent/turn_context.py:765-775 |
| Skill invocation | Tool calls `skill_view`/`skills_list`/`skill_manage` via tool callbacks; `on_skill_lifecycle` hook for loaded/created/patched/edited/installed | tools/skills_tool.py:290, 613; tools/skill_usage.py:470-542 |
| Compression event | `event_callback("session:compress", ctx)`; `status_callback("compacted", ...)`; `post_compaction` hook; log `Pre-API compression ...`; result `turn_exit_reason`/`compression_exhausted`; `agent.context_compressor.compression_count` | agent/conversation_compression.py:3421-3430, 99; agent/compaction_events.py:239-262; agent/turn_preflight.py:121-128 |
| Error / abnormal exit | result `failed`, `error`, `failure_reason`, `failure_retryable`, `turn_exit_reason`; `_log_turn_exit` log line | agent/turn_finalizer.py:786-840; agent/turn_failure_copy.py:42-46, 120-138 |
| Budget stop | result `turn_exit_reason="max_iterations_reached(N/M)"` or `budget_exhausted`; `status_callback` "Iteration budget exhausted"; the extra summary call is visible only in `messages` (synthetic user row + assistant row) | agent/turn_finalizer.py:124-195; agent/turn_iteration_prep.py:412-416 |
| Token usage per call | `post_api_request.usage` (normalised: `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, prompt_tokens, total_tokens`); log line `API call #N: model=... in= out= total= latency=`; `agent._last_turn_usage` (last call only) | agent/api_request_hooks.py:35-49; agent/turn_usage.py:118-127, 212-217, 165 |
| Token usage / cost per trial | result keys `*_tokens`, `estimated_cost_usd`, `cost_status`, `cost_source` (cumulative per agent, main-loop calls only) | agent/turn_finalizer.py:32-37, 807-813; agent/turn_usage.py:181-188, 232-252 |
| Latency | `post_api_request.api_duration`, `started_at`, `ended_at`, `first_chunk_at` (TTFB); `api_request_error.api_duration`; tool `duration`/`duration_ms`; `agent._api_latency_history` (last 10) | agent/turn_response_intake.py:80-86; agent/turn_response_check.py:119; agent/turn_usage.py:189-196 |
| Iteration boundary | `step_callback(api_call_count, previous_tool_round)` | agent/turn_iteration_prep.py:158-163 |
| Correlation ids | `task_id` (per run_conversation), `turn_id`, `api_request_id = f"{turn_id}:api:{n}"`, `tool_call_id`; all present on the api/tool hooks | agent/turn_context.py:588-597; agent/conversation_loop.py:1763; agent/inline_tool_executors.py:20-28 |

---

## 8. Compression

**Engine.** `agent.context_compressor = ContextCompressor(...)` built at init (agent/agent_init.py:1873-1956) from the `compression` config section (defaults hermes_cli/config_defaults.py: `enabled: True`, `threshold: 0.50` of the context window, `target_ratio: 0.20`, `protect_last_n: 20`, `max_attempts: 3`, `in_place: True`, `micro_compact: False`). `agent.compression_enabled = cs.enabled` (:1919). The summary itself is an **auxiliary LLM call** routed by `auxiliary.compression` config (`provider: "auto"` by default), i.e. not necessarily the trial's `base_url` [I from config_defaults `auxiliary` section; `_aux()` body not expanded].

**When it runs** [V]:

1. Turn start: idle compaction (opt-in) and preflight compression when the rough estimate is over threshold (agent/turn_context.py:1242-1247 → agent/turn_context_compaction.py:129-351; gated on `agent.compression_enabled` :154, 240).
2. Every iteration before the request: `run_preflight_compression` when `compressor.should_compress(request_pressure_tokens)` (agent/turn_preflight.py:88-100; `should_compress` = `tokens >= threshold_tokens` and not in cooldown, agent/context_compressor.py:3003-3016).
3. After each tool round: `compress_after_tool_results` using the provider's last `prompt_tokens` as pressure (agent/turn_preflight.py:244-320).
4. On provider context-overflow errors (agent/turn_api_error.py, agent/turn_overflow.py) [I].
5. Post-turn micro-compaction, opt-in only (agent/turn_finalizer.py:303-343).

**Effect on the record.** Compaction **replaces `messages`** (and `conversation_history`) with a summarised list; the loop re-anchors the current user row and refunds the API call it pre-empted (agent/turn_iteration_prep.py:496-524). `result["messages"]` is therefore the compacted transcript. The pre-compaction rows survive only in SessionDB (archive/lineage) when a DB is attached. The system prompt is rebuilt after compression (`invalidate_system_prompt`, agent/system_prompt.py:816-828).

**Disable.** Config `compression.enabled: false` in `HERMES_HOME/config.yaml`, or set `agent.compression_enabled = False` right after construction [I; every gate reads that attribute: agent/turn_preflight.py:89, 212, 297-301, 361; agent/turn_context_compaction.py:154, 240; agent/conversation_compression.py:1998]. Disabled compression means an over-long trial will eventually get a provider context error → `failure_reason="context_overflow"` instead of a silent rewrite; for an evaluation that is the honest outcome.

**Detect.** `event_callback("session:compress", ...)`, `status_callback("compacted", ...)`, `post_compaction` hook, `agent.context_compressor.compression_count`, `agent._last_compaction_in_place`, the `Pre-API compression:` (agent/turn_preflight.py:121-128) / `compacting context` log lines, and `turn_exit_reason` values `context_compression_*`/`compaction_handoff_not_actionable`.

---

## 9. Session DB and `hermes_state`

- `SessionDB` (hermes_state.py:464-1720) is a SQLite store, default path `HERMES_HOME/state.db` (hermes_state.py:181, 201-204). Opened in WAL mode with a writer connection, a bounded read pool, an OFD lock guard on the WAL files (hermes_state_lockguard.py), and a lazily started **token-writer daemon thread** plus `atexit` hook once `queue_token_counts` is first called (hermes_state_usage.py:107-137). Constructor: `SessionDB(db_path: Path | None = None, read_only: bool = False)` (hermes_state.py:584). Shared handles come from `hermes_state_registry.acquire(db_path)` (hermes_state_registry.py:195-274).
- **Per run it stores**: the `sessions` row (`session_id, source, model, model_config={max_iterations, reasoning_config, max_tokens}, system_prompt, user/chat ids, parent_session_id, cwd, profile_name`; run_agent.py:329-339), every transcript message (flushed before tool execution and at turn end; agent/session_persistence.py:543-588), per-call token/cost deltas (`queue_token_counts`, agent/turn_usage.py:258-282), the session title, compression lineage/archives, turn leases, and FTS indexes.
- **`session_db=None` works.** `agent._session_db = None` (agent/agent_init.py:1115). All persistence paths return early: message flush (agent/session_persistence.py:565-566), `_persist_session` (:526), token deltas (agent/turn_usage.py:258), turn lease (agent/turn_facade_lease.py:308-311), system-prompt restore (agent/conversation_loop.py:811), titling (agent/turn_context.py:205-207), failed-turn closer (agent/conversation_loop.py:1935). **One exception**: the `session_search` tool lazily opens the default `HERMES_HOME/state.db` when the model calls it (run_agent.py:290-307; agent/inline_tool_executors.py:124). Exclude that tool for isolated trials. [V]
- **Per-trial path**: construct `SessionDB(db_path=Path(trial_dir)/"state.db")` and pass it as `session_db`; set `agent._owns_session_db = True` so `agent.close()` releases it (run_agent.py:1018-1032). [V for the plumbing; I for the recommendation]
- **Other state under `HERMES_HOME`** regardless of `session_db`: `logs/`, `sessions/` (request dumps), `memories/`, `skills/`, `plugins/`, model-metadata and context-length caches (agent/model_metadata.py:153-262), `config.yaml`, `.env` (re-read each turn). A fresh `HERMES_HOME` per trial isolates all of it; `hermes_constants.set_hermes_home_override(path)` is a context-local override (hermes_constants.py:32-38) used in `get_hermes_home()` (:194-198) ahead of the env var.
- **Other background work**: NeMo Relay coordinator is a no-op without `HERMES_NEMO_RELAY_PLUGINS_TOML` (agent/relay_runtime.py:1010-1012, 1343-1360) [V]; shared metrics telemetry is **off by default** (`shared_metrics.enabled: False, send: False`, hermes_cli/config_defaults.py; hermes_cli/observability/relay_shared_metrics.py:1365-1387) [V]; `bg-review` thread (section 7); environment-probe warm thread; plugin discovery thread; OpenRouter metadata prewarm (OpenRouter only).
- `agent.close()` (run_agent.py:938-966) shuts the memory provider, task resources (terminal/VM/browser), child agents, HTTP clients, and ends/releases the session row/DB when owned. Call it per trial.

---

## 10. Logging

- `setup_logging(hermes_home=...)` runs in `init_agent` (agent/agent_init.py:629-643 → hermes_logging.py:351-430). It writes `HERMES_HOME/logs/agent.log` (INFO+) and `errors.log` (WARNING+), rotating 5 MB × 3 by default (config `logging.*`), through a `RedactingFormatter`. Format `%(asctime)s %(levelname)s%(session_tag)s %(name)s: %(message)s` (:107); `session_tag` comes from `set_session_context(session_id)` called at every turn start (hermes_logging.py:253-260; agent/turn_context.py:1132). [V]
- **Redirection per trial.** `setup_logging` is idempotent per process; a *second* home in the same process is adopted and records are routed to that home's `logs/` by a profile-routing handler (`_adopt_secondary_home` :336-349, `_ProfileRoutingFileHandler` :640). So a distinct `HERMES_HOME` per trial (process-level env var or the context-local override) gives per-trial log files; the mechanics of routing by record home were not traced in detail [I]. The simplest reliable isolation is one process (or one `HERMES_HOME`) per trial.
- Logger names: `run_agent` (agent init, facade, run_agent.py), `agent.conversation_loop` (all `turn_*` phases), `agent.tool_executor`, `hermes_state*`. Key lines: `conversation turn: session=... model=... provider=... platform=... history=N msg=...` (agent/turn_context.py:1153-1166), `API call #N: model=... in= out= total= latency=...s cache=... id=...` (agent/turn_usage.py:212-217), `Pre-API compression: ...` (agent/turn_preflight.py:121-128), `tool X completed (Ns, N chars)` / `Tool X returned error` (agent/tool_executor.py:1100-1102), turn exit summary (`_log_turn_exit`, agent/turn_finalizer.py:347).
- Stdout: unless `quiet_mode=True`, the agent prints banners, per-call progress, tool previews and assistant previews (`_vprint`, agent/status_output.py:47; tool previews agent/tool_executor.py:1012-1020). `quiet_mode=True` keeps most of it off; some diagnostics still print via `_safe_print(..., diagnostic=True)`. `verbose_logging=True` adds DEBUG records (including tool results) to the root logger.
- `HERMES_DUMP_REQUESTS=1` writes one redacted JSON per attempt to `HERMES_HOME/sessions/request_dump_*.json` (agent/agent_runtime_helpers.py:1518-1565); `HERMES_DUMP_REQUEST_STDOUT=1` also prints it.

---

## 11. Open questions

1. **Auxiliary calls' route.** Compression summaries, session titles (DB only), background review, the empty-response guard and vision calls resolve a provider via `auxiliary.*` config (`provider: "auto"` defaults) through `agent/auxiliary_client.resolve_provider_client` (:5311-5336). Whether "auto" picks the trial's `base_url`/key or falls back to OpenRouter/Nous credentials from `.env` was not traced. For trials, disable compression, background review and titling (no `session_db`) so no auxiliary call is made, and verify with the fake LLM server. [?]
2. **Temperature rejection handling.** If the proxy returns 400 for `temperature`, does the loop strip `request_overrides["temperature"]` and retry, or fail/fallback? [?]
3. **Default request timeout** when no `providers.<id>.timeout_seconds` is configured (run_agent.py:533-589; hermes_cli/timeouts.py). [?]
4. **Context-length cache across trials.** The fallback for an unreported neutral alias is resolved (256,000 tokens, agent/model_metadata.py:259-260, 2081). Still open: whether a probed or cached window written under `HERMES_HOME` (agent/model_metadata.py:153-262) leaks across trials that share a home, and what the proxy's `/models` returns for each alias. [?]
5. **Cost source** for proxy model names (`estimate_usage_cost`, agent/usage_pricing.py) — likely models.dev/OpenRouter metadata keyed by name; a LiteLLM alias may price as "unknown". [?]
6. **Programmatic hook registration** without a plugin directory. The loader API (`PluginContext.register_hook`) needs a manifest; the practical route is a tiny plugin package in the trial's `HERMES_HOME/plugins`. [?]
7. **Is the max-iterations summary call counted anywhere** (it bypasses `record_response_usage` and the api hooks)? Reading says no; confirm against the fake server's request log. [I]
8. Earlier open items not covered by this audit: bundled-skill sync paths outside the installer; whether trial API keys reach the terminal tool's environment (`tools/environments/local_env_policy.py`). [?]

---

## 12. Corrections and additions to `docs/hermes-notes.md`

1. **Python version.** `pyproject.toml:15` declares `requires-python = ">=3.11,<3.15"`, and all core dependencies carry `python_version >= '3.14'` markers (:40-49), so only 3.14 gets a working install; the comment at :12-14 says the wide range exists for the updater. The note's conclusion stands; the wording "only 3.14 is supported" should cite the marker mechanism.
2. **Result dict** is much richer than `final_response, messages, api_calls, completed, failed, error, partial`: it also carries `turn_exit_reason`, `interrupted`, all cumulative token counters, `estimated_cost_usd`/`cost_status`/`cost_source`, `model`/`provider`/`base_url`, `session_id`, `turn_id`, `failure_reason`/`failure_retryable` (section 6.1). Early-return results **lack** the token keys (6.2).
3. **Temperature.** Confirmed: `request_overrides` is the only route and it reaches the body as top-level kwargs (section 4.1). Add that Hermes' own model-name temperature rules are dead on the proxy path, so the platform fully owns sampling parameters.
4. **`max_iterations`.** Confirmed `sys.maxsize`. Add: hitting it triggers an **extra tool-less summary API call** that is invisible to `api_calls`, the token totals and the api hooks (section 2.1). `run_budget_seconds` is **not** a hard stop (section 2.1).
5. **Callbacks.** `event_callback` fires only for `session:compress`. LLM request/response, usage, latency and errors are exposed through plugin hooks (`pre_api_request`, `post_api_request`, `api_request_error`, `post_tool_call`) or middleware, not constructor callbacks (section 5). `step_callback` fires before each request, not after a response.
6. **Routing.** Neutral names stay on `chat_completions`, **but** a `gpt-5*` name with no `provider` is auto-upgraded to `codex_responses` (section 3.2). Pass `api_mode="chat_completions"` and `provider="custom"`. A `base_url` ending in `/anthropic` switches to the Anthropic SDK.
7. **Prompt-cache markers through the proxy.** Sent only when the proxy hostname (or provider id) contains the token `litellm` and the model name contains `claude`, or a `custom_providers` capability says so (section 4.3). Hostname choice changes the request bytes.
8. **Open checkbox answers.** `skip_background_review=True` stops only the post-turn review fork (memory/skill curation); the model can still write memory via the `memory` tool when the `memory` toolset is enabled, and an external memory provider would still sync (`_sync_external_memory_for_turn`, run_agent.py:888-918). Built-in memory is visible only in the rendered system prompt; external prefetch is in the user row's `api_content` and `pre_api_request.request_messages`. Per-run tokens/cost: result keys plus the `API call #N` log line plus `post_api_request.usage`.
9. **Side effects to add.** `.env` under `HERMES_HOME` is re-read every turn and can swap credentials (agent/client_lifecycle.py:755-785). Init probes `base_url/models` for the context window and raises below 64k. The `session_search` tool opens the default `state.db` even with `session_db=None`. Shared-metrics telemetry and NeMo Relay are off unless configured.
10. **`model_tools`/plugins.** Plugin discovery runs at every `AIAgent()` and loads `HERMES_HOME/plugins` and `cwd/.hermes/plugins`; a fresh home per trial avoids picking up unrelated plugins.
11. **Neutral aliases and context length** (open checkbox). Yes, they lose it unless the proxy reports the window: for a custom `base_url` Hermes takes the window from `GET {base_url}/models`, then the hard-coded name catalog, then falls back to 256,000 tokens (agent/model_metadata.py:2052-2081, 259-260). A neutral alias that `/models` does not describe therefore compresses at about 128k tokens under the default 0.50 threshold. Set `model.context_length` in the trial's `config.yaml`, or make the proxy report it.
