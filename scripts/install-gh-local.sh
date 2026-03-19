#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${GH_INSTALL_ROOT:-${HOME}/.local/share/github-cli}"
BIN_DIR="${GH_BIN_DIR:-${HOME}/.local/bin}"
FORCE_INSTALL="${GH_INSTALL_FORCE:-0}"
VERSION="${GH_INSTALL_VERSION:-}"
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
