#!/usr/bin/env bash
# Prime-Silo demo site launcher (bash)
# Serves the static demo/manual site on :4173.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "▸ Prime-Silo demo site → http://localhost:4173"
python -m http.server 4173 --directory "$root/site"
