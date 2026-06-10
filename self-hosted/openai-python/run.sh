#!/usr/bin/env bash
# Start the Self-Hosted playbook server on :8080.
# Loads .env automatically (via python-dotenv inside server.py).
set -euo pipefail
cd "$(dirname "$0")"

if command -v uv >/dev/null 2>&1; then
  exec uv run python server.py
else
  exec python server.py
fi
