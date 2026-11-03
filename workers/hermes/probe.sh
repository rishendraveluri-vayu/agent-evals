#!/usr/bin/env bash
# Fill capabilities.json from evidence against the fake model server, then review the diff.
# Needs HERMES_SRC (default: .hermes-agent from scripts/setup_hermes.sh).
set -euo pipefail
cd "$(dirname "$0")"
HERMES_SRC=${HERMES_SRC:-$PWD/.hermes-agent}
uv run evals-probe-harness --capabilities src/hermes_adapter/capabilities.json \
  --tool-prefix mcp__finance__ --env "PYTHONPATH=$PWD/src:$PWD/../adapterlib/src" \
  -- "$HERMES_SRC/.venv/bin/python" -m hermes_adapter.adapter
