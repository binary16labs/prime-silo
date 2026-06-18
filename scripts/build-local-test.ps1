# Build a LOCAL zero-install test of the Prime-Silo desktop app (Windows x64).
#
# Assembles the full self-contained runtime bundle (embeddable Python + deps +
# Neo4j + Temurin JRE) and produces an UNPACKED app you can launch directly —
# no installer, no Docker, no manual `benny up`. Run this on the Ryzen.
#
#   .\scripts\build-local-test.ps1
#
# Prereqs: Node 20+, internet access, and `tar` (built into Windows 10/11).
# ASCII-only (Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "> Prime-Silo local zero-install test build"
Write-Host "  root = $root"

# Pre-flight.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js not found on PATH. Install Node 20+ and retry."
}
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Write-Error "`tar` not found. Windows 10/11 ships it; ensure C:\Windows\System32 is on PATH."
}
Write-Host ("  node = " + (node --version))

# Dependencies (root + packaging).
Write-Host "> Installing dependencies (npm ci)..."
npm ci --omit=optional
npm ci --prefix packaging

# Build the unpacked app WITH the full runtime bundle.
Write-Host "> Assembling runtime bundle + building unpacked app (this downloads ~hundreds of MB; first run is slow)..."
$env:PRIME_SILO_BUNDLE_RUNTIME = "1"
node packaging/scripts/build-local-test.js

Write-Host ""
Write-Host "> Done. See the verification checklist printed above."
Write-Host "  App: dist\desktop\windows\win-unpacked\Space Agent.exe"
