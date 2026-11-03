# ownloop

The own plain tool-calling loop, and the reference harness: call the model, run any tool calls
through the finance MCP server, repeat until it answers or runs out of steps. It adds nothing to
the prompt or the tool schemas, sends only the settings the spec gives, and never retries
(R10.11). Every other harness is compared against what this one sends.

About 200 lines on the shared adapter library (`workers/adapterlib`): `setup` opens the MCP
sessions and builds the request, `run_turn` runs the loop. Everything else (timeout, spans,
conversation, result) comes from the library.

```sh
uv sync --locked && uv run ruff check . && uv run pytest -q   # gate tests against the fake
```

The gate tests need `uv sync` once in `services/fake-llm` and `services/finance-mcp`.
