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

# Memo-Ray memory graph (Phase M1) — auto-boot the server when enabled and the
# checkout exists, so the in-shell page at #/_prime_silo/memory works from one
# command. The shell proxies /api/memoray to it. MEMORAY_ENABLED=false skips it.
$procs = @($runtime, $shell)
$memorayServer = $null
if ($env:MEMORAY_ENABLED -ne "false") {
    $memorayDir = if ($env:MEMORAY_DIR) { $env:MEMORAY_DIR } else { Join-Path (Split-Path -Parent $root) "memo-ray" }
    $memorayServerDir = Join-Path $memorayDir "agent-os-dashboard\server"
    if (Test-Path $memorayServerDir) {
        if (-not (Test-Path (Join-Path $memorayServerDir "node_modules"))) {
            Write-Host "▸ npm install (memo-ray server)"
            Push-Location $memorayServerDir
            npm install
            Pop-Location
        }
        $memorayServer = Start-Process `
            -FilePath "node" `
            -ArgumentList "index.js" `
            -WorkingDirectory $memorayServerDir `
            -PassThru `
            -NoNewWindow
        $procs += $memorayServer
        Write-Host "  memoray PID = $($memorayServer.Id) (server :3001 — page at /#/_prime_silo/memory)"
    } else {
        Write-Host "  memo-ray not found at '$memorayDir' — memory page will show an offline screen."
        Write-Host "  Clone https://github.com/binary16labs/memo-ray beside prime-silo (or set MEMORAY_DIR), then run scripts/memoray.ps1."
    }
}

try {
    Wait-Process -Id ($procs | ForEach-Object { $_.Id })
} finally {
    foreach ($p in $procs) {
        if ($p -and -not $p.HasExited) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
