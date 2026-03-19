#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4242}"
URL="http://${HOST}:${PORT}"

cd "$ROOT_DIR"

if [[ ! -d node_modules ]]; then
  npm install
fi

npm start > /tmp/ai-agent-hub.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true' EXIT

for _ in {1..30}; do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi

echo "AI Agent Hub running at $URL"
echo "Log file: /tmp/ai-agent-hub.log"
wait "$SERVER_PID"
