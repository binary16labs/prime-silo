# Prime-Silo dev launcher (PowerShell)
#
# Boots the Benny FastAPI runtime (port 8005) and the space-agent shell in
# parallel. Phase B keeps these as two processes; Phase D wires the shell to
# proxy /api/* to the runtime so a single user-facing port is exposed.
#
# Required environment:
#   BENNY_HMAC_KEY   — hex-encoded HMAC key for manifest + view signing
#                      (must match the key your skin packs were signed with)

$ErrorActionPreference = "Stop"

if (-not $env:BENNY_HMAC_KEY) {
    Write-Error "BENNY_HMAC_KEY is required. Export your hex-encoded HMAC key before launching."
}

$root      = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root "runtime"
$bennyHome  = Join-Path $root ".benny_home"

if (-not (Test-Path $bennyHome)) {
    New-Item -ItemType Directory -Path $bennyHome | Out-Null
}

$env:BENNY_HOME = $bennyHome

Write-Host "▸ Prime-Silo dev launcher"
Write-Host "  BENNY_HOME = $env:BENNY_HOME"
Write-Host "  runtime    = $runtimeDir"

# Runtime — FastAPI on :8005
$runtime = Start-Process `
    -FilePath "python" `
    -ArgumentList "-m","benny.api.server" `
    -WorkingDirectory $runtimeDir `
    -PassThru `
    -NoNewWindow

# Shell — space-agent dev server
$shell = Start-Process `
    -FilePath "node" `
    -ArgumentList "server/dev_server.js" `
    -WorkingDirectory $root `
    -PassThru `
    -NoNewWindow

Write-Host "  runtime PID = $($runtime.Id)"
Write-Host "  shell   PID = $($shell.Id)"

try {
    Wait-Process -Id $runtime.Id, $shell.Id
} finally {
    foreach ($p in @($runtime, $shell)) {
        if ($p -and -not $p.HasExited) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
