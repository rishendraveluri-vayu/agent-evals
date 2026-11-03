# LangGraph (with LangChain) as a harness

Research note, 3 Nov 2026. I read the source at the pinned versions in a throwaway CPython 3.14.10 venv, then ran the agent against a scripted fake OpenAI-compatible server and a local FastMCP server. No real LLM calls were made.
**Verified** means I saw it in those runs. **Source** means I read the code only. Paths are relative to `site-packages`.

## 1. Pin

Newest stable releases from on or before 20 Oct 2026:

| Package | Pin | Released | Notable requirements |
| --- | --- | --- | --- |
| langgraph | 1.2.16 | 16 Oct | checkpoint >=4.3,<5; prebuilt >=1.1,<1.2 |
| langchain (`create_agent`) | 1.4.6 | 14 Oct | langgraph >=1.2.12,<1.3 |
| langchain-core | 1.6.12 | 16 Oct | langsmith >=0.14.9 |
| langchain-openai | 1.7.2 | 14 Oct | openai >=2.45,<4 (resolved 3.35.1) |
| langchain-mcp-adapters | 0.3.2 | 6 Aug | **mcp >=1.24,<2** (resolved 1.30.0) |

- **Python.** Every package needs 3.10 or later. The langgraph classifiers stop at 3.13, but everything below ran on 3.14 (verified). The only noise was DeprecationWarnings from langsmith.
- **mcp.** The adapter caps `mcp` below 2, although 2.3.0 is out. A 1.x client talking to an mcp 2.x server is unverified.
- **Churn.** In the last two weeks langchain-core shipped 6 releases. Install with `uv pip install --exclude-newer 2026-10-20` and lock the result.

## 2. Minimal run

`create_react_agent` is deprecated (`langgraph/prebuilt/chat_agent_executor.py:274`). Use `langchain.agents.create_agent` (`langchain/agents/factory.py:846`), which compiles a LangGraph graph with a model node, a tools node and middleware hooks. A hand-built graph adds nothing for one ReAct loop.
The loop must run async, because MCP tools are coroutine-only (`langchain_core/tools/structured.py:153`). This exact code ran against the fake server and a streamable-HTTP MCP server (verified):

```python
import asyncio
from langchain.agents import create_agent
from langchain.agents.middleware import ModelCallLimitMiddleware, wrap_model_call
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_openai import ChatOpenAI

async def run_trial(t, trace):  # trace: AsyncCallbackHandler
    llm = ChatOpenAI(model=t.model, base_url=t.base_url, api_key=t.key,
                     temperature=t.temperature, max_tokens=t.max_tokens,
                     timeout=t.request_timeout, max_retries=0,
                     use_responses_api=False, disable_streaming=True)

    @wrap_model_call
    async def settings(req, handler):
        return await handler(req.override(model_settings={"parallel_tool_calls": t.parallel}))

    mcp = MultiServerMCPClient({"tasks": {"transport": "streamable_http", "url": t.mcp_url}})
    async with mcp.session("tasks") as session:  # one MCP session per trial
        agent = create_agent(llm, await load_mcp_tools(session), system_prompt=t.system,
            middleware=[ModelCallLimitMiddleware(run_limit=t.max_steps, exit_behavior="error"), settings])
        async with asyncio.timeout(t.timeout_s):
            out = await agent.ainvoke({"messages": [{"role": "user", "content": t.prompt}]},
                                      {"callbacks": [trace], "recursion_limit": 3 * t.max_steps + 5})
    return out["messages"]  # last AIMessage is the answer; check .invalid_tool_calls
```

## 3. Model routing

- **Proxy.** `ChatOpenAI(model=, base_url=, api_key=)`. An explicit `base_url` beats the `OPENAI_*` env vars and the LangSmith gateway (`langchain_core/utils/_gateway.py:106`). Without one, `LANGSMITH_GATEWAY=true` reroutes calls to LangSmith.
- **Responses API switches.** The default is Chat Completions, but the client moves to Responses on its own (`langchain_openai/chat_models/base.py:763-775, 2012-2029`) for:
  - names starting `gpt-5-pro`, `gpt-5.x-pro` or `gpt-5.6-sol`, or containing `codex`
  - `gpt-6*` names when tools are bound (verified)
  - the env var `LC_OUTPUT_VERSION=responses/v1`
  - the `reasoning`, `include` or `truncation` parameters

  `use_responses_api=False` overrides all of these (`:2013`).
- **Name-based rewrites.**
  - `gpt-5*` silently drops temperature other than 1 (`:1350-1380`, verified).
  - `o1*` forces temperature 1.
  - `^o\d` names send the system message as `developer` (`:3847`).

  Claude and Gemini names trigger none of these, so LiteLLM aliases must avoid those prefixes.

## 4. Settings mapping

| Setting | Where it goes |
| --- | --- |
| temperature | `ChatOpenAI(temperature=)` |
| max output tokens | `max_tokens=`, sent as `max_completion_tokens` (`:3829`, verified) |
| request timeout | `timeout=` per HTTP request. The SDK default is 600 s (`openai/_constants.py:7`) |
| trial timeout | None built in. Use `asyncio.timeout`, with a runner kill as backstop |
| step limit | `ModelCallLimitMiddleware(run_limit=N, exit_behavior="error")` |
| parallel_tool_calls, tool_choice | Middleware `request.override(...)` (`factory.py:1486`, verified) |
| retries | `max_retries=0`. The default falls back to the SDK's 2 retries (`openai/_constants.py:8`) |

