#!/usr/bin/env pwsh

<#
.SYNOPSIS
    Prime Silo Release Manager - PowerShell wrapper for release management

.DESCRIPTION
    Manages versioning and release tagging for Prime Silo

.PARAMETER Command
    The command to execute: init, patch, minor, major, list, current, help

.EXAMPLE
    .\manage-release.ps1 patch
    .\manage-release.ps1 minor
    .\manage-release.ps1 list
#>

param(
    [Parameter(Position = 0)]
    [string]$Command = "help"
)

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptFile = Join-Path $scriptPath "manage-release.js"

# Ensure we're using the correct node version
$nodeExe = if (Get-Command node -ErrorAction SilentlyContinue) { "node" } else { "node.exe" }

# Run the Node.js script
& $nodeExe $scriptFile $Command

exit $LASTEXITCODE
