@echo off
rem Quick-launch wrapper — run from the project root without activating the venv.
set "SCRIPT_DIR=%~dp0"
"C:/Python314/python.exe" "%SCRIPT_DIR%\benny_cli.py" %*
