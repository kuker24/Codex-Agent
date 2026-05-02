#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${HOME}/.local/share/ai-agent-hub-tmux"
BUILD_DIR="${HOME}/.cache/ai-agent-hub-tmux-build"
TMUX_PREFIX="${TMUX_PREFIX:-${TOOLS_DIR}}"
TMUX_VERSION="${TMUX_VERSION:-}"
TMUX_TARBALL_SHA256="${TMUX_TARBALL_SHA256:-}"

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

  python3 - <<'PY'
import json
import urllib.request

with urllib.request.urlopen("https://api.github.com/repos/tmux/tmux/releases/latest", timeout=15) as response:
    payload = json.load(response)
print(payload.get("tag_name", ""))
PY
}

compute_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | awk '{print $1}'
    return
  fi
  echo "Missing checksum tool (sha256sum or shasum)." >&2
  exit 1
}

resolve_release_asset_digest() {
  local version="$1"
  local asset_name="$2"
  python3 - "${version}" "${asset_name}" <<'PY'
import json
import sys
import urllib.parse
import urllib.request

version = sys.argv[1].strip()
asset_name = sys.argv[2]
candidates = []
if version:
    candidates.append(version)
    if version.startswith("v"):
        candidates.append(version[1:])
    else:
        candidates.append(f"v{version}")

seen = set()
for tag in candidates:
    if tag in seen:
        continue
    seen.add(tag)
    url = f"https://api.github.com/repos/tmux/tmux/releases/tags/{urllib.parse.quote(tag)}"
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            payload = json.load(response)
    except Exception:
        continue
    for asset in payload.get("assets", []):
        if asset.get("name") != asset_name:
            continue
        digest = str(asset.get("digest") or "").strip()
        if digest.lower().startswith("sha256:"):
            digest = digest.split(":", 1)[1]
        if digest:
            print(digest)
            raise SystemExit(0)

raise SystemExit(1)
PY
}

verify_archive_checksum() {
  local archive_path="$1"
  local expected="${TMUX_TARBALL_SHA256}"
  if [[ -z "${expected}" ]]; then
    if ! expected="$(resolve_release_asset_digest "${TMUX_VERSION}" "${ARCHIVE_NAME}")"; then
      echo "Failed to resolve tmux release checksum for ${ARCHIVE_NAME}. Set TMUX_TARBALL_SHA256 to continue." >&2
      exit 1
    fi
  fi

  expected="${expected#sha256:}"
  if [[ ! "${expected}" =~ ^[A-Fa-f0-9]{64}$ ]]; then
    echo "Invalid TMUX_TARBALL_SHA256 value: ${expected}" >&2
    exit 1
  fi

  local actual
  actual="$(compute_sha256 "${archive_path}")"
  if [[ "${actual,,}" != "${expected,,}" ]]; then
    echo "Checksum mismatch for ${ARCHIVE_NAME}" >&2
    echo "Expected: ${expected}" >&2
    echo "Actual  : ${actual}" >&2
    exit 1
  fi
  echo "Checksum verified for ${ARCHIVE_NAME}"
}

require_cmd curl
require_cmd tar
require_cmd make
require_cmd gcc
require_cmd pkg-config
require_cmd python3

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

verify_archive_checksum "${ARCHIVE_PATH}"

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
