#!/usr/bin/env bash
# Screenshots of every screen, for the UI critique rounds. No LLM calls: in fixture mode there is
# no API at all, and against a real API the pages only read (GET); nothing on a page is clicked.
#
#   scripts/screenshots.sh <output-folder>                      # fixture mode
#   API_TARGET=http://127.0.0.1:3001 SCREENS_FILE=screens.txt \
#     scripts/screenshots.sh <output-folder>                    # against a running API
#
# SCREENS_FILE holds one `name|#/route` per line (the fixture list below is the default).
# SETTLE_MS (default 1500) is how long each page gets to load before it is measured.
#
# Starts the Vite dev server with VITE_FIXTURES=1 on a free port (never 3000, 3001, 4000 or
# 8080), measures each page's full height with headless Chrome (scripts/measure-pages.mjs), then
# captures each one with `google-chrome --headless --screenshot` at that height: every screen at
# 1440 and 390 wide, plus dark versions of main, compare and trial. Stops exactly the dev server
# it started. page-metrics.tsv in the output folder records each page's height, scroll width
# (more than the window width means sideways overflow) and header height.
set -euo pipefail

OUT="${1:?usage: scripts/screenshots.sh <output-folder>}"
UI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-google-chrome}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-evals-shots.XXXXXX")"

# A free port the OS hands out, re-drawn if it is one the stack or Rishi's machine already uses.
PORT=""
for _ in 1 2 3 4 5; do
  candidate="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
  case "$candidate" in 3000 | 3001 | 4000 | 8080) continue ;; esac
  PORT="$candidate"
  break
done
[ -n "$PORT" ] || { echo "no free port found" >&2; exit 1; }

cd "$UI_DIR"
if [ -n "${API_TARGET:-}" ]; then
  # The dev server forwards /api to the API, as nginx does in Docker (vite.config.ts).
  API_PROXY_TARGET="$API_TARGET" node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT" --strictPort >"$WORK/vite.log" 2>&1 &
else
  VITE_FIXTURES=1 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT" --strictPort >"$WORK/vite.log" 2>&1 &
fi
VITE_PID=$!
echo "dev server pid $VITE_PID on port $PORT"
stop_server() {
  if kill -0 "$VITE_PID" 2>/dev/null; then kill "$VITE_PID"; fi
}
trap stop_server EXIT

BASE="http://127.0.0.1:$PORT/"
if ! curl -fs -o /dev/null --retry 60 --retry-delay 1 --retry-connrefused --retry-max-time 90 "$BASE"; then
  echo "dev server did not come up; its log:" >&2
  cat "$WORK/vite.log" >&2
  exit 1
fi

# name, hash route
SCREENS=(
  "start|#/"
  "build|#/build"
  "main|#/experiments"
  "config|#/configs"
  "run|#/run"
  "run-progress|#/experiments/exp_harness/run"
  "compare|#/experiments/exp_heldout"
  "trial|#/trials/tr_fd-vs-sip-07_b_3"
  "label|#/labels"
  "judge|#/labels/judge"
  "harnesses|#/harnesses"
  "tasks|#/tasks"
)
DARK=(main compare trial)
if [ -n "${SCREENS_FILE:-}" ]; then
  mapfile -t SCREENS < <(grep -v '^\s*\(#\|$\)' "$SCREENS_FILE")
  DARK=(${DARK_SCREENS:-})
fi

: >"$WORK/jobs.tsv"
for entry in "${SCREENS[@]}"; do
  name="${entry%%|*}"
  route="${entry#*|}"
  for width in 1440 390; do
    printf '%s\t%s\t%s\n' "$name-$width" "$width" "$BASE$route" >>"$WORK/jobs.tsv"
  done
  for dark in "${DARK[@]}"; do
    if [ "$dark" = "$name" ]; then
      for width in 1440 390; do
        printf '%s\t%s\t%s\n' "$name-dark-$width" "$width" "${BASE}?theme=dark$route" >>"$WORK/jobs.tsv"
      done
    fi
  done
done

SETTLE_MS="${SETTLE_MS:-1500}" node scripts/measure-pages.mjs "$CHROME" "$WORK/measure-profile" "$WORK/jobs.tsv" "$WORK/metrics.tsv"
{
  printf 'page\twidth\theight\tscroll_width\theader_height\n'
  cat "$WORK/metrics.tsv"
} >"$OUT/page-metrics.tsv"

while IFS=$'\t' read -r name width height scroll_width header; do
  url="$(awk -F '\t' -v n="$name" '$1 == n { print $3 }' "$WORK/jobs.tsv")"
  timeout 90 "$CHROME" --headless --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$WORK/shot-profile" --window-size="$width,$height" --virtual-time-budget=8000 \
    --screenshot="$OUT/$name.png" "$url" >/dev/null 2>&1
  echo "$name.png  ${width}x${height}  scroll width $scroll_width  header $header"
done <"$WORK/metrics.tsv"

echo "screenshots in $OUT"
