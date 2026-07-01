#!/usr/bin/env sh
# Quick-launch wrapper — run from the project root without activating the venv.
# Static, committed file: prefers a project venv, falls back to python3 on PATH.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$SCRIPT_DIR/venv/bin/python" ]; then
    exec "$SCRIPT_DIR/venv/bin/python" "$SCRIPT_DIR/benny_cli.py" "$@"
elif [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
    exec "$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/benny_cli.py" "$@"
else
    exec python3 "$SCRIPT_DIR/benny_cli.py" "$@"
fi
