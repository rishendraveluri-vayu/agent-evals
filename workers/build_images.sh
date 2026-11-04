#!/usr/bin/env bash
# Build the harness worker images with docker build (no compose), tagged as compose tags them,
# for the image tests in workers/adapterlib/tests/test_images.py.
#   workers/build_images.sh [HARNESS ...]    default: all five
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ "$#" -eq 0 ]; then
  set -- ownloop hermes langgraph adk openai-agents
fi
for harness in "$@"; do
  echo "== agent-evals/worker-${harness}:dev"
  docker build -f "${ROOT}/workers/${harness}/Dockerfile" -t "agent-evals/worker-${harness}:dev" "${ROOT}"
done
