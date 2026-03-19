#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-127.0.0.1}"
DEFAULT_PORT="${PORT:-4343}"
SERVER_LOG="${AI_AGENT_SWARM_LOG:-/tmp/ai-agent-swarm.log}"
ELECTRON_BIN="${ELECTRON_BIN:-${ROOT_DIR}/node_modules/.bin/electron}"
ALLOW_HEADLESS="${AI_AGENT_SWARM_ALLOW_HEADLESS:-0}"

cd "${ROOT_DIR}"

if [[ "${ALLOW_HEADLESS}" != "1" && -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  echo "Desktop session tidak terdeteksi. Mode Agent Swarm desktop butuh DISPLAY atau WAYLAND_DISPLAY." >&2
  exit 1
fi

if [[ ! -x "${ELECTRON_BIN}" ]]; then
  npm install
fi

export AI_AGENT_SWARM_LOG="${SERVER_LOG}"
export HOST="${HOST}"
export SWARM_ELECTRON_HOST="${HOST}"
export SWARM_ELECTRON_DEFAULT_PORT="${DEFAULT_PORT}"
export SWARM_OBJECTIVE="${SWARM_OBJECTIVE:-}"
export SWARM_WORKSPACE="${SWARM_WORKSPACE:-${ROOT_DIR}}"
export SWARM_PROFILE="${SWARM_PROFILE:-adaptive}"
export SWARM_SEARCH="${SWARM_SEARCH:-0}"
export CODEX_MODEL="${CODEX_MODEL:-}"
export CODEX_SANDBOX="${CODEX_SANDBOX:-workspace-write}"
export CODEX_BIN="${CODEX_BIN:-codex}"
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"

echo "Launching Agent Swarm desktop app"
echo "Log file: ${SERVER_LOG}"
echo "Objective: ${SWARM_OBJECTIVE:-manual from dashboard}"
echo "Workspace: ${SWARM_WORKSPACE:-${ROOT_DIR}}"
echo "Electron: ${ELECTRON_BIN}"

exec "${ELECTRON_BIN}" "${ROOT_DIR}/desktop/main.cjs"
