# Hermes worker

The Hermes Agent adapter on the shared adapter library (`workers/adapterlib`), at the pinned SHA
`6112c2adb9e11f69734a29be9d2696f345ffa06a`, unmodified.

- `src/hermes_adapter/adapter.py`: writes a fresh `HERMES_HOME` (config and seeds) before
  importing Hermes, builds one `AIAgent` per trial, and maps each `run_conversation` result to a
  turn result. Each switch it sets is there because a probe showed Hermes doing something a fair
  comparison cannot allow; see the comments and `docs/hermes-notes.md`.
- `src/hermes_adapter/capabilities.json`: what the adapter supports, and the known differences
  from the reference loop.
- `tests/test_gate.py`: the contract's gate tests against the fake model server.

The adapter runs on Hermes's own environment (Python 3.14, Hermes's `uv.lock`) with `src/` and
`../adapterlib/src` on `PYTHONPATH`. Nothing is installed into Hermes's environment, and this
project's own environment is only for the tests.

```sh
scripts/setup_hermes.sh                     # once: checkout at the pin + uv sync --locked
cd workers/hermes && uv sync --locked
HERMES_SRC=$PWD/.hermes-agent uv run pytest -q
```
