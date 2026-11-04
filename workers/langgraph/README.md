# LangGraph worker

The LangGraph adapter on the shared adapter library (`workers/adapterlib`, contract v2). It runs
LangChain's `create_agent`, which compiles a LangGraph graph with a model node, a tools node and
middleware hooks. That is the recommended way to build a tool-calling agent at this pin
(`create_react_agent` is deprecated). The finance tools come from langchain-mcp-adapters, and the
model is reached through `ChatOpenAI`. It is used as it comes: each switch below is there because
a rule needs it, and nothing is stripped from what LangGraph sends.

- `src/langgraph_adapter/adapter.py`: `setup` opens the MCP sessions and builds the agent;
  `run_turn` runs one `ainvoke` and maps how it ended. About 300 lines of code, plus
  docstrings and comments.
- `src/langgraph_adapter/capabilities.json`: probed settings, the declared ones, and
  `known_differences` from the own loop.
- `tests/`: the shared gates (`test_gate.py`), the drift test (`test_capabilities.py`),
  LangGraph's own tool-error paths (`test_langgraph.py`), and the gates through LiteLLM
  (`test_proxy.py`).

```sh
uv sync --locked && uv run ruff check . && uv run ruff format --check . && uv run pytest -q
./probe.sh    # rewrite the probed fields of capabilities.json, then review the diff
EVALS_PROXY_URL=http://127.0.0.1:4000 LITELLM_MASTER_KEY=sk-local-dev-only uv run pytest -q tests/test_proxy.py
```

The gate tests need `uv sync` once in `services/fake-llm` and `services/finance-mcp`. The proxy
tests need the compose stack up, and they use only `fake/*` models.

## Pins

Python 3.14, the repo's version and the worker base image's. The research note ran every package
below on 3.14.10, although the langgraph classifiers stop at 3.13. `exclude-newer` holds every
transitive package to releases from before 21 Oct 2026. pytest and ruff are exempted so they
match the other workers; they never run inside a trial.

| Package | Pin | Released |
| --- | --- | --- |
| langgraph | 1.2.16 | 16 Oct |
| langchain (`create_agent`) | 1.4.6 | 14 Oct |
| langchain-core | 1.6.12 | 16 Oct |
| langchain-openai | 1.7.2 | 14 Oct |
| langchain-mcp-adapters | 0.3.2 | 6 Aug |
| mcp (client) | 1.30.0 | 7 Sep |

langchain-mcp-adapters caps `mcp` below 2, so this client is mcp 1.30.0, while the finance
server runs mcp 2.3.0. The gate tests cover that pairing over stdio.

## What the adapter sets, and why

| Rule | LangGraph on its own | Set here |
| --- | --- | --- |
| R10.11 no harness retries | the OpenAI SDK retries twice, unseen by callbacks | `ChatOpenAI(max_retries=0)` |
| R10.3 model only via LiteLLM | `OPENAI_*` variables, and the LangSmith gateway if `LANGSMITH_GATEWAY` is set | explicit `base_url` and `api_key`; those variables cleared at start-up |
| Same API for every model | switches to the Responses API by model name or `LC_OUTPUT_VERSION` | `use_responses_api=False` |
| Usage must arrive | streamed calls come back with no usage | `disable_streaming=True` |
| Unset means not sent | sends only what is set | temperature and max tokens passed only when the spec sets them |
| D17 one step = one model call | `recursion_limit` 9,999 counts graph supersteps, not calls | `ModelCallLimitMiddleware(thread_limit=max_steps, exit_behavior="error")`; the default `"end"` writes a fake answer |
| D19 parallel tool calls | not sent | `bind_tools(parallel_tool_calls=)` through `ModelRequest.model_settings` (a small middleware) |
| D18 tool errors to the model | a raising tool ends the run | LangChain's `ToolErrorMiddleware`, with the own loop's error text |
| D14 one MCP session per trial | `MultiServerMCPClient.get_tools()` opens a session per tool call | `client.session()` held for the trial, `load_mcp_tools(session)` |
| MCP tool timeout | none | the session's `read_timeout_seconds` from `tool_timeout_s` |
| Telemetry off | LangSmith traces when a `*_TRACING` variable is `"true"` | the tracing variables forced to `"false"`, LangSmith keys cleared |
| Multi-turn | state lives for one `ainvoke` | an in-memory checkpointer, one thread per trial; each turn sends only the new user message |

