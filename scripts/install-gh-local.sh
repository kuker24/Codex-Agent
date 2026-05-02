#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${GH_INSTALL_ROOT:-${HOME}/.local/share/github-cli}"
BIN_DIR="${GH_BIN_DIR:-${HOME}/.local/bin}"
FORCE_INSTALL="${GH_INSTALL_FORCE:-0}"
VERSION="${GH_INSTALL_VERSION:-}"
GH_INSTALL_SHA256="${GH_INSTALL_SHA256:-}"
OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_NAME="$(uname -m)"

case "${OS_NAME}" in
  linux|darwin) ;;
  *)
    echo "Unsupported OS for gh local install: ${OS_NAME}" >&2
    exit 1
    ;;
esac

case "${ARCH_NAME}" in
  x86_64|amd64) ARCH_NAME="amd64" ;;
  aarch64|arm64) ARCH_NAME="arm64" ;;
  *)
    echo "Unsupported arch for gh local install: ${ARCH_NAME}" >&2
    exit 1
    ;;
esac

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

version = sys.argv[1]
asset_name = sys.argv[2]
api_url = f"https://api.github.com/repos/cli/cli/releases/tags/{urllib.parse.quote(version)}"
with urllib.request.urlopen(api_url, timeout=15) as response:
    payload = json.load(response)

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
  local expected="${GH_INSTALL_SHA256}"
  if [[ -z "${expected}" ]]; then
    if ! expected="$(resolve_release_asset_digest "${VERSION}" "$(basename "${TARBALL_URL}")")"; then
      echo "Failed to resolve release checksum for $(basename "${TARBALL_URL}"). Set GH_INSTALL_SHA256 to continue." >&2
      exit 1
    fi
  fi

  expected="${expected#sha256:}"
  if [[ ! "${expected}" =~ ^[A-Fa-f0-9]{64}$ ]]; then
    echo "Invalid GH_INSTALL_SHA256 value: ${expected}" >&2
    exit 1
  fi

  local actual
  actual="$(compute_sha256 "${archive_path}")"
  if [[ "${actual,,}" != "${expected,,}" ]]; then
    echo "Checksum mismatch for $(basename "${archive_path}")" >&2
    echo "Expected: ${expected}" >&2
    echo "Actual  : ${actual}" >&2
    exit 1
  fi
  echo "Checksum verified for $(basename "${archive_path}")"
}

if [[ -z "${VERSION}" ]]; then
  VERSION="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
fi

TARBALL_URL="${GH_INSTALL_TARBALL_URL:-https://github.com/cli/cli/releases/download/${VERSION}/gh_${VERSION#v}_${OS_NAME}_${ARCH_NAME}.tar.gz}"
INSTALL_DIR="${INSTALL_ROOT}/${VERSION}"
GH_BIN_TARGET="${INSTALL_DIR}/bin/gh"

mkdir -p "${INSTALL_ROOT}" "${BIN_DIR}"

if [[ "${FORCE_INSTALL}" != "1" && -x "${GH_BIN_TARGET}" ]]; then
  ln -sfn "${GH_BIN_TARGET}" "${BIN_DIR}/gh"
  echo "gh already installed at ${GH_BIN_TARGET}"
  "${BIN_DIR}/gh" --version | head -n 1
  exit 0
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

ARCHIVE_PATH="${TMP_DIR}/gh.tar.gz"
EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"

echo "Downloading gh ${VERSION} from ${TARBALL_URL}"
curl -fsSL "${TARBALL_URL}" -o "${ARCHIVE_PATH}"
verify_archive_checksum "${ARCHIVE_PATH}"
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACT_DIR}"

SOURCE_DIR="$(find "${EXTRACT_DIR}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "${SOURCE_DIR}" || ! -x "${SOURCE_DIR}/bin/gh" ]]; then
  echo "Failed to locate extracted gh binary inside ${ARCHIVE_PATH}" >&2
  exit 1
fi

rm -rf "${INSTALL_DIR}"
mv "${SOURCE_DIR}" "${INSTALL_DIR}"
ln -sfn "${GH_BIN_TARGET}" "${BIN_DIR}/gh"

echo "gh installed at ${GH_BIN_TARGET}"
"${BIN_DIR}/gh" --version | head -n 1
