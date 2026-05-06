#!/usr/bin/env bash
# Prime-Silo dev launcher (POSIX)
#
# Boots the Benny FastAPI runtime (port 8005) and the space-agent shell in
# parallel. Phase B keeps these as two processes; Phase D wires the shell to
# proxy /api/* to the runtime so a single user-facing port is exposed.
#
# Required environment:
#   BENNY_HMAC_KEY  — hex-encoded HMAC key for manifest + view signing
#                     (must match the key your skin packs were signed with)
set -euo pipefail

if [[ -z "${BENNY_HMAC_KEY:-}" ]]; then
    echo "error: BENNY_HMAC_KEY is required (export your hex-encoded HMAC key)" >&2
    exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT}/runtime"
export BENNY_HOME="${ROOT}/.benny_home"
mkdir -p "${BENNY_HOME}"

echo "▸ Prime-Silo dev launcher"
echo "  BENNY_HOME = ${BENNY_HOME}"
echo "  runtime    = ${RUNTIME_DIR}"

# Runtime — FastAPI on :8005
( cd "${RUNTIME_DIR}" && python -m benny.api.server ) &
RUNTIME_PID=$!

# Shell — space-agent dev server
( cd "${ROOT}" && node server/dev_server.js ) &
SHELL_PID=$!

echo "  runtime PID = ${RUNTIME_PID}"
echo "  shell   PID = ${SHELL_PID}"

trap 'kill ${RUNTIME_PID} ${SHELL_PID} 2>/dev/null || true' EXIT INT TERM
wait -n ${RUNTIME_PID} ${SHELL_PID}
