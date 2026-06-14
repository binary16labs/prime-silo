#!/usr/bin/env bash
# Seed the demo (POSIX) — load prime-silo's own source into a 'prime_silo_self'
# workspace, build its code graph, and ingest the docs so you can ask Benny
# about the running project. Prereq: the stack is up (./scripts/dev.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENNY_HOME="${BENNY_HOME:-${ROOT}/.benny_home}"
RUNTIME="${RUNTIME_BASE_URL:-http://127.0.0.1:8005}"
API_KEY="${BENNY_API_KEY:-benny-mesh-2026-auth}"
WS="prime_silo_self"
HDR="X-Benny-API-Key: ${API_KEY}"

echo "> Seeding demo workspace '${WS}' (runtime ${RUNTIME})"

if ! curl -fsS -H "${HDR}" "${RUNTIME}/api/workspaces" >/dev/null 2>&1; then
    echo "error: Benny runtime not reachable at ${RUNTIME}. Start it first: ./scripts/dev.sh" >&2
    exit 1
fi

# 1. workspace (ignore 'already exists')
WS_RESPONSE=$(curl -fsS -X POST -H "${HDR}" "${RUNTIME}/api/workspaces/${WS}")
WS_PATH=$(echo "$WS_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['path'])" 2>/dev/null || echo "$WS_RESPONSE" | python -c "import sys, json; print(json.load(sys.stdin)['path'])")
mkdir -p "${WS_PATH}/src" "${WS_PATH}/data_in"

# 2. copy prime-silo source (no node_modules)
echo "> Copying prime-silo source into the workspace"
for d in server commands; do
    rm -rf "${WS_PATH}/src/${d}"
    cp -R "${ROOT}/${d}" "${WS_PATH}/src/${d}"
done
rm -rf "${WS_PATH}/src/_prime_silo"
cp -R "${ROOT}/app/L0/_all/mod/_prime_silo" "${WS_PATH}/src/_prime_silo"

# 3. stage docs
echo "> Staging docs for ingestion"
for doc in README.md GUIDE.md docs/USER_GUIDE.md architecture/ROADMAP.md; do
    [ -f "${ROOT}/${doc}" ] && cp "${ROOT}/${doc}" "${WS_PATH}/data_in/" || true
done

# 4. build code graph
echo "> Building the code graph (tree-sitter scan)"
curl -fsS -X POST -H "${HDR}" -H "Content-Type: application/json" \
    -d "{\"workspace\":\"${WS}\",\"root_dir\":\"src\",\"name\":\"prime-silo\"}" \
    "${RUNTIME}/api/graph/code/generate" && echo ""

# 5. ingest docs
echo "> Ingesting docs into the knowledge graph"
curl -fsS -X POST -H "${HDR}" -H "Content-Type: application/json" \
    -d "{\"workspace\":\"${WS}\"}" "${RUNTIME}/api/rag/ingest" && echo "" \
    || echo "  doc ingest skipped (ingestion service not ready)"

echo ""
echo "Seeded '${WS}'. Open the Bridge, pick the '${WS}' workspace, and ask Benny about the codebase."
echo "  http://localhost:3000/#/_prime_silo/bridge?mode=code"
