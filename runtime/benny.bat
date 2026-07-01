@echo off
rem Quick-launch wrapper — run from the project root without activating the venv.
rem Static, committed file: prefers a project venv, falls back to python on PATH.
set "SCRIPT_DIR=%~dp0"
if exist "%SCRIPT_DIR%venv\Scripts\python.exe" (
    "%SCRIPT_DIR%venv\Scripts\python.exe" "%SCRIPT_DIR%benny_cli.py" %*
) else if exist "%SCRIPT_DIR%.venv\Scripts\python.exe" (
    "%SCRIPT_DIR%.venv\Scripts\python.exe" "%SCRIPT_DIR%benny_cli.py" %*
) else (
    python "%SCRIPT_DIR%benny_cli.py" %*
)
