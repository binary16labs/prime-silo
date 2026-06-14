# Memo-Ray launcher (PowerShell)
#
# Boots the Memo-Ray memory-graph companion (https://github.com/binary16labs/memo-ray):
#   server - Express on :3001 (delta-syncs Claude + Antigravity session logs)
#   client - Vite on :5175 (organic lineage graph UI)
#
# Memo-Ray is the third graph of the cognitive mesh: memory (sessions) beside
# knowledge (documents) and code (AST). Prime-Silo's site dashboard carries a
# live Memo-Ray health card once this is running.
#
# Checkout location: sibling directory ../memo-ray by default; override with
# MEMORAY_DIR.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$memoray = if ($env:MEMORAY_DIR) { $env:MEMORAY_DIR } else { Join-Path (Split-Path -Parent $root) "memo-ray" }

if (-not (Test-Path $memoray)) {
    Write-Error "Memo-Ray checkout not found at '$memoray'. Clone https://github.com/binary16labs/memo-ray beside prime-silo, or set MEMORAY_DIR."
}

$serverDir = Join-Path $memoray "agent-os-dashboard\server"
$clientDir = Join-Path $memoray "agent-os-dashboard\client"

foreach ($dir in @($serverDir, $clientDir)) {
    if (-not (Test-Path (Join-Path $dir "node_modules"))) {
        Write-Host "> npm install in $dir"
        Push-Location $dir
        npm install
        Pop-Location
    }
}

Write-Host "> Memo-Ray launcher"
Write-Host "  server -> http://localhost:3001"
Write-Host "  client -> http://localhost:5175"

$server = Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $serverDir -PassThru -NoNewWindow
$npmExec = if ($IsWindows -or $env:OS -match "Windows") { "npm.cmd" } else { "npm" }
$client = Start-Process -FilePath $npmExec -ArgumentList "run","dev" -WorkingDirectory $clientDir -PassThru -NoNewWindow

Write-Host "  server PID = $($server.Id)"
Write-Host "  client PID = $($client.Id)"

try {
    Wait-Process -Id $server.Id, $client.Id
} finally {
    foreach ($p in @($server, $client)) {
        if ($p -and -not $p.HasExited) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
