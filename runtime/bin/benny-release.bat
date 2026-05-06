@echo off
setlocal enabledelayedexpansion

:: Benny Studio Release Gate Audit
:: Requires: pip install -e ".[dev]"

where benny-release >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] benny-release not found in PATH.
    echo Please run: pip install -e .[dev]
    exit /b 1
)

benny-release %*
