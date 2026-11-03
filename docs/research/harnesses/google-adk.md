# Google ADK (`google-adk`) as an evals harness (3 Nov 2026)

Method: read the `google-adk` 2.12.0 and `litellm` 1.106.1 wheels, then probed on CPython 3.14.10 with a fake OpenAI-compatible server (request bodies logged) and a one-tool stdio MCP server. No real LLM calls; nothing installed in the repo. Tags: **[ran]** seen in the probe, **[src]** read in source, **[unverified]**. Paths are under `google/adk/` unless prefixed `litellm/`.

## 1. Pin

- **`google-adk==2.12.0`** (13 Oct). 2.13.0 (23 Oct) is under two weeks old. 1.x and 2.x ship in parallel, about one release every 10 days ([PyPI](https://pypi.org/pypi/google-adk/json)).
- Python `>=3.11`, classifiers 3.11 to 3.15. **3.14 works** [ran].
- The base package needs **no `openai`, `mcp` or `litellm`** [ran]. It does pull `google-genai` 2.34.0, FastAPI and the OpenTelemetry SDK.
- `[mcp]` gives `mcp>=1.24,<3` (resolved 2.3.0). There is no `litellm` extra. The import error points at `[extensions]` (`models/lite_llm.py:50`), which drags in langgraph, crewai and kubernetes, so install `litellm` directly (`>=1.84`; 2.13.0 caps it `<1.106.3`). `litellm` needs `openai<3` (resolved 2.54.0, as in Hermes).
- Candidates: `google-adk[mcp]==2.12.0` plus `litellm==1.106.1` (20 Oct), or `google-adk[mcp,openai]==2.12.0` with no litellm.

## 2. Minimal run [ran]

```python
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")  # before any litellm import
model = LiteLlm(model=f"openai/{c.model}", api_base=c.base_url, api_key=c.key,
                timeout=c.call_timeout_s, max_retries=0, parallel_tool_calls=False)
tools = McpToolset(connection_params=StdioConnectionParams(
    server_params=StdioServerParameters(command=c.mcp_cmd, args=c.mcp_args), timeout=60))
agent = LlmAgent(name="trial_agent", model=model, instruction=c.system_prompt, tools=[tools],
    generate_content_config=types.GenerateContentConfig(
        temperature=c.temperature, max_output_tokens=c.max_tokens),
    before_model_callback=on_llm_req, after_model_callback=on_llm_resp,
    before_tool_callback=on_tool_call, after_tool_callback=on_tool_result)
sessions = InMemorySessionService()
runner = Runner(app_name="evals", agent=agent, session_service=sessions)
s = await sessions.create_session(app_name="evals", user_id="trial")
try:
    async with asyncio.timeout(c.timeout_s):
        async for ev in runner.run_async(user_id="trial", session_id=s.id,
                new_message=types.UserContent(parts=[types.Part(text=c.prompt)]),
                run_config=RunConfig(max_llm_calls=c.max_steps)):
            record(ev)  # function calls, responses, usage_metadata, error_code
finally:
    await tools.close(); await runner.close()
```

## 3. Model routing through the proxy

- Two routes, both verified against an OpenAI-compatible URL [ran]:
  - `LiteLlm(model="openai/<alias>", api_base, api_key)`. The prefix is stripped; the proxy saw `model: "<alias>"` and `Bearer <trial key>`. `litellm_proxy/<alias>` also targets a proxy (`lite_llm.py:491`) [src].
  - `OpenAILlm(model="<alias>", client=AsyncOpenAI(base_url, api_key, max_retries=0))` (`integrations/openai/_openai_llm.py:338`), with no LiteLLM library.
- `LiteLlm` runs the LiteLLM library in-process. On import it fetches the price map from `raw.githubusercontent.com` unless `LITELLM_LOCAL_MODEL_COST_MAP=True` (`litellm/litellm_core_utils/get_model_cost_map.py:646`) [ran]. ADK sets `LITELLM_MODE=PRODUCTION` if unset, which stops `.env` autoload, and sets `litellm.add_function_to_prompt = True` (`lite_llm.py:409,413`). On every API error LiteLLM prints a banner to **stdout** unless `litellm.suppress_debug_info = True` (`litellm/litellm_core_utils/exception_mapping_utils.py:2386`) [ran]. ADK also moves LiteLLM's log handlers to stdout (`lite_llm.py:3660`).
- Gemini only via the proxy: use `openai/<gemini-alias>`. A model *string* such as `gemini-…` resolves to the native `Gemini` class, which calls Google directly, and an agent with no model defaults to `gemini-3.5-flash` (`agents/llm_agent.py:292`). Keep Google keys out of the container so a slip fails closed. `LiteLlm` round-trips Gemini `thought_signature` (`lite_llm.py:1707`); `OpenAILlm` has no handling for it, so Gemini thinking models with multi-step tools may break there [unverified].

## 4. Settings mapping

- **Temperature, max tokens**: `generate_content_config`. `LiteLlm` sends `temperature` and `max_completion_tokens` (`lite_llm.py:3388`) [ran]. `OpenAILlm` sends `max_tokens` (4096 if unset) [ran] and drops temperature for names like `gpt-5*`, `gpt-6*` or `o3*` (`integrations/openai/_openai_common.py:78,100`) [src].
- From `GenerateContentConfig`, `LiteLlm` forwards only temperature, max tokens, top_p, top_k, seed, stop and the penalties. The rest, including `thinking_config`, is dropped silently [src].
- **Steps**: `RunConfig(max_llm_calls=N)` counts model calls, not tool calls. Default 500, or `ADK_MAX_LLM_CALLS` (`agents/run_config.py:38`).
- **Timeout**: `LiteLlm(timeout=s)` per call. For the trial, `asyncio.timeout()` cancelled cleanly mid-call and the MCP subprocess was reaped [ran].
- **Parallel tool calls**: extra `LiteLlm` kwargs reach the request (`lite_llm.py:3883`), so `parallel_tool_calls=False` works [ran].
- **Retries are hidden by default.** LiteLLM gives the OpenAI SDK `max_retries=2` (`litellm/llms/openai/openai.py:747`). One 500, 429 or timeout became 3 proxy requests; with `max_retries=0`, 1 [ran]. ADK adds none (`workflow/_base_node.py:84`).
- **Added text**: the system prompt gains `You are an agent. Your internal name is "<name>".` (`flows/llm_flows/prompt/_identity.py:42`) and, with MCP tools, a fencing preamble [ran].

## 5. Tools

- `McpToolset` takes `StdioConnectionParams` or `StreamableHTTPConnectionParams(url, headers, timeout, sse_read_timeout)`, plus `tool_filter` and `tool_name_prefix` (`tools/mcp_tool/mcp_toolset.py:146`). Stdio [ran]; HTTP [src].
- **For stdio, `timeout` (default 5 s) is also each tool call's read timeout** (`tools/mcp_tool/session_context.py:448`). HTTP uses `sse_read_timeout` (300 s).
- **Schemas**: with `JSON_SCHEMA_FOR_FUNC_DECL` (experimental, default on) `inputSchema` passes through raw, with only `type` lowercased; no Gemini schema conversion [ran]. Names are unchanged unless prefixed; `transfer_to_agent`, `set_model_response` and `adk_request_*` are refused.
- **Descriptions are rewritten.** Every MCP tool and parameter description is wrapped in `<<<BEGIN_UNTRUSTED_TOOL_DESCRIPTION>>>` markers (`tools/mcp_tool/mcp_tool.py:440,460`; tool level [ran], parameters [src]). An `outputSchema` is appended to the description when it fits in 1,024 characters (`lite_llm.py:2631`). `before_model_callback` runs after all this; in the probe it restored the bare descriptions and system prompt [ran].
- **Results** reach the model as the whole `CallToolResult` in JSON, `{"content":[…],"isError":false}` [ran]. MCP or transport exceptions become `{"error": "MCP tool execution failed: …"}` (`mcp_tool.py:616`). An unknown tool name returns an error dict to the model (`flows/llm_flows/tools/_error_handler.py:79`). A plain Python tool that raises ends the run unless `on_tool_error_callback` answers (`flows/llm_flows/tools/_caller.py:585`).
- **Built-ins**: none unless sub-agents, a planner, a code executor or an output schema are set [ran].

## 6. State and memory

- Use `Runner(session_service=InMemorySessionService())` and leave memory, artifact and credential services `None`. `InMemoryRunner` adds memory and artifact services (`runners.py:2413`). Memory is written only if code calls `add_session_to_memory`. Compaction and context caching are off unless set on `App` [src].
- A fresh process per trial is stateless. With `HOME` and `TMPDIR` pointed at an empty folder, a full run wrote nothing [ran]. Only the `adk` CLI loads `.env`.

## 7. Observability

- Callbacks: `before/after_model_callback` (`LlmRequest`, `LlmResponse`), `before/after_tool_callback` (tool, args, result), `on_model_error_callback`, `on_tool_error_callback`; also available as `App` plugins. The four main ones fired [ran].
- `run_async` yields `Event`s for model turns, tool responses and a final answer [ran].
- OpenTelemetry spans go to the global tracer provider, a no-op unless we install one. Message content is captured by default (`telemetry/context.py:135`).
- Phone-home: the `adk` CLI sends consented usage metrics to `play.googleapis.com` (`cli/_telemetry/_metrics_reporter.py:43`). The library path does not [src].

## 8. Usage

Each model event, and each `LlmResponse` in `after_model_callback`, has `usage_metadata` with prompt, candidates, total, cached and thoughts tokens [ran]. There is no run total; sum the events. Failed calls carry none and hidden retries are invisible, so the proxy's spend log is the source of truth.

## 9. Failure behaviour [ran]

| Case | Result |
| --- | --- |
| Call limit | after N requests, error event, then `LlmCallsLimitExceededError` (`agents/invocation_context.py:85`) |
| 500, 429, per-call timeout | after hidden retries, error event (`InternalServerError`, `RateLimitError`, `Timeout`), then `litellm.exceptions.*` |
| Malformed tool arguments | call discarded; run ends **with no exception**, final event `error_code=MALFORMED_FUNCTION_CALL`, no second try (`lite_llm.py:3100`) |
| Trial timeout | `TimeoutError` from `asyncio.timeout` |

Error events return `is_final_response()` true, so a final event does not mean success.

## 10. Risks, ranked

1. **Prompt and tool parity**: identity line, fencing preamble, fenced descriptions, JSON-wrapped results. Strip them in `before_model_callback` or keep them as harness behaviour? Rishi's call, like D15 for Hermes.
2. **Hidden retries** skew call counts, latency and cost unless `max_retries=0`.
3. **LiteLLM side effects** (section 3); never use stdout as the result channel. `OpenAILlm` avoids them but loses thought signatures and strips temperature by model name. Route choice is open.
4. **Direct Gemini calls** from a string model or the default model.
5. **Silent failures**: malformed calls end the run cleanly, and error events look final.
6. **Stdio MCP read timeout** of 5 s by default.
7. **Churn** (section 1): default-on experimental flags can flip between releases. Pin exactly.
8. **Warm-up**: the first LLM call took 3 to 5 s against an instant fake server [ran]. Measure latency at the proxy.

**Size**: about 250 lines for the adapter (config, model, toolset, trace callbacks, event loop, usage, error mapping) plus about 150 lines of tests against the fake server.
