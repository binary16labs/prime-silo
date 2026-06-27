# Memo-Ray launcher (PowerShell)
#
# Boots the Memo-Ray memory-graph server. As of MEMORAY-MERGE.md, memo-ray is
# VENDORED INTO prime-silo at `memoray/server` and ships as part of this one app
# (no separate repo to clone). This script boots that vendored server:
#   server - Express on the registry-resolved port (default :3030; delta-syncs
#            Claude + Antigravity + opencode + open-notebook session logs)
#
# Memo-Ray is the third graph of the cognitive mesh: memory (sessions) beside
# knowledge (documents) and code (AST). Prime-Silo's shell proxy + Bridge /
# Command Center widgets read it live once this is running.
#
# Port discovery: this script runs the app-registry resolver, which writes
# apps.lock.json with a free, non-clashing port for each app. Memo-Ray reads that
# lock at boot and Prime-Silo's proxy reads it too, so the two always agree -
# no hand-matching of ports.
#
# Location: the vendored `prime-silo/memoray` by default. MEMORAY_DIR still
# overrides it to an external checkout; both the vendored (`<dir>/server`) and the
# upstream (`<dir>/agent-os-dashboard/server`) layouts are auto-detected.
#
# Note: the standalone Vite client is being retired (its views are ported into the
# prime-silo shell — MEMORAY-MERGE.md Phase 2), so this launcher boots the server
# only. Use the prime-silo shell for the UI.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$memoray = if ($env:MEMORAY_DIR) { $env:MEMORAY_DIR } else { Join-Path $root "memoray" }

if (-not (Test-Path $memoray)) {
    Write-Error "Memo-Ray not found at '$memoray'. It is vendored at prime-silo/memoray; set MEMORAY_DIR to use an external checkout."
}

# Vendored layout (memoray/server) first; fall back to an upstream checkout layout.
$serverDir = Join-Path $memoray "server"
if (-not (Test-Path $serverDir)) {
    $serverDir = Join-Path $memoray "agent-os-dashboard\server"
}
if (-not (Test-Path $serverDir)) {
    Write-Error "Memo-Ray server not found under '$memoray' (looked for 'server' and 'agent-os-dashboard\server')."
}

if (-not (Test-Path (Join-Path $serverDir "node_modules"))) {
    Write-Host "> npm install in $serverDir"
    Push-Location $serverDir
    npm install
    Pop-Location
}

# Resolve ports through the decentralized app registry (writes apps.lock.json).
Write-Host "> Resolving app-registry ports"
node (Join-Path $root "scripts\registry\resolve-ports.mjs")

Write-Host "> Memo-Ray launcher"
Write-Host "  server -> registry-resolved port (see apps.lock.json; default :3030)"

# No explicit PORT: the server reads its resolved port from apps.lock.json.
$server = Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $serverDir -PassThru -NoNewWindow

Write-Host "  server PID = $($server.Id)"

try {
    Wait-Process -Id $server.Id
} finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
}
