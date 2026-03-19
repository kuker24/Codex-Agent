#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GH_BIN="${GH_BIN:-gh}"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

if ! command -v "${GH_BIN}" >/dev/null 2>&1; then
  bash "${ROOT_DIR}/scripts/install-gh-local.sh"
fi

if "${GH_BIN}" auth status --hostname github.com >/dev/null 2>&1; then
  "${GH_BIN}" auth setup-git >/dev/null 2>&1 || true
  echo "gh already authenticated for github.com"
  "${GH_BIN}" auth status --hostname github.com
  exit 0
fi

if [[ -n "${TOKEN}" ]]; then
  printf '%s' "${TOKEN}" | "${GH_BIN}" auth login --hostname github.com --git-protocol ssh --with-token
  "${GH_BIN}" auth setup-git >/dev/null 2>&1 || true
  "${GH_BIN}" auth status --hostname github.com
  exit 0
fi

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "gh belum login. Jalankan ulang script ini dari terminal interaktif, atau set GH_TOKEN/GITHUB_TOKEN lebih dulu." >&2
  exit 1
fi

"${GH_BIN}" auth login --hostname github.com --git-protocol ssh --web
"${GH_BIN}" auth setup-git >/dev/null 2>&1 || true
"${GH_BIN}" auth status --hostname github.com
