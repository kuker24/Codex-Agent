#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${1:-${CODEX_WORKSPACE:-$(pwd)}}"
PANE_INDEX="${2:-0}"
PANE_NAME="${3:-Agent}"

SANDBOX="${CODEX_SANDBOX:-workspace-write}"
APPROVAL="${CODEX_APPROVAL:-on-request}"
MODEL="${CODEX_MODEL:-}"
CODEX_BIN="${CODEX_BIN:-codex}"

cd "${WORKSPACE}"

printf '\033]2;%s\007' "${PANE_NAME}"
echo "[${PANE_NAME}] workspace: ${WORKSPACE}"
echo "[${PANE_NAME}] starting Codex..."

args=(
  --no-alt-screen
  --cd "${WORKSPACE}"
  --sandbox "${SANDBOX}"
  --ask-for-approval "${APPROVAL}"
)

if [[ -n "${MODEL}" ]]; then
  args+=(--model "${MODEL}")
fi

exec "${CODEX_BIN}" "${args[@]}"
