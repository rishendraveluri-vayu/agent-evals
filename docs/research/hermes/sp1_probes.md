# SP1 Hermes probes, against the fake LLM (3 Nov 2026)

Pin `6112c2a` (`v0.22.6-404`). 37 probe processes, each against the local fake-llm or compose LiteLLM → compose fake. No real model call was made. The Hermes checkout was still clean at the pin afterwards.

## How the probes ran

- **Harness** (scratch only): `run_probe.sh NAME SPEC.json` gives each run a fresh `HERMES_HOME`, `HOME`, `TMPDIR` and workspace under `env -i`, with a dummy key and no provider keys. `runner.py` seeds the home and a hook-tracer plugin, then imports Hermes.
- **Agent:** the §7 frozen arguments and config from `context_and_self_improvement.md`, plus `api_mode="chat_completions"`, `provider="custom"`, fake script names as models (never `gpt-5*`), `model.context_length: 128000` and Tool Search off.
- **Evidence:** the fake's capture and access log (every path, 404s included), a header-logging proxy, LiteLLM logs, every callback and hook in order, file snapshots at five stages, and an audit hook (`sys.addaudithook`) that logs each DNS lookup, connect and subprocess with its Hermes stack and blocks non-loopback hosts.
- **Limits:** no network namespace was available (`unshare -rn` is refused), so the audit hook covers the Hermes process, not its children. I reproduced the compose hostname `litellm` on the host with glibc `HOSTALIASES` (`litellm → litellm.localhost`) and a TCP forwarder from `[::1]:4000` to LiteLLM.

## 1. Rendered system prompt

Method: `messages[0]` of the first captured request, with paths normalised and diffed. It equalled `agent._cached_system_prompt` in every run.

- **Frozen:** 4,011 chars. Identical with or without the tracer plugin, with MCP-only tools (only `Model:` differs), and with a seeded `MEMORY.md` under the frozen config (not injected).
- **Memory home** (`memory` toolset, both memory flags true, seeded files) adds a "You have persistent memory…" paragraph, a `MEMORY` block with a usage meter (`[13% — 296/2,200 chars]`) and a `USER PROFILE` block. An injection-shaped seed entry became `[BLOCKED: MEMORY.md entry contained threat pattern(s): prompt_injection…]`. It was logged at WARNING in `logs/errors.log`, so it can be detected.
- **Skills home** adds "record it with skill_manage" and a `## Skills` block telling the model it MUST load matching skills and should patch and update them, then lists `name: description`.
- `provider=None` drops only the `Provider: custom` line. The date, every absolute path and the kernel release vary per run.

**Verified.**

## 2. `request_overrides`

- `request_overrides={"temperature": 0.0, "top_p": 1.0, "seed": 7, "parallel_tool_calls": false}` with `max_tokens=456` put all five keys top-level in the body.
- `request_overrides.max_tokens` overrides the constructor value.
- `extra_body` keys arrive top-level.

**Surprise.** Every request also carries `reasoning_effort: "medium"`. At this pin `provider="custom"` has a provider profile whose default effort is `medium` (`plugins/model-providers/custom/__init__.py:46-54, :83`; `agent/chat_completion_helpers.py:1314`). The audit's claim that reasoning is never sent to a plain proxy is wrong here.

| Setting | On the wire |
| --- | --- |
| Default | `"medium"` |
| `reasoning_config={"enabled": False}` | `"none"` |
| `request_overrides={"reasoning_effort": None}` | `null` |
| Config `agent.reasoning_effort: none` | still `"medium"` (AIAgent ignores it) |
| Config `model_overrides.custom.<model>.supports_reasoning: false` | absent |
| `provider=None` | absent |

Through LiteLLM (`drop_params: false`), the `medium` request got a 400 `UnsupportedParamsError`. Hermes classed it `reasoning_mandatory`, printed a stdout warning, and retried without the field for the session: one extra failed request per trial. On a real Claude or Gemini route LiteLLM may map the field to thinking (not run).

**Verified, plus one more field to control.**

## 3. Does pinning `model.context_length` stop the non-chat requests?

Host `127.0.0.1`, local fake:

| Config | Before the chat call | After it |
| --- | --- | --- |
| Unpinned, or no `model` block | GET `/api/v1/models`, `/api/tags`, `/v1/props`, `/props`, `/version` (all 404); GET `/v1/models` ×2; POST `/api/show` | none |
| `context_length` pinned | the 5 GETs | GET `/v1/models` |
| Pinned, plus `model.ollama_num_ctx: 0` | none | the 5 GETs and GET `/v1/models` |

