#!/usr/bin/env bash
# Fill capabilities.json from evidence against the fake model server, then review the diff.
set -euo pipefail
cd "$(dirname "$0")"
uv run evals-probe-harness --capabilities src/adk_adapter/capabilities.json -- "$PWD/.venv/bin/python" -m adk_adapter.adapter
