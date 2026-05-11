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

$root = Split-Path -Parent $PSScriptRoot

# Load .env if it exists
if (Test-Path "$root\.env") {
    Write-Host "▸ Loading .env"
    Get-Content "$root\.env" | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            if ($line -match "^([^=]+)=(.*)$") {
                $name = $matches[1].Trim()
                $value = $matches[2].Trim()
                # Remove quotes if present
                $value = $value -replace "^['""]|['""]$", ""
                if (-not (Test-Path "Env:\$name")) {
                    Set-Item "Env:\$name" $value
                    Write-Host "  $name loaded"
                }
            }
        }
    }
}
if (-not $env:BENNY_HMAC_KEY) {
    Write-Error "BENNY_HMAC_KEY is required. Set it in .env or your shell environment before launching."
}

$runtimeDir = Join-Path $root "runtime"
$bennyHome  = Join-Path $root ".benny_home"

if (-not (Test-Path $bennyHome)) {
    New-Item -ItemType Directory -Path $bennyHome | Out-Null
}

$workspacesDir = Join-Path $bennyHome "workspaces"
if (-not (Test-Path $workspacesDir)) {
    New-Item -ItemType Directory -Path $workspacesDir | Out-Null
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
