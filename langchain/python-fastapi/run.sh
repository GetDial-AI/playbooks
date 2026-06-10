#!/usr/bin/env bash
# Start the Dial Dashboard.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

PORT="${PORT:-8000}"
echo "Dial Dashboard → http://localhost:${PORT}"
exec .venv/bin/uvicorn server:app --host 127.0.0.1 --port "${PORT}" "$@"
