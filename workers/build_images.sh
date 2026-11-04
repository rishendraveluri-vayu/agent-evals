#!/usr/bin/env bash
# Build the harness worker images with docker build (no compose), tagged as compose tags them,
# for the image tests in workers/adapterlib/tests/test_images.py.
#   workers/build_images.sh [HARNESS ...]    default: all five
# EVALS_IMAGE_TAG (default dev) picks another tag, so a branch can be tested without replacing
# the images a running stack uses; run the image tests with the same EVALS_IMAGE_TAG.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TAG=${EVALS_IMAGE_TAG:-dev}
if [ "$#" -eq 0 ]; then
  set -- ownloop hermes langgraph adk openai-agents
fi
for harness in "$@"; do
  echo "== agent-evals/worker-${harness}:${TAG}"
  docker build -f "${ROOT}/workers/${harness}/Dockerfile" -t "agent-evals/worker-${harness}:${TAG}" "${ROOT}"
done