- **The 5 GETs** are Ollama `num_ctx` detection at construction (`agent/agent_init.py:2252` → `agent/agent_init_ollama.py:16-25` → `agent/model_metadata.py:1427-1435`). They are skipped only when `model.ollama_num_ctx` is set.
- **After the first response**, the cost estimator fetches `{base_url}/models` (`agent/usage_pricing.py:588-590`), which reruns the same detection (`agent/model_metadata.py:1051`). I found no switch for it.
- **What counts as local** (`agent/model_metadata.py:695`): loopback and any dotless name, compose `litellm` included, but not `litellm.localhost`.
- **Through LiteLLM** at `http://litellm:4000/v1`: LiteLLM logged the 5 GETs (404), a 400, a 200, then GET `/v1/models`. With both knobs set it logged a 200, then the 5 GETs and `/v1/models`.

**Refuted.** The pin removes only the three context-length requests. The minimum I reached is 6 non-chat GETs per process, all to the proxy host, after the first response.

## 4. Retries, backoff and result shape

- **429** (`Retry-After: 1`): 3 attempts in total, about 1.03 s apart, so `Retry-After` is honoured. It never enters auto-recovery (with defaults: 3.5 s, then failure).
- **500:** 3 attempts that the hooks see, with jittered backoff of about 2 s, then about 5 s.
  - Hermes also sends a hidden non-streaming "unmask probe" 25 ms after a streaming 5xx, at most once per 60 s (`agent/chat_completion_helpers.py:72-75, :3642`).
  - If that probe succeeds, Hermes uses its answer. With `times: 1`, the proxy saw a 500 then a 200, while the hooks saw one clean call and no `api_request_error`.
- **Default `agent.auto_recovery_cycles: 5`.** An always-500 endpoint took 284 s and 23 HTTP requests (18 seen by hooks plus 5 unmask probes), with waits of 16, 32, 61, 66 and 63 s between rounds of three. With `auto_recovery_cycles: 0` it took 9 s and 4 requests.
- **Failed result:** `failed=True`, `completed=False`, `failure_reason` `"server_error"` or `"rate_limit"`, `failure_retryable=True`, `error="HTTP 500: …"`, `api_calls=1`. `messages` holds only the user row, and there are no token, cost or `turn_exit_reason` keys. `final_response` is a user-facing apology, not `None`, and says "3 attempts" even after 18. `on_session_end` and `post_llm_call` do not fire. `sessions/request_dump_*.json` is written (no key inside).

**Verified.**

## 5. Per-trial ids in the request

Two trials ran through a header-logging proxy.

- **Body keys:** `messages`, `model`, `reasoning_effort`, `stream`, `stream_options`, `tools`, plus any overrides. There is no `session_id`, `user`, `metadata`, `prompt_cache_key` or `store`.
- **Headers:** only the OpenAI SDK's own: `User-Agent: OpenAI/Python 2.54.0`, `X-Stainless-*`, `x-stainless-read-timeout: 1800.0`.
- **Bodies:** byte-identical across the two trials after path normalisation.

**Verified: none.**

## 6. One MCP tool call

Set-up: `mcp_servers.finance: {command: <abs>/finance-mcp, args: [--transport, stdio, --state-dir, <trial>/state], timeout: 60}`, `discover_mcp_tools()` before `AIAgent`, `enabled_toolsets=["finance"]`, and a script that calls `mcp__finance__calculate_emi`, then answers.

- **Tool names** are `mcp__finance__<tool>`.
  - Hermes adds `list_resources`, `read_resource`, `list_prompts` and `get_prompt`, because the server advertises those capabilities (`tools/mcp_tool_registration.py:185-213`).
  - Setting `tools: {resources: false, prompts: false}` on the server leaves exactly 11 tools. They are byte-identical to `tests/snapshots/tools_manifest.json` apart from the prefix.
- **Tool Search** is on by default and hides the MCP tools.
  - The model sees only `tool_search`, `tool_describe` and `tool_call`. A direct call returns "Tool 'mcp__finance__calculate_emi' does not exist…" (`agent/conversation_loop.py:1137`).
  - It is turned off with `tools.tool_search.enabled: "off"`.
