# Prime-Silo dev launcher (PowerShell)
#
# Boots the Benny FastAPI runtime (port 8005) and the space-agent shell in
# parallel. Phase B keeps these as two processes; Phase D wires the shell to
# proxy /api/* to the runtime so a single user-facing port is exposed.
#
# Required environment:
#   BENNY_HMAC_KEY   - hex-encoded HMAC key for manifest + view signing
#                      (must match the key your skin packs were signed with)
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less .ps1
# files as ANSI, so non-ASCII characters (em-dashes, bullets) corrupt the
# parser. Use '-' and '>' instead.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

# Load .env if it exists
if (Test-Path "$root\.env") {
    Write-Host "> Loading .env"
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

# --- Preflight: surface port clashes with a clear diagnosis instead of a
# silent bind failure. The usual culprit is a leftover Docker container
# publishing :3000 (e.g. the legacy dangpy-frontend) relayed by wslrelay.exe.
# See architecture/TECH_DEBT.md (TD-1).
function Get-PortOwner($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
    return [pscustomobject]@{ ProcId = $conn.OwningProcess; Name = $proc.Name }
}

$shellPort = if ($env:PORT) { $env:PORT } else { 3000 }
$shellOwner = Get-PortOwner $shellPort
if ($shellOwner) {
    Write-Host ""
    Write-Host "ERROR: port $shellPort (the space-agent shell) is already in use by PID $($shellOwner.ProcId) ($($shellOwner.Name))." -ForegroundColor Red
    if ($shellOwner.Name -eq "wslrelay.exe") {
        Write-Host "  That is a WSL/Docker port relay - a container is publishing :$shellPort." -ForegroundColor Yellow
        Write-Host "  Find it:  docker ps --filter publish=$shellPort" -ForegroundColor Yellow
        Write-Host "  Stop it:  docker stop <name>   (e.g. dangpy-frontend; reversible via docker start)" -ForegroundColor Yellow
    } else {
        Write-Host "  Stop whatever owns it, or run the shell on another port (set PORT)." -ForegroundColor Yellow
    }
    Write-Host "  Background: architecture/TECH_DEBT.md (TD-1) - legacy dangpy/Kortex containers clash on :3000." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Soft warnings for the other services this script is about to start.
foreach ($svc in @(
    @{ Port = 8005; Label = "Benny runtime" },
    @{ Port = 3001; Label = "Memo-Ray server" },
    @{ Port = 5175; Label = "Memo-Ray client" }
)) {
    $owner = Get-PortOwner $svc.Port
    if ($owner) {
        Write-Host "WARNING: port $($svc.Port) ($($svc.Label)) already in use by PID $($owner.ProcId) ($($owner.Name)) - the new instance may fail to bind." -ForegroundColor Yellow
    }
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

Write-Host "> Prime-Silo dev launcher"
Write-Host "  BENNY_HOME = $env:BENNY_HOME"
Write-Host "  runtime    = $runtimeDir"

# Runtime - FastAPI on :8005
$runtime = Start-Process `
    -FilePath "python" `
    -ArgumentList "-m","benny.api.server" `
    -WorkingDirectory $runtimeDir `
    -PassThru `
    -NoNewWindow

# Shell - space-agent dev server
$shell = Start-Process `
    -FilePath "node" `
    -ArgumentList "server/dev_server.js" `
    -WorkingDirectory $root `
    -PassThru `
    -NoNewWindow

Write-Host "  runtime PID = $($runtime.Id)"
Write-Host "  shell   PID = $($shell.Id)"

# Memo-Ray memory graph (Phase M1) - auto-boot when enabled and the checkout
# exists, so the in-shell page at #/_prime_silo/memory works from one command.
# The shell proxies /api/memoray to the server (:3001); the Vite client (:5175)
# backs the page's "Zen mode" link-out. MEMORAY_ENABLED=false skips both.
$procs = @($runtime, $shell)
if ($env:MEMORAY_ENABLED -ne "false") {
    $memorayDir = if ($env:MEMORAY_DIR) { $env:MEMORAY_DIR } else { Join-Path (Split-Path -Parent $root) "memo-ray" }
    $memorayServerDir = Join-Path $memorayDir "agent-os-dashboard\server"
    $memorayClientDir = Join-Path $memorayDir "agent-os-dashboard\client"
    if (Test-Path $memorayServerDir) {
        foreach ($dir in @($memorayServerDir, $memorayClientDir)) {
            if ((Test-Path $dir) -and -not (Test-Path (Join-Path $dir "node_modules"))) {
                Write-Host "> npm install ($dir)"
                Push-Location $dir
                npm install
                Pop-Location
            }
        }
        $oldPort = $env:PORT
        $env:PORT = "3001"
        $memorayServer = Start-Process `
            -FilePath "node" `
            -ArgumentList "index.js" `
            -WorkingDirectory $memorayServerDir `
            -PassThru `
            -NoNewWindow
        $env:PORT = $oldPort
        $procs += $memorayServer
        Write-Host "  memoray server PID = $($memorayServer.Id) (:3001 - page at /#/_prime_silo/memory)"

        # Client (:5175) - backs the "Zen mode" link. Optional: if the client
        # dir is missing we still have the in-shell page, just no zen link.
        if (Test-Path $memorayClientDir) {
            $npmExec = if ($IsWindows -or $env:OS -match "Windows") { "npm.cmd" } else { "npm" }
            $memorayClient = Start-Process `
                -FilePath $npmExec `
                -ArgumentList "run","dev" `
                -WorkingDirectory $memorayClientDir `
                -PassThru `
                -NoNewWindow
            $procs += $memorayClient
            Write-Host "  memoray client PID = $($memorayClient.Id) (:5175 - Zen mode)"
        }
    } else {
        Write-Host "  memo-ray not found at '$memorayDir' - memory page will show an offline screen."
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
