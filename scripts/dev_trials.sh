#!/usr/bin/env bash
# Record a few trials per harness through LiteLLM into runs/, for the trace view and the spend
# chart. Fake models only (fake/* routes to the compose fake server), so no real spend.
# Needs the compose stack up, uv sync in each worker, and for Hermes HERMES_SRC (or
# workers/hermes/.hermes-agent from scripts/setup_hermes.sh).
#   scripts/dev_trials.sh [harness ...]     default: ownloop hermes
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export EVALS_PROXY_URL=${EVALS_PROXY_URL:-http://127.0.0.1:${LITELLM_PORT:-4000}}
if [ -z "${LITELLM_MASTER_KEY:-}" ]; then
  LITELLM_MASTER_KEY=$(grep -E '^LITELLM_MASTER_KEY=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)
  export LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY:-sk-local-dev-only}
fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
for harness in "${@:-ownloop hermes}"; do
  for h in $harness; do
    dest="$ROOT/runs/$STAMP/$h"
    mkdir -p "$dest"
    (cd "$ROOT/workers/$h" && uv run python - "$dest" <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, "tests")
from test_gate import GATE  # noqa: E402

from evals_adapter.gate import proxy_gate  # noqa: E402

gate = proxy_gate(GATE)
dest = Path(sys.argv[1])
for scenario in ("test_answer", "test_steps", "test_conversation", "test_no_harness_retries"):
    out = dest / scenario
    out.mkdir()
    run = getattr(gate, scenario)(out, None)
    usage = run.report["proxy_usage"] or {}
    print(f"{GATE.harness:8s} {scenario:24s} {run.result.get('end_state')!s:13s} "
          f"label={run.report['label']:20s} proxy_calls={usage.get('model_calls')} "
          f"harness_calls={run.result.get('counts', {}).get('model_calls')} "
          f"cost=${usage.get('cost_usd', 0):.6f}", flush=True)
PY
    )
  done
done
echo "Trials in runs/$STAMP. Open the UI at http://127.0.0.1:${UI_PORT:-8080}/"
