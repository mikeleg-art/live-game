#!/usr/bin/env sh
# Locked Grid Lottery — one-command starter (Linux / macOS / VPS)
# Usage:   ./start.sh     (or:  sh start.sh)
cd "$(dirname "$0")" || exit 1

# tolerate being launched from the parent folder
if [ ! -f server.js ] && [ -f locked-grid-lottery/server.js ]; then
  cd locked-grid-lottery || exit 1
fi

if [ ! -f server.js ]; then
  echo "[X] server.js not found — run this script from inside the extracted locked-grid-lottery folder."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[X] Node.js not found — install Node 18+ first: https://nodejs.org"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[1/2] First run: installing dependencies (about a minute)..."
  npm install --no-audit --no-fund || { echo "[X] npm install failed — check your connection and retry."; exit 1; }
fi

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[i] Created .env from .env.example — edit it to go LIVE on TikTok."
fi

echo "[2/2] Starting Locked Grid Lottery → http://localhost:3000/  (admin: /admin.html)"
exec node server.js
