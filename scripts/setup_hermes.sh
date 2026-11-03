#!/usr/bin/env bash
# Check out Hermes Agent at the pinned SHA and install it from its own lockfile, for the Hermes
# adapter's tests. Hermes source is never modified (CLAUDE.md); the adapter runs on this
# environment with workers/hermes/src and workers/adapterlib/src on PYTHONPATH.
#   scripts/setup_hermes.sh [DEST]    default DEST: workers/hermes/.hermes-agent
set -euo pipefail
SHA=6112c2adb9e11f69734a29be9d2696f345ffa06a
REPO_URL=https://github.com/NousResearch/hermes-agent.git
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST=${1:-$ROOT/workers/hermes/.hermes-agent}
if [ ! -d "$DEST/.git" ]; then
  git init -q "$DEST"
  git -C "$DEST" remote add origin "$REPO_URL"
fi
git -C "$DEST" fetch -q --depth 1 origin "$SHA"
git -C "$DEST" checkout -q --detach "$SHA"
test "$(git -C "$DEST" rev-parse HEAD)" = "$SHA"
(cd "$DEST" && uv sync --locked --extra mcp --python 3.14)
echo "Hermes $SHA ready at $DEST"
echo "Run its gate tests with: cd workers/hermes && HERMES_SRC=$DEST uv run pytest"