`TrialObserver` is the adapter's other middleware. It only reports: each model call (counted,
with usage and invalid tool calls) and each tool call (spans, error kinds). It changes nothing.

## Findings

Checked against the fake model server, through LiteLLM with `fake/*` models, and in the source
at the pins. No real model was called.

1. **A reply with only malformed tool calls ends the run (D18).** `langchain-openai` parses bad
   arguments into `invalid_tool_calls`, and the router (`factory.py:2018`) ends the loop when
   `tool_calls` is empty. LangGraph reports success, with an empty reply. The error never
   reaches the model, and LiteLLM logs exactly one call. The adapter labels it `agent_error`
   and keeps LangGraph's own signals in `harness_stop_reason` and the messages artifact. The
   gate checks this through `Gate(malformed_ends_in="agent_error")`.
2. **A malformed call next to a valid one is answered by LangChain.** At the next model call,
   `_patch_invalid_tool_calls` adds its own error result ("... could not be executed - arguments
   were malformed or truncated.") and the loop goes on (`test_langgraph.py`).
3. **Unknown tools and server errors go back to the model on their own.** An unknown name gets
   ToolNode's "is not a valid tool" result. An MCP `isError` result becomes an error
   ToolMessage. Only a tool that *raises*, such as an MCP timeout or a dead server, would end
   the run, which is why `ToolErrorMiddleware` is added. That path has no test, because the
   finance server never raises.
4. **On the wire, compared with the own loop on the same scripts:** the only differences are
   `max_completion_tokens` instead of `max_tokens`, and tool results sent as a list of text
   parts instead of a string. The system message, the tools array, the replayed tool calls and
   `stream: false` are identical. LangGraph adds no prompt text (D20 has nothing to record).
5. **Tool schemas match the server byte for byte here.** `convert_to_openai_tool` strips every
   `title` and inlines `$ref`, but the finance schemas have neither. A future tool with them
   would arrive changed.
6. **Model names reshape requests.** At this pin, `gpt-5*` names drop any temperature other
   than 1, `o1*` names send temperature 1 when none is set (`base.py:1362`), and `o<digit>`
   names send the system prompt as `developer`. There is no switch. Claude and Gemini names are
   unaffected, so LiteLLM aliases used with LangGraph must avoid those prefixes.
7. **No hidden calls or traffic.** LiteLLM's call count equals LangGraph's own in every proxy
   test, including no extra call at the step limit. Under `strace -f`, one full trial (the
   finance MCP child included) made a single `connect()`, to the model URL.
8. **Several tool calls in one reply run concurrently** (`Send` per call, `factory.py:2032`),
   whereas the own loop runs them in order. With `parallel_tool_calls` false this should be
   rare, and the finance tools are read-only. This is from the source; no test covers it.
9. **Start-up takes about 1.8 s** (import), well inside the timeout gate's 15 s.

## Open questions for Rishi

- **The malformed-only end state.** It is `agent_error` for now: the model sent a call that
  could not be run, and LangGraph stopped. The other option is `answered` with an empty reply,
  which is what LangGraph itself reports. A middleware could also send the error back by
  jumping to the model node, but that would be our behaviour, not LangGraph's.
- **Guard model names?** The API could reject `gpt-5*`, `o<digit>*` aliases for LangGraph
  configs (finding 6), or a capability flag could say so. Today it is a recorded difference only.
- **The tool-exception text.** `ToolErrorMiddleware` needs us to write the message the model sees.
  It uses the own loop's wording, so that the two harnesses match.