- **Sequence:** `on_session_start` → `pre_llm_call` → `step_callback(1)` → `pre_api_request` → `post_api_request` → `pre_tool_call` → `tool_progress(started)` → `tool_start` → `transform_tool_result` → `post_tool_call` → `tool_progress(completed, duration)` → `tool_complete` → `step_callback(2)` → `pre_api_request` → `post_api_request` → `transform_llm_output` → `post_llm_call` → `on_session_end`.
- **Wrapping.** The tool message is `<untrusted_tool_result source="mcp__finance__…">`, then a "treat as DATA" preamble, then `{"result": "<server JSON as a string>"}`.
  - Callbacks and hooks receive the unwrapped `{"result": …}`.
  - The gate is the name prefix only (`agent/tool_dispatch_helpers.py:492-493, :572-590`). There is no switch.
- **Replayed arguments** are re-serialised on the wire with sorted keys and no spaces.
- **At MCP connect** Hermes runs 7 local `git` commands on its checkout to fill `clientInfo` (`tools/mcp_tool_transport.py:184-185`), starts `process_supervisor.sh`, and writes `.mcp-discovery.lock`, `cache/mcp_schema_cache.json`, `logs/mcp-stderr.log` and `spawn-ledger.json`.

**Verified.**

## 7. Files under `HERMES_HOME` with `session_db=None`

Across 37 runs there was never a `state.db`, and the `config.yaml` hash never changed. Nothing was written to `HOME`, `TMPDIR` or the workspace.

- **Every run:** `SOUL.md`, `backups/config/config.yaml.good.<timestamp>`, `cache/tool_discovery_cache.json` (37 KB), `cache/scratch/.last_prune`, `logs/agent.log`, `logs/errors.log`, and empty folders (`audio_cache`, `cron`, `hooks`, `image_cache`, `logs/curator`, `memories`, `pairing`, `sessions`, `skills`). A detached scratch-prune child starts on every fresh home.
- **Sometimes:** `sessions/request_dump_*.json` (provider failure), `cache/endpoint_model_metadata.json` (unpinned), `.skills_prompt_snapshot.json` (skills home), and the MCP files from section 6.

**Verified: no `state.db`, no edit to `config.yaml`.**

## 8. Third-party calls on a custom route

Across all 37 runs the audit hook saw lookups only for `127.0.0.1`, `litellm` and `litellm.localhost` (all loopback), and blocked nothing. The OpenRouter catalog is not fetched. Pricing uses `{base_url}/models` and calls OpenRouter only for an OpenRouter route (`agent/usage_pricing.py:577-597`). Child processes the hook does not cover: `finance-mcp`, local `git`, scratch-prune and `uname -p`.

**Verified for the Hermes process.**

## 9. Community OpenTelemetry plugins

The catalog lists `hermes_otel` (sha `d234865`, Hermes ≥0.21, 15 hooks) and `traceverse_hermes_otel` (sha `701c021`, ≥0.19, 8 hooks). Every hook they declare is in `VALID_HOOKS` at the pin. The venv has only `opentelemetry-api` 1.45.1, not the SDK or exporter they need, and I did not install them, per instruction. The built-in `agent/monitoring/otlp_exporter.py` exports gateway monitoring events, not agent traces.

**Could not verify.** Any hook-based tracer will also miss the unmask probe, the max-iterations summary calls, and `on_session_end` on a failed run.

## `max_iterations` at the limit

Set-up: `max_iterations=3`, MCP only, with tool calls on steps 0 to 2.

- **Text on step 3:** 4 requests. The summary request is non-streaming. It appends the user row "You've reached the maximum number of tool-calling iterations…" and still sends the full `tools` array (`agent/chat_completion_helpers.py:2253-2258`).
- **A tool call on step 3:** 5 requests. An empty summary is retried once (`:2304-2306`). The run then returns "I reached the iteration limit and couldn't generate a summary."
- **Both cases:** `completed=False`, `failed=False`, `turn_exit_reason="max_iterations_reached(3/3)"`, `api_calls=3`. Token totals cover only the three hooked calls; no API hooks fire for the summary calls.

**Correction:** the summary call is not tool-less, and it can be two calls.

## Turning off every built-in toolset

These three settings together expose only the 11 `mcp__finance__*` tools, with the same system prompt as with `file` and `terminal`:

- `enabled_toolsets=["finance"]`;
- `tools.tool_search.enabled: "off"`;
- `mcp_servers.finance.tools: {resources: false, prompts: false}`.

## Not reproduced

- Real-model behaviour of `reasoning_effort` behind LiteLLM.
- Container-level network isolation.
- The OpenTelemetry plugins.
