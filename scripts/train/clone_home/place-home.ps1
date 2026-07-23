<#
  T1 - place the Benny-home clone on the trainer (T480).

  The desktop assembled the clone source on an external SSD. The T480 internal
  disk cannot fit the ~30 GB benny-home, so the home RUNS OFF the external drive
  (PRIME_SILO_HOME -> <ExternalHome>); the small (~85 MB) memo-ray store is copied
  to the canonical internal path for fast, frequent training reads.

  Idempotent: safe to re-run (robocopy skips unchanged files; setx re-asserts).
  Reversible: remove the PRIME_SILO_HOME / MEMORAY_DATA_DIR user env vars to revert.

  Usage (from a normal PowerShell):
    scripts\train\clone_home\place-home.ps1 -ExternalHome 'D:\benny-home' -MemSrc 'D:\mem0ray-data'
#>
param(
  [string]$ExternalHome = 'D:\benny-home',
  [string]$MemSrc       = 'D:\mem0ray-data',
  # Canonical internal memo-ray path. NOTE: .mem0ray (NOT the stale .memoray sibling).
  [string]$MemDst       = (Join-Path $env:USERPROFILE '.mem0ray\data')
)

$ErrorActionPreference = 'Stop'

$bennySub = Join-Path $ExternalHome 'benny'
if (-not (Test-Path $bennySub)) {
  throw "ExternalHome has no benny subdir at $bennySub - is the external drive plugged in with the right letter?"
}

# 1. memo-ray store -> canonical internal .mem0ray\data (fast local reads during training).
if (Test-Path $MemSrc) {
  Write-Host "[place-home] copying memo-ray: $MemSrc -> $MemDst"
  robocopy $MemSrc $MemDst /E /NFL /NDL /NJH /NP /MT:8 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
} else {
  Write-Host "[place-home] WARN: $MemSrc absent - skipping memo-ray copy"
}

# 2. Point the home resolver at the clone (precedence #1: PRIME_SILO_HOME env).
#    Leave BENNY_HOME / CUSTOMWARE_PATH UNSET so they derive from the root cleanly
#    (<root>\benny, <root>\customware) with no divergence warnings.
setx PRIME_SILO_HOME $ExternalHome | Out-Null
setx MEMORAY_DATA_DIR $MemDst       | Out-Null
$env:PRIME_SILO_HOME  = $ExternalHome
$env:MEMORAY_DATA_DIR = $MemDst

# 3. Also persist the home in prime-silo-config.json (resolver precedence #2), so a
#    fresh terminal/session resolves the clone WITHOUT needing the env var reloaded
#    (this is what the tray 'Configure Home...' writes). Merge, don't clobber.
$cfgDir  = Join-Path $env:APPDATA 'Prime-Silo'
$cfgFile = Join-Path $cfgDir 'prime-silo-config.json'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = @{}
if (Test-Path $cfgFile) {
  try { $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $cfg = [pscustomobject]@{} }
}
$cfg | Add-Member -NotePropertyName homeDir -NotePropertyValue $ExternalHome -Force
# UTF-8 WITHOUT BOM — Node's JSON.parse throws on a leading BOM (the resolver would
# then treat the config as absent and fall back to the per-user default).
[System.IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[place-home] prime-silo-config.json homeDir = $ExternalHome ($cfgFile)"

Write-Host "[place-home] PRIME_SILO_HOME  = $ExternalHome  (benny + customware derive from it)"
Write-Host "[place-home] MEMORAY_DATA_DIR = $MemDst"
Write-Host "[place-home] done. Verify with: node scripts\gates\t1.mjs"
