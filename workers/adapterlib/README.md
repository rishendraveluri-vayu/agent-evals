# evals-adapter

The shared adapter library for harness workers. It implements the adapter and runner sides of
contract v2 (`docs/adapter-contract.md`), so a harness adapter only has to map settings and run
one turn. Standard library only, Python 3.11 and up, because every harness environment installs
it and they do not share dependencies.

## Writing an adapter

```python
from pathlib import Path
from evals_adapter import Adapter, TurnResult, main


class MyAdapter(Adapter):
    name = "my-harness"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def setup(self, ctx):  # apply_settings(spec)
        ctx.applied.set("temperature", ctx.settings["temperature"], "config")
        ...

    def run_turn(self, ctx, history, max_steps):
        span = ctx.tool_started(call_id, "calculate_emi", args)  # for each tool call
        ctx.tool_finished(call_id, result_text, is_error=False)
        return TurnResult(stop="answered", reply="...", model_calls=2)


if __name__ == "__main__":
    main(MyAdapter())
```

What the library does for you:

| Piece | Where |
| --- | --- |
| Read and check `spec.json`; trial paths | `spec.py` |
| Whole-trial timeout: writes `end_state: timeout` and exits | `adapter.py` (`_Trial.start_watchdog`) |
| Root span, one `agent.turn` span per turn, tool spans and events | `adapter.py`, `trace.py` |
| Conversation loop with the simulated client, step budget across turns | `adapter.py`, `sim.py` |
| `applied_settings` prefilled from the spec and capabilities | `adapter.py` |
| Integrity hashes before and after, artifacts, atomic `result.json` | `adapter.py` |
| Runner: folder, process group, safety-net kill, leftover sweep, schema check, label | `runner.py` |
| LiteLLM trial keys, spend-log merge into `chat` spans, bodies as artifacts | `proxy.py` |

## Running one trial by hand

```sh
uv run evals-run-trial --trial-dir /tmp/t1 --spec spec.json \
    --state client.json=../../services/finance-mcp/examples/client.example.json \
    --env EVALS_MODEL_API_KEY=sk-fake -- python -m my_adapter
```

Add `--proxy-url http://127.0.0.1:4000` (with `LITELLM_MASTER_KEY` set) to go through LiteLLM:
the runner then makes the trial's own key and merges LiteLLM's records into the trace.

## Tests

```sh
uv sync --locked && uv run ruff check . && uv run ruff format --check . && uv run pytest -q
```

The tests use a scripted in-process adapter and validate every output against the JSON Schemas
in `contract/v2`. None of them call a model.
