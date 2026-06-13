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

# Memo-Ray memory graph (Phase M1) — auto-boot when enabled and the checkout
# exists, so the in-shell page at #/_prime_silo/memory works from one command.
# The shell proxies /api/memoray to the server (:3001); the Vite client (:5173)
# backs the page's "Zen mode" link-out. MEMORAY_ENABLED=false skips both.
if [[ "${MEMORAY_ENABLED:-true}" != "false" ]]; then
    MEMORAY_DIR_RESOLVED="${MEMORAY_DIR:-$(cd "${ROOT}/.." && pwd)/memo-ray}"
    MEMORAY_SERVER_DIR="${MEMORAY_DIR_RESOLVED}/agent-os-dashboard/server"
    MEMORAY_CLIENT_DIR="${MEMORAY_DIR_RESOLVED}/agent-os-dashboard/client"
    if [[ -d "${MEMORAY_SERVER_DIR}" ]]; then
        for d in "${MEMORAY_SERVER_DIR}" "${MEMORAY_CLIENT_DIR}"; do
            if [[ -d "$d" && ! -d "$d/node_modules" ]]; then
                echo "▸ npm install ($d)"
                ( cd "$d" && npm install )
            fi
        done
        ( cd "${MEMORAY_SERVER_DIR}" && node index.js ) &
        MEMORAY_PID=$!
        PIDS="${PIDS} ${MEMORAY_PID}"
        echo "  memoray server PID = ${MEMORAY_PID} (:3001 — page at /#/_prime_silo/memory)"
        # Client (:5173) — backs the "Zen mode" link.
        if [[ -d "${MEMORAY_CLIENT_DIR}" ]]; then
            ( cd "${MEMORAY_CLIENT_DIR}" && npm run dev ) &
            MEMORAY_CLIENT_PID=$!
            PIDS="${PIDS} ${MEMORAY_CLIENT_PID}"
            echo "  memoray client PID = ${MEMORAY_CLIENT_PID} (:5173 — Zen mode)"
        fi
    else
        echo "  memo-ray not found at '${MEMORAY_DIR_RESOLVED}' — memory page will show an offline screen."
        echo "  Clone https://github.com/binary16labs/memo-ray beside prime-silo (or set MEMORAY_DIR), then run scripts/memoray.sh."
    fi
fi

# shellcheck disable=SC2086
trap 'kill ${PIDS} 2>/dev/null || true' EXIT INT TERM
# shellcheck disable=SC2086
wait -n ${PIDS}
