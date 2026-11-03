# Harness research: OpenAI Agents SDK (Python `openai-agents`)

Researched 3 Nov 2026 from the 0.24.0 sdist. Paths are `agents/...` inside the package. "Probe:" marks a behaviour I saw in offline runs on CPython 3.14.10, against a local fake Chat Completions server and a local stdio MCP server. No real LLM calls.

## 1. Pin

- **`openai-agents==0.24.0`**, released 2026-10-15 (19 days old). Fallback: 0.23.1 (10-02). New versions ship every 1–2 weeks.
- Python `>=3.10`; classifiers list 3.10–3.14. **3.14 works** (probe).
- Pins (`pyproject.toml:9-22`):
  - `openai>=3,<4` (resolved 3.42.1, built on `httpx2`)
  - `mcp>=1.19,<3` (resolved **2.3.0**, where `FastMCP` is renamed `MCPServer`)
  - `pydantic>=2.12.2,<3`
  - `litellm` extra: `litellm>=1.83.0`
- Lock the tree: the `mcp` major version changes the HTTP types ([docs](https://openai.github.io/openai-agents-python/mcp/#mcp-python-sdk-v1-and-v2)).

## 2. Minimal run (async; `Runner.run_sync` also exists)

```python
import asyncio
from openai import AsyncOpenAI
from agents import Agent, Runner, ModelSettings, RunConfig, OpenAIChatCompletionsModel, set_trace_processors
from agents.mcp import MCPServerStreamableHttp

async def run_trial(cfg):
    set_trace_processors([TrialProcessor()])          # replaces the OpenAI exporter
    client = AsyncOpenAI(base_url=cfg.base_url, api_key=cfg.key, max_retries=0)
    model = OpenAIChatCompletionsModel(model=cfg.model, openai_client=client)
    async with MCPServerStreamableHttp(params={"url": cfg.mcp_url}, cache_tools_list=True,
                                       client_session_timeout_seconds=cfg.tool_timeout) as mcp:
        agent = Agent(name="trial", instructions=cfg.system, model=model, mcp_servers=[mcp],
                      model_settings=ModelSettings(temperature=cfg.temperature,
                                                   max_tokens=cfg.max_tokens, timeout=cfg.call_timeout))
        result = await asyncio.wait_for(
            Runner.run(agent, cfg.prompt, max_turns=cfg.max_steps, hooks=TrialHooks(),
                       run_config=RunConfig(workflow_name=cfg.trial_id)),
            timeout=cfg.trial_timeout)
    return result.final_output, result.context_wrapper.usage
```

## 3. Model routing through the proxy

- **The default API is Responses** (`models/_openai_shared.py:11`). Probe: a bare name sent through `MultiProvider` becomes `OpenAIResponsesModel`, which calls `/v1/responses`.
- **Force Chat Completions by passing a model instance:** `OpenAIChatCompletionsModel(model, openai_client=AsyncOpenAI(base_url=proxy))`. Probe: it calls `POST /v1/chat/completions` with the trial key.
- The global alternative is `set_default_openai_api("chat_completions")` plus `set_default_openai_client(c, use_for_tracing=False)`. Leaving `use_for_tracing` at its default copies the proxy key into the OpenAI trace exporter (`_config.py:20-24`).
- **Prefixed names fail:** `MultiProvider` raises `UserError: Unknown prefix` for `anthropic/...` and `gemini/...` (`models/multi_provider.py:222-225`; probe). A model instance avoids this.
- **`LitellmModel`: not needed, and harmful here.** It calls `litellm.acompletion` inside the adapter (`extensions/models/litellm_model.py:631`). That is a second translation layer in front of the proxy, and the docs call it ["best-effort, beta"](https://openai.github.io/openai-agents-python/models/#litellm).

## 4. Settings mapping

- **Fields** (`model_settings.py:99-215`):
  - `temperature`
  - `max_tokens` → sent as `max_tokens`. How LiteLLM handles it for OpenAI reasoning models is unverified.
  - `parallel_tool_calls`, sent only when tools exist
  - `tool_choice`
  - `reasoning.effort` → `reasoning_effort`
  - `extra_body` / `extra_args`
- Probe: a request with only temperature and max_tokens set carried exactly `max_tokens, messages, model, temperature, tools`.
- **What the SDK adds:**
  - A `User-Agent: Agents/Python 0.24.0` header.
  - `store` and `include_usage`, only for `api.openai.com` (`models/chatcmpl_helpers.py:47-50`).
  - **A string `gpt-5*` model name gets hidden `reasoning_effort` and `verbosity:"low"`** (`run_internal/turn_preparation.py:145-166`; probe). A model instance gets none.
  - `reset_tool_choice=True` unsets `tool_choice` after a tool call (`agent.py:418`; probe).
- **What it drops:** on Chat Completions, Responses-only fields (`previous_response_id`, `prompt`, `reasoning.mode`, non-text tool outputs) are dropped with only a warning. `strict_feature_validation=True` makes them raise ([docs](https://openai.github.io/openai-agents-python/models/#chat-completions-compatibility-options)).
- **Steps:** `max_turns` (default 10). One turn is one LLM call (`run_internal/run_loop.py:1773-1779`). Probe: `max_turns=3` made 3 calls, then raised.
- **Timeout:**
  - `ModelSettings.timeout` bounds each model-call attempt and raises `ModelTimeoutError` (`run_internal/model_retry.py:288-311`; probe).
  - There is no run-level timeout, so use `asyncio.wait_for` or let the runner kill the process.
- **Retries:**
  - The `openai` client retries twice by default. Probe: two 500s then a 200 made 3 HTTP requests, yet `usage.requests == 1`.
  - Turn them off with `AsyncOpenAI(max_retries=0)` or `ModelSettings(retry=ModelRetrySettings(max_retries=0))` (`model_retry.py:525-531`). Probe: both give exactly 1 request.

## 5. Tools

- **MCP transports:** `MCPServerStdio`, `MCPServerStreamableHttp` and `MCPServerSse`, all async context managers.
- **The MCP call timeout defaults to 5 s** (`client_session_timeout_seconds`).
- **MCP schemas pass through unchanged by default.** The SDK only adds `properties:{}` when it is missing and sets `strict:false` (`mcp/util.py:547-566`).
- **`convert_schemas_to_strict=True` rewrites the schema.** Probe: optional fields become `required`, `default` is dropped and `additionalProperties:false` is added. Keep it off so every harness sends the same schema.
- **Local `@function_tool` schemas are strict by default.**
- **Tool names** are unchanged unless `include_server_in_tool_names=True`.
- **How tool errors reach the model:**
  - An MCP `isError` result passes through. Probe: the model saw `"Error executing tool lookup_order"`.
  - **Malformed JSON arguments and client-side exceptions become a fixed string:** "An error occurred while running the tool. Please try again." (`tool.py:1997-2002`; probe). The run continues.
  - **An unknown tool raises `ModelBehaviorError`.** `tool_not_found_behavior="return_error_to_model"` sends `"Tool 'nope' not found."` instead (probe).
- **MCP results go out as a list of content parts in the `role:tool` message**; function tools send a plain string (probe). Whether LiteLLM handles the list for Gemini is unverified.
- **Concurrency:** all tool calls in one turn run concurrently; `ToolExecutionConfig.max_function_tool_concurrency` caps this.
- **Hosted tools** (web search, file search, code interpreter, `HostedMCPTool`, image generation, computer, shell) are added only explicitly and raise `UserError` on Chat Completions (`models/chatcmpl_converter.py:1034`).

## 6. State and memory

- **Nothing persists by default.** No `session`, `conversation_id` or `previous_response_id`; Chat Completions cannot use the last two. Sessions (SQLite, Redis, OpenAI Conversations) are opt-in.
- `prompt_cache_key` and `store` are added only for `api.openai.com`.
- **A plain `Agent` has no memory, skills or prompt rewriting.** Those live in the opt-in `SandboxAgent` (`sandbox/memory/`). Checked from the package layout, not a full audit.
- **Stateless trial recipe:** a fresh process, Chat Completions, no session, and `strict_feature_validation=True` so a stray state field raises instead of being dropped.

## 7. Observability

- **Traces go to OpenAI by default.** The exporter POSTs to `https://api.openai.com/v1/traces/ingest` whenever `OPENAI_API_KEY` is set, and includes sensitive data (`tracing/processors.py:46,143-147`; `run_config.py:53-56`).
- **Fix:** `set_trace_processors([custom])` or `set_tracing_disabled(True)`, and never put the trial key in `OPENAI_API_KEY`.
- **A custom processor receives** `mcp_tools`, `generation`, `function` and `agent` spans (probe). A generation span holds the wire-format `input` messages, `output`, `model_config` and `usage` ([docs](https://openai.github.io/openai-agents-python/tracing/#custom-tracing-processors)).
- **`RunHooks`** (`lifecycle.py:18-117`):
  - `on_llm_start` gives the system prompt and the input items in SDK format, not wire format.
  - `on_llm_end` gives the `ModelResponse` (output, usage, request_id).
  - `on_tool_start` / `on_tool_end` give a `ToolContext` (`tool_name`, `tool_call_id`, `tool_arguments`) and the result.
  - `AgentHooks` provides the same events per agent.
- **Raw HTTP:** `AsyncOpenAI(http_client=DefaultAsyncHttpxClient(event_hooks=...))` captures the bytes of each request and response (probe).

## 8. Usage

- **Per call:** `ModelResponse.usage`, available in `on_llm_end` and `result.raw_responses`.
- **Total:** `result.context_wrapper.usage`, which holds the tokens, cached and reasoning token details, and a per-call `request_usage_entries` list (`usage.py:196-218`; probe).
- **Raw provider usage:** `preserve_raw_usage=True` stores it in `ModelResponse.raw_usage`.
- **Silent client retries are not counted.** LiteLLM spend logs are the ground truth for cost.

## 9. Failure behaviour

- **Exceptions:** all subclass `AgentsException` and carry `.run_data` (`exceptions.py:324-395`).
  - `MaxTurnsExceeded`: probe showed all 3 calls in `run_data.raw_responses`. `error_handlers={"max_turns": ...}` can turn it into a final output (probe).
  - `ModelTimeoutError`.
  - `ModelBehaviorError`, which is also raised for an empty `finish_reason="length"`.
- **A 429 or 500 propagates as raw `openai.RateLimitError` or `InternalServerError`, without `run_data`** (probe).
- **Malformed tool call:** see §5.

## 10. Risks for our adapter, ranked

1. **Masked tool errors** (§5) differ from other harnesses and bias comparisons. Set `failure_error_function` on the MCP server. Which error text to expose is a decision for Rishi.
2. **Hidden retries** are invisible in SDK usage. Set `max_retries=0` and pick one retry layer.
3. **Prompts can leak into OpenAI traces** if `OPENAI_API_KEY` or `use_for_tracing` is left at its default. Always install a custom processor.
4. **Routing traps:** Responses is the default, prefixed names are rejected, and `gpt-5*` strings get hidden settings. Always pass an `OpenAIChatCompletionsModel` instance.
5. **Provider errors lose `run_data`,** so the trace must be built as the run goes, from hooks and the processor.
6. **Parity details:** unknown-tool raising, the 5 s MCP timeout, `reset_tool_choice`, concurrent tools reordering the trace, and list-content tool messages.
7. **Fast releases and the `mcp` v1/v2 split:** use a lockfile in the image.

**Adapter size estimate:** about 250–300 lines, tests not included:

| Part | Lines |
| --- | --- |
| Config parsing | ~40 |
| Client, model and MCP wiring | ~50 |
| Hooks and processor mapped to our trace schema | ~100 |
| Error mapping and output | ~60 |
