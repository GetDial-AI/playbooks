#!/usr/bin/env bash
# Start the audio echo server on :8080. Loads .env via python-dotenv.
set -euo pipefail
cd "$(dirname "$0")"
if command -v uv >/dev/null 2>&1; then
  exec uv run python server.py
else
  exec python server.py
fi
