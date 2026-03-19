#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASHRC="${HOME}/.bashrc"
ZSHRC="${HOME}/.zshrc"
FISH_CONFIG="${HOME}/.config/fish/config.fish"
LOCAL_BIN="${HOME}/.local/bin"
CODEX_PATH="${LOCAL_BIN}/codex"
CODEX_OPENAI_PATH="${LOCAL_BIN}/codex-openai"
MARK_START="# >>> ai-agent-hub codex agent >>>"
MARK_END="# <<< ai-agent-hub codex agent <<<"
TMP_FILE="$(mktemp)"
WRAPPER_TMP="$(mktemp)"

BLOCK=$(cat <<EOF
${MARK_START}
export AI_AGENT_HUB_ROOT="${ROOT_DIR}"
${MARK_END}
EOF
)

FISH_BLOCK=$(cat <<EOF
${MARK_START}
set -gx AI_AGENT_HUB_ROOT "${ROOT_DIR}"
${MARK_END}
EOF
)

write_rc_block() {
  local target_file="$1"
  local block_content="$2"
  local tmp_file
  tmp_file="$(mktemp)"

  if [[ -f "${target_file}" ]]; then
    awk -v start="${MARK_START}" -v end="${MARK_END}" '
      $0 == start { skip = 1; next }
      $0 == end { skip = 0; next }
      skip != 1 { print }
    ' "${target_file}" > "${tmp_file}"
  else
    : > "${tmp_file}"
  fi

  printf '\n%s\n' "${block_content}" >> "${tmp_file}"
  mkdir -p "$(dirname "${target_file}")"
  mv "${tmp_file}" "${target_file}"
}

install_wrapper() {
  mkdir -p "${LOCAL_BIN}"

  if [[ -L "${CODEX_PATH}" && ! -e "${CODEX_OPENAI_PATH}" ]]; then
    mv "${CODEX_PATH}" "${CODEX_OPENAI_PATH}"
  elif [[ -f "${CODEX_PATH}" ]] && ! grep -q 'ai-agent-hub codex wrapper' "${CODEX_PATH}" 2>/dev/null && [[ ! -e "${CODEX_OPENAI_PATH}" ]]; then
    mv "${CODEX_PATH}" "${CODEX_OPENAI_PATH}"
  fi

  if [[ ! -e "${CODEX_OPENAI_PATH}" ]]; then
    if [[ -e "${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js" ]]; then
      ln -sfn "${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js" "${CODEX_OPENAI_PATH}"
    else
      echo "Original Codex binary tidak ditemukan. Install Codex dulu sebelum memasang wrapper." >&2
      exit 1
    fi
  fi

  cat > "${WRAPPER_TMP}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# ai-agent-hub codex wrapper

AI_AGENT_HUB_ROOT="\${AI_AGENT_HUB_ROOT:-${ROOT_DIR}}"
CODEX_OPENAI_BIN="${CODEX_OPENAI_PATH}"
PYTHON_BIN="\${PYTHON_BIN:-python3}"

if [[ ! -f "\${AI_AGENT_HUB_ROOT}/scripts/codex_agent.py" ]]; then
  AI_AGENT_HUB_ROOT="${ROOT_DIR}"
fi

if [[ "\${1-}" == "agent" ]]; then
  shift
  exec "\${PYTHON_BIN}" "\${AI_AGENT_HUB_ROOT}/scripts/codex_agent.py" "\$@"
fi

if [[ -x "\${CODEX_OPENAI_BIN}" || -L "\${CODEX_OPENAI_BIN}" ]]; then
  exec "\${CODEX_OPENAI_BIN}" "\$@"
fi

if [[ -e "${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js" ]]; then
  exec "${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js" "\$@"
fi

echo "Original Codex binary tidak ditemukan di \${CODEX_OPENAI_BIN}" >&2
exit 127
EOF

  chmod +x "${WRAPPER_TMP}"
  mv "${WRAPPER_TMP}" "${CODEX_PATH}"
}

install_wrapper
write_rc_block "${BASHRC}" "${BLOCK}"
write_rc_block "${ZSHRC}" "${BLOCK}"
write_rc_block "${FISH_CONFIG}" "${FISH_BLOCK}"

rm -f "${TMP_FILE}" "${WRAPPER_TMP}" 2>/dev/null || true

echo "Installed codex agent wrapper at ${CODEX_PATH}"
echo "Original Codex delegated via ${CODEX_OPENAI_PATH}"
echo "Updated shell env blocks in:"
echo "- ${BASHRC}"
echo "- ${ZSHRC}"
echo "- ${FISH_CONFIG}"
