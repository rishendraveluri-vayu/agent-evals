# openai-agents worker

The OpenAI Agents SDK adapter on the shared adapter library (`workers/adapterlib`). It runs
`openai-agents==0.24.0` as it comes: one plain `Agent` with the task's system prompt as
`instructions`, the finance MCP server over stdio, and `Runner.run`. About 375 lines in
`src/openai_agents_adapter/adapter.py`, comments included; most of the difference from the own
loop is the hooks that turn the SDK's events into spans. Created with
`evals-new-harness openai-agents`.

- `setup` builds the model client, starts the MCP server and the agent. Each switch it sets is
  there because the SDK's default would break a fair comparison (see Findings and the module
  docstring).
- `run_turn` runs `Runner.run` with `max_turns` set to the steps left, and maps the result or
  the exception to a turn result. `RunHooks` report tool calls, malformed arguments and unknown
  tools as spans and D18 events. The hooks only observe; they change nothing the model or the
  tools see.
- Earlier turns of a conversation carry over as `result.to_input_list()` plus the new user
  message. This is the SDK's documented manual way, and contract section 9 names it. An SDK
  session would also work, but it is an extra object with its own storage, so it is not used.

Python 3.14, like the own loop and Hermes. The research probes ran on CPython 3.14.10, and the
package lists 3.10 to 3.14.

```sh
uv sync --locked && uv run ruff check . && uv run ruff format --check .
./probe.sh                 # rewrite capabilities.json from evidence, then review the diff
uv run pytest -q           # 8 gate tests, the drift test and the harness tests, against the fake
EVALS_PROXY_URL=http://127.0.0.1:4000 LITELLM_MASTER_KEY=sk-local-dev-only \
    uv run pytest -q tests/test_proxy.py   # the gate through LiteLLM (compose up first)
```

The gate tests need `uv sync --locked` once in `services/fake-llm` and `services/finance-mcp`.

## Pins

`openai-agents==0.24.0` (15 Oct), `openai==3.35.1` (18 Oct) and `mcp==2.3.0`, all exact. The
lock excludes anything uploaded after 21 Oct (`exclude-newer`, two weeks before 4 Nov). That is
why openai is 3.35.1 and not the 3.42.1 the research probe resolved: 3.42.1 came out on 1 Nov.
pytest and ruff, which are dev tools only, are exempt and keep the repo's shared floors.

## Findings

Probed on 4 Nov against the fake model server and LiteLLM's `fake/*` routes. No real model was
called. Each item says how it was checked.

**Requests (probe, gate).**
- The request has only `model`, `messages`, `tools` and the settings the spec sets
  (`temperature`, `max_tokens`, `parallel_tool_calls`). Unset settings are not sent.
- The system message is the task prompt byte for byte. The SDK adds no prompt text (D20).
- No `stream`, `store`, `metadata` or reasoning fields are sent: the model is an
  `OpenAIChatCompletionsModel` instance on a non-OpenAI host. A model *string* would have gone
  to the Responses API.

**Steps (probe, proxy test).** `max_turns` counts model calls (D17). At `max_turns` 3 the SDK
makes exactly 3 calls and raises `MaxTurnsExceeded`, so `extra_calls_at_limit` is 0. LiteLLM
logs the same 3 calls the SDK counted.

**Retries (gate, source).**
- A 429 gives exactly one request and `harness_error`.
- Retries are off in two places. The openai client has `max_retries=0`, and the client retries
  twice by default. The runner has `ModelRetrySettings(max_retries=0)`, which in 0.24.0 also
  turns off the provider's own retries (`run_internal/model_retry.py`).

**Tools (gate, harness tests).**
- Names, descriptions and parameter schemas are the server's, unchanged, because
  `convert_schemas_to_strict` is off.
- The SDK adds `"strict": false` to every function definition.
- MCP results go back as a list of content parts (`[{"type": "text", ...}]`), not a string as
  in the own loop. An MCP `isError` result reaches the model unmasked, as the server wrote it.
- The SDK's MCP call timeout defaults to 5 s. The adapter sets it from the spec's
  `tool_timeout_s`.

**Errors the model sees (D18, gate and harness tests).**
- Malformed arguments do not crash the run, but the error is masked. The model gets the fixed
  string "An error occurred while running the tool. Please try again." and is never told the
  JSON was invalid. The own loop says so; Hermes repairs the JSON silently. The adapter reports
  each case as `malformed_tool_call`.
- An unknown tool raises `ModelBehaviorError` by default and ends the run. With
  `tool_not_found_behavior="return_error_to_model"` the model gets "Tool '<name>' not found."
  and the run continues.
- Read from the source, not run: a tool call that raises (an MCP timeout, a broken session)
  also gets the fixed string.

**Tracing (harness test).** By default the SDK sends traces, with prompts and tool data, to
api.openai.com whenever `OPENAI_API_KEY` is set. The adapter removes every trace processor and
turns tracing off at import, and the trial key is never put in `OPENAI_API_KEY`. The test shows
that no processor is registered and that a trace is a no-op.

**End states.**
- The SDK does not surface `finish_reason`. The adapter reads it from the raw HTTP response with
  an httpx response hook, which only reads, to tell `token_limit` from `answered`.
- A reply cut off before any text raises `ModelBehaviorError`, which the adapter maps to
  `token_limit`.
- Only the hook itself is tested. The fake model never sends `length`, so this path has not run
  end to end.

**Concurrency.** All tool calls of one model turn run concurrently.
`ToolExecutionConfig.max_function_tool_concurrency` is left at its default. With
`parallel_tool_calls` false, the model should send one call per turn anyway.

**MCP tool list.** It is cached for the trial (`cache_tools_list=True`, as the SDK docs advise
for a server whose tools do not change). That saves one `list_tools` round trip per model call
and changes nothing the model sees.

## Open questions for Rishi

1. **Which tool-error text to expose (D18).** The SDK's default is kept: the model is not told
   its JSON was invalid, while the own loop says so. `failure_error_function` on the MCP server
   could pass the real error instead. That would be closer to the own loop, but further from
   the SDK as it comes. Not changed.
2. **Tool results as content-part lists.** This is a wire difference from the own loop.
   LiteLLM's handling of it for Claude and Gemini has not been checked on a real model. Check
   on the first signed-off real run (R8).

## Not run

- Effect checks on real models (D24). These need sign-off with a cost estimate first (R8).
- `token_limit` end to end, and the tool-exception path (see above).
