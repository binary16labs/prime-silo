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

PIDS="${RUNTIME_PID} ${SHELL_PID}"

# Memo-Ray memory graph (Phase M1) — auto-boot the server when enabled and the
# checkout exists, so the in-shell page at #/_prime_silo/memory works from one
# command. MEMORAY_ENABLED=false skips it.
if [[ "${MEMORAY_ENABLED:-true}" != "false" ]]; then
    MEMORAY_DIR_RESOLVED="${MEMORAY_DIR:-$(cd "${ROOT}/.." && pwd)/memo-ray}"
    MEMORAY_SERVER_DIR="${MEMORAY_DIR_RESOLVED}/agent-os-dashboard/server"
    if [[ -d "${MEMORAY_SERVER_DIR}" ]]; then
        if [[ ! -d "${MEMORAY_SERVER_DIR}/node_modules" ]]; then
            echo "▸ npm install (memo-ray server)"
            ( cd "${MEMORAY_SERVER_DIR}" && npm install )
        fi
        ( cd "${MEMORAY_SERVER_DIR}" && node index.js ) &
        MEMORAY_PID=$!
        PIDS="${PIDS} ${MEMORAY_PID}"
        echo "  memoray PID = ${MEMORAY_PID} (server :3001 — page at /#/_prime_silo/memory)"
    else
        echo "  memo-ray not found at '${MEMORAY_DIR_RESOLVED}' — memory page will show an offline screen."
        echo "  Clone https://github.com/binary16labs/memo-ray beside prime-silo (or set MEMORAY_DIR), then run scripts/memoray.sh."
    fi
fi

# shellcheck disable=SC2086
trap 'kill ${PIDS} 2>/dev/null || true' EXIT INT TERM
# shellcheck disable=SC2086
wait -n ${PIDS}
