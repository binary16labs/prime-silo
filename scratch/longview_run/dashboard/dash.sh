#!/usr/bin/env bash
# LONGVIEW Mission Control — one command brings up the live dashboard.
#   plan (once, exact window counts) + collector loop (refreshes dashboard.json) + static server.
# 100% READ-ONLY on the run state, NO calls to the LM host — safe to run during a live map.
#   Open: http://127.0.0.1:8788/
set -u
D="C:/Users/nsdha/OneDrive/binary16/prime-silo/scratch/longview_run/dashboard"
cd /c/Users/nsdha/OneDrive/binary16/prime-silo || exit 2

export LONGVIEW_WORKSPACE="${LONGVIEW_WORKSPACE:-sessions_v1}"
export LONGVIEW_WINDOW_CHARS="${LONGVIEW_WINDOW_CHARS:-12000}"
export MEMORAY_DATA_DIR='C:\Users\nsdha\.mem0ray\data'
export MEM0RAY_CLAUDE_DIRS='C:\Users\nsdha\.claude\projects'

# 1. Plan pass — exact windows/session for all sessions (skip if fresh, --replan forces).
if [ "${1:-}" = "--replan" ] || [ ! -f "$D/plan.json" ]; then
  echo "[dash] planning target (walking all sessions, read-only)…"
  node "$D/plan.mjs"
fi

# 2. Static server (background) so the dashboard's fetch works.
if ! curl -s -m 2 http://127.0.0.1:8788/dashboard.json -o /dev/null 2>/dev/null; then
  echo "[dash] starting server on :8788…"
  ( node "$D/serve.mjs" >/dev/null 2>&1 & )
  sleep 1
fi

echo "[dash] live — open http://127.0.0.1:8788/   (Ctrl+C to stop the collector; server keeps running)"
# 3. Collector loop — refresh dashboard.json every 20s from the live run state.
while true; do
  node "$D/collect.mjs"
  sleep 20
done