- **`recursion_limit` is not a step count.** `create_agent` sets it to 9 999 (`factory.py:1897`). It counts supersteps: the model node, the tools node and each `before_model` hook use one each. With a limit of 5, the agent made 3 model calls (verified). A value passed at invoke time overrides the default (verified).
- **What is sent (verified).** Only `model`, `messages`, `tools`, `stream: false`, `temperature` and `max_completion_tokens`. There is no `strict`, `tool_choice`, `parallel_tool_calls` or `seed`.

## 5. Tools

- **Transports.** `MultiServerMCPClient` supports stdio, SSE, streamable HTTP and websocket (`langchain_mcp_adapters/sessions.py:445-466`). stdio and HTTP are verified.
- **Sessions.** `client.get_tools()` opens a **new MCP session for every tool call** (`client.py:174`). Use `client.session()` with `load_mcp_tools(session)`. A stdio server inherits only a small allow-list of env vars (`mcp/client/stdio/__init__.py:127`).
- **Names and schemas.**
  - Names pass through unsanitised (`tools.py:516`).
  - `convert_to_openai_tool` inlines `$ref` and strips every `title` (`langchain_core/utils/function_calling.py:143,153`, verified).
  - `strict` stays unset unless you request it.
  - Results go out as a list of text parts, not a string (verified).
- **Errors.**
  - MCP `isError` becomes `ToolMessage(status="error")` (`tools.py:527`).
  - Unknown tool names and bad arguments return an error message to the model, and the loop continues (verified).
  - **Any other tool exception kills the run**, including an MCP transport failure (`langgraph/prebuilt/tool_node.py:391-399`, verified).
- **Built-in tools.** None are added.

## 6. State and memory

- **Defaults.** `checkpointer=None`, `store=None` and `middleware=()`. No memory, summarisation or prompt rewriting runs unless you add it. State lives for one `ainvoke` only.
- **Disk.** Nothing was written to disk (verified).
- **Stateless recipe.** Never call `set_llm_cache`, and pass `cache=False` on the model.
- **tiktoken.** It is used only for token counting, for example by `SummarizationMiddleware`. When it runs, it downloads encodings over the network.

## 7. Observability

- **Callbacks** (verified):
  - `on_chat_model_start` gets the messages and `invocation_params`: the tools, `tool_choice` and the token limit.
  - `on_llm_end` gets the AIMessage with `usage_metadata`, `id` and `finish_reason`.
  - `on_llm_error` and `on_tool_start`, `on_tool_end` and `on_tool_error` cover the rest.

  For exact bytes on the wire, use httpx hooks or the LiteLLM logs.
- **Hidden retries.** With default retries, one 429 meant 3 HTTP requests but only one `on_llm_error` (verified).
- **Streaming trap.** `stream_mode="messages"` and `astream_events` switch the model to streaming (`langchain_core/language_models/chat_models.py:549`). With a custom `base_url`, **usage then comes back `None`** (verified). `disable_streaming=True` fixes it (verified).
- **Telemetry.** LangSmith tracing needs a `*_TRACING` env var set to `"true"` (`langsmith/utils.py:139`).
  - Set `LANGSMITH_TRACING=false` and `LANGCHAIN_TRACING_V2=false`.
  - Unset `LANGSMITH_API_KEY`, `LANGSMITH_GATEWAY` and `LC_OUTPUT_VERSION`.

  A grep found no other phone-home code. I did not monitor network traffic.

## 8. Usage

- **Per call.** `AIMessage.usage_metadata` holds input, output and total tokens plus cache and reasoning details.
- **Total.** Sum over the AIMessages, or use `get_usage_metadata_callback()` (`langchain_core/callbacks/usage.py:81`), which keys totals by the model name the proxy returns (verified).

## 9. Failure behaviour (verified, `max_retries=0`)

| Case | Result |
| --- | --- |
| `recursion_limit` hit | `langgraph.errors.GraphRecursionError` |
| call limit, `"error"` | `ModelCallLimitExceededError` |
| call limit, `"end"` (**the default**) | Returns normally. The last AIMessage reads "Model call limits exceeded…", which looks like an answer |
| 429 / 500 | `OpenAIRateLimitError` / `OpenAIAPIError`, subclasses of the openai errors |
| request timeout | `OpenAITimeoutError` |
| only malformed tool args | **Ends "successfully" with empty content.** The router exits when `tool_calls` is empty (`factory.py:2018`) |
| malformed plus valid | The malformed call gets an error ToolMessage, and the loop continues |

A raising `ainvoke` returns no partial state, so the trace has to come from the callbacks.

## 10. Risks for our adapter, ranked

1. **Malformed tool calls look like success.** Classify the outcome from `invalid_tool_calls`.
2. **Model names and env vars silently reshape requests.** Pin `use_responses_api=False`, scrub the env, and assert the payload in a test.
3. **Usage is lost under streaming.** Set `disable_streaming=True` and trace from callbacks.
4. **Step-limit semantics.** `recursion_limit` does not equal steps, and the default `"end"` fakes a final message.
5. **Hidden retries.** They mask 429s. Set `max_retries=0`.
6. **Tool exceptions crash the run.** Label them as infra failures.
7. **Tool parity.** Schemas are rewritten, so one shared MCP server does not mean identical schemas on the wire.
8. **Churn,** the `mcp<2` cap, and Python 3.14 missing from the classifiers.

**Size.** Roughly 250 to 350 lines of Python. The callback-to-trace mapper is about 100 of them. Fake-server tests come on top.
