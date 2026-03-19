#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${HOME}/.local/share/ai-agent-hub-tmux"
BUILD_DIR="${HOME}/.cache/ai-agent-hub-tmux-build"
TMUX_PREFIX="${TMUX_PREFIX:-${TOOLS_DIR}}"
TMUX_VERSION="${TMUX_VERSION:-}"
GITHUB_API_URL="https://api.github.com/repos/tmux/tmux/releases/latest"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

resolve_version() {
  if [[ -n "${TMUX_VERSION}" ]]; then
    printf '%s\n' "${TMUX_VERSION}"
    return
  fi

  curl -fsSL "${GITHUB_API_URL}" | sed -n 's/.*"tag_name": "\(.*\)".*/\1/p' | head -n 1
}

require_cmd curl
require_cmd tar
require_cmd make
require_cmd gcc
require_cmd pkg-config

TMUX_VERSION="$(resolve_version)"
if [[ -z "${TMUX_VERSION}" ]]; then
  echo "Failed to resolve tmux release version." >&2
  exit 1
fi

ARCHIVE_NAME="tmux-${TMUX_VERSION}.tar.gz"
SOURCE_DIR="${BUILD_DIR}/tmux-${TMUX_VERSION}"
ARCHIVE_PATH="${BUILD_DIR}/${ARCHIVE_NAME}"
DOWNLOAD_URL="https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/${ARCHIVE_NAME}"

mkdir -p "${BUILD_DIR}" "${TOOLS_DIR}"

if [[ ! -f "${ARCHIVE_PATH}" ]]; then
  echo "Downloading tmux ${TMUX_VERSION}..."
  curl -fL "${DOWNLOAD_URL}" -o "${ARCHIVE_PATH}"
fi

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "Extracting ${ARCHIVE_NAME}..."
  tar -xzf "${ARCHIVE_PATH}" -C "${BUILD_DIR}"
fi

echo "Building tmux ${TMUX_VERSION} into ${TMUX_PREFIX}..."
cd "${SOURCE_DIR}"
./configure --prefix="${TMUX_PREFIX}"
make -j"$(getconf _NPROCESSORS_ONLN)"
make install

echo "tmux built successfully:"
"${TMUX_PREFIX}/bin/tmux" -V
