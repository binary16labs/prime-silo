#!/usr/bin/env sh
# Quick-launch wrapper — run from the project root.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec F:/optimus/venv/Scripts/python.exe "$SCRIPT_DIR/benny_cli.py" "$@"
