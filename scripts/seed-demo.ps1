# Seed the demo (PowerShell)
#
# Loads a working copy of prime-silo's OWN source into a 'prime_silo_self'
# workspace, builds its code graph, and ingests the docs - so you can open the
# Bridge and ask Benny about the very thing you're running.
#
# Prereq: the stack must be up (.\scripts\dev.ps1) so the Benny runtime (:8005)
# is reachable. ASCII-only (Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI).

$ErrorActionPreference = "Stop"

$root      = Split-Path -Parent $PSScriptRoot
$bennyHome = if ($env:BENNY_HOME) { $env:BENNY_HOME } else { Join-Path $root ".benny_home" }
$runtime   = if ($env:RUNTIME_BASE_URL) { $env:RUNTIME_BASE_URL } else { "http://127.0.0.1:8005" }
$apiKey    = if ($env:BENNY_API_KEY) { $env:BENNY_API_KEY } else { "benny-mesh-2026-auth" }
$ws        = "prime_silo_self"
$headers   = @{ "X-Benny-API-Key" = $apiKey }

Write-Host "> Seeding demo workspace '$ws'"
Write-Host "  runtime = $runtime"

# 0. Runtime reachable?
try {
    Invoke-RestMethod -Uri "$runtime/api/workspaces" -Headers $headers -TimeoutSec 5 -ErrorAction Stop | Out-Null
} catch {
    Write-Error "Benny runtime not reachable at $runtime. Start the stack first: .\scripts\dev.ps1"
}

# 1. Create the workspace (ignore 'already exists').
try {
    Invoke-RestMethod -Method Post -Uri "$runtime/api/workspaces/$ws" -Headers $headers -ErrorAction Stop | Out-Null
    Write-Host "  created workspace"
} catch {
    Write-Host "  workspace already exists (reusing)"
}

$wsPath = Join-Path $bennyHome "workspaces\$ws"
$srcPath = Join-Path $wsPath "src"
$dataIn  = Join-Path $wsPath "data_in"
New-Item -ItemType Directory -Force -Path $srcPath | Out-Null
New-Item -ItemType Directory -Force -Path $dataIn  | Out-Null

# 2. Copy the interesting prime-silo source into the workspace (no node_modules).
Write-Host "> Copying prime-silo source into the workspace"
foreach ($d in @("server", "commands")) {
    $dst = Join-Path $srcPath $d
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    Copy-Item -Recurse -Force (Join-Path $root $d) $dst
}
$modSrc = Join-Path $root "app\L0\_all\mod\_prime_silo"
$modDst = Join-Path $srcPath "_prime_silo"
if (Test-Path $modDst) { Remove-Item -Recurse -Force $modDst }
Copy-Item -Recurse -Force $modSrc $modDst

# 3. Copy docs into data_in for RAG ingestion.
Write-Host "> Staging docs for ingestion"
foreach ($doc in @("README.md", "GUIDE.md")) {
    Copy-Item -Force (Join-Path $root $doc) $dataIn -ErrorAction SilentlyContinue
}
Copy-Item -Force (Join-Path $root "docs\USER_GUIDE.md") $dataIn -ErrorAction SilentlyContinue
Copy-Item -Force (Join-Path $root "architecture\ROADMAP.md") $dataIn -ErrorAction SilentlyContinue

# 4. Build the code graph (background scan on the runtime).
Write-Host "> Building the code graph (tree-sitter scan)"
$genBody = @{ workspace = $ws; root_dir = "src"; name = "prime-silo" } | ConvertTo-Json
$gen = Invoke-RestMethod -Method Post -Uri "$runtime/api/graph/code/generate" -Headers $headers -ContentType "application/json" -Body $genBody
Write-Host "  code-graph run: $($gen.run_id) ($($gen.status))"

# 5. Ingest the docs into the knowledge graph.
Write-Host "> Ingesting docs into the knowledge graph"
$ingBody = @{ workspace = $ws } | ConvertTo-Json
try {
    $ing = Invoke-RestMethod -Method Post -Uri "$runtime/api/rag/ingest" -Headers $headers -ContentType "application/json" -Body $ingBody
    Write-Host "  ingest run: $($ing.run_id)"
} catch {
    Write-Host "  doc ingest skipped (ingestion service not ready): $($_.Exception.Message)"
}

Write-Host ""
Write-Host "Seeded '$ws'. The code-graph scan runs in the background (give it a moment)."
Write-Host "Open the Bridge, pick the '$ws' workspace, and try:"
Write-Host "  - Code 3D  : explore the graph; select a node and ask Benny 'Explain this graph'"
Write-Host "  - Documents: see the ingested guides as triples"
Write-Host "  - Ask Benny: 'How does the Bridge cockpit work?' / 'What workflows do we have?'"
Write-Host "  http://localhost:3000/#/_prime_silo/bridge?mode=code"
