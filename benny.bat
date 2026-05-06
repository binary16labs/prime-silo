@echo off
rem Quick-launch wrapper — run from the project root without activating the venv.
set "SCRIPT_DIR=%~dp0"
"F:/optimus/venv/Scripts/python.exe" "%SCRIPT_DIR%\benny_cli.py" %*
