# Prime-Silo demo site launcher (PowerShell)
#
# Serves the static demo/manual site on :4173. The site's live dashboard
# expects the runtime on :8005 (boot via scripts/dev.ps1) but works fine
# without it — offline cards show boot instructions.

$root = Split-Path -Parent $PSScriptRoot
$site = Join-Path $root "site"

Write-Host "▸ Prime-Silo demo site → http://localhost:4173"
python -m http.server 4173 --directory $site
