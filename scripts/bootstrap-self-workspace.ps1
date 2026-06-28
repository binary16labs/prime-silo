# bootstrap-self-workspace.ps1
#
# Packages the prime-silo repo into a local Benny workspace called 'prime_silo_self'
# to enable Tree-sitter code graph scanning and Docling document RAG ingestion.

$ErrorActionPreference = "Stop"

$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Split-Path -Parent $PSScriptRoot

# Resolve Workspace Root
$workspaceRoot = if ($env:BENNY_HOME) {
    Join-Path $env:BENNY_HOME "workspaces"
} else {
    Join-Path $repoRoot "workspace"
}

$wsName = "prime_silo_self"
$wsPath = Join-Path $workspaceRoot $wsName

Write-Host ">>> Bootstrapping workspace '$wsName' at: $wsPath" -ForegroundColor Cyan

# Create Directory Tree
$subdirs = @("src", "staging", "data_in", "data_out", "runs")
foreach ($dir in $subdirs) {
    $targetPath = Join-Path $wsPath $dir
    if (-not (Test-Path $targetPath)) {
        New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
    }
}

# 1. Package/Copy Source Files (excluding dev/build artifacts)
Write-Host ">>> Copying repository source files to workspace/src..." -ForegroundColor Yellow

$srcFolders = @("runtime", "server", "app", "packaging", "scripts")
$srcFiles = @("package.json", "space.js")

$destSrc = Join-Path $wsPath "src"

# Exclusions: dev/build artifacts that must never enter the workspace copy.
$excludeDirs = @("node_modules", ".venv", ".git", ".pytest_cache", ".benny_home",
                 "workspace", "workspaces", "dist", "runtime-bundle", "home")

# Cross-platform recursive copy that skips excluded directory NAMES during
# traversal (so excluded trees are never copied). Replaces robocopy, which is
# Windows-only and broke the Linux CI runner ("robocopy is not recognized").
function Copy-Filtered($src, $dst, $exclude) {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $src -Force) {
        if ($item.PSIsContainer) {
            if ($exclude -contains $item.Name) { continue }
            Copy-Filtered $item.FullName (Join-Path $dst $item.Name) $exclude
        } else {
            Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $dst $item.Name) -Force
        }
    }
}

# Copy Folders (cross-platform; excludes dev/build artifacts during traversal).
foreach ($f in $srcFolders) {
    $fullPath = Join-Path $repoRoot $f
    if (Test-Path $fullPath) {
        Write-Host "    Syncing folder $f -> src/$f"
        Copy-Filtered $fullPath (Join-Path $destSrc $f) $excludeDirs
    }
}

# Copy Files using Copy-Item
foreach ($f in $srcFiles) {
    $fullPath = Join-Path $repoRoot $f
    if (Test-Path $fullPath) {
        Write-Host "    Copying file $f -> src/$f"
        Copy-Item -Path $fullPath -Destination $destSrc -Force | Out-Null
    }
}

# 2. Package/Copy Documentation to staging/
Write-Host ">>> Copying documentation to workspace/staging..." -ForegroundColor Yellow

$docFolders = @("docs", "architecture")
$docFiles = @(
    "README.md",
    "DEVOPS.md",
    "GUIDE.md",
    "AGENTS.md",
    "AGENT-AWARENESS.md",
    "CLAUDE.md",
    "CLI.md",
    "INDEX.md",
    "RELEASE.md"
)

$destStaging = Join-Path $wsPath "staging"

# Sync Doc Folders
foreach ($f in $docFolders) {
    $fullPath = Join-Path $repoRoot $f
    if (Test-Path $fullPath) {
        $destPath = Join-Path $destStaging $f
        Write-Host "    Syncing folder $f -> staging/$f"
        & robocopy $fullPath $destPath /E /XD node_modules .venv .git workspace workspaces dist runtime-bundle home /R:1 /W:1 /NDL /NFL /NJH /NJS | Out-Null
        if ($LASTEXITCODE -ge 8) {
            Write-Error "Robocopy of $f failed with exit code $LASTEXITCODE"
        }
    }
}

# Copy Doc Files
foreach ($f in $docFiles) {
    $fullPath = Join-Path $repoRoot $f
    if (Test-Path $fullPath) {
        Write-Host "    Copying file $f -> staging/$f"
        Copy-Item -Path $fullPath -Destination $destStaging -Force | Out-Null
    }
}

# Reset exit code for powershell chain
$global:LASTEXITCODE = 0

Write-Host "✅ Workspace '$wsName' prepared successfully!" -ForegroundColor Green
Write-Host "Next, run the ingestion pipeline via benny_cli:" -ForegroundColor Cyan
Write-Host "  python runtime/benny_cli.py enrich --workspace $wsName --src src --manifest runtime/manifests/templates/knowledge_enrichment_pipeline.json --run" -ForegroundColor Yellow
