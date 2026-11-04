# openai-agents worker

The openai-agents harness adapter on the shared adapter library (`workers/adapterlib`). Created by
`evals-new-harness`.

1. Add the harness package (exact version) to `pyproject.toml`, then `uv sync`.
2. Write `setup` and `run_turn` in `src/openai_agents_adapter/adapter.py`, and set `IMPLEMENTED = True`.
3. `./probe.sh` writes the probed fields of `src/openai_agents_adapter/capabilities.json` from what reaches the
   fake model. Declare memory, skills and compression by hand, and list `known_differences`.
4. `uv run pytest -q` runs the gate tests and the capabilities drift test.
5. Effect checks on real models (D24) need Rishi's sign-off with a cost estimate first (R8).
