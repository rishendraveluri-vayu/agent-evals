# ownloop

The own plain tool-calling loop, and the reference harness: call the model, run any tool calls
through the finance MCP server, repeat until it answers or runs out of steps. It adds nothing to
the prompt or the tool schemas, sends only the settings the spec gives, and never retries
(R10.11). Every other harness is compared against what this one sends.

About 250 lines on the shared adapter library (`workers/adapterlib`): `setup` opens the MCP
sessions and builds the request, `run_turn` runs the loop. Everything else (timeout, spans,
conversation, result) comes from the library.

**A reply cut off at the token cap (D36).** On `finish_reason: length` the loop re-sends the same
request once with `max_tokens` doubled, up to 8,192, and records an `evals.token_cap_raised`
event on the turn with both caps. If that reply is cut off too, the turn ends as `token_limit`
with the partial text. It also ends as `token_limit` straight away when there is no cap to raise
(none was sent, or it is already 8,192) or no step left: the re-send is a model call and counts
as a step (D17). `max_output_tokens` is the first attempt's cap; later calls go back to it.
`tests/test_token_cap.py` covers each case with the fake's `finance-length` and
`finance-length-always` scripts. This is the one place the loop sends a request twice, and only
with a different cap; it never retries a failed call (R10.11).

```sh
uv sync --locked && uv run ruff check . && uv run pytest -q   # gate tests against the fake
```

The gate tests need `uv sync` once in `services/fake-llm` and `services/finance-mcp`.
