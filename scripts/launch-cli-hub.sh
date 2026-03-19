#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${TMUX_SESSION_NAME:-ai-agent-hub}"
PANEL_COUNT="${1:-${PANEL_COUNT:-6}}"
WORKSPACE="${CODEX_WORKSPACE:-${ROOT_DIR}}"
WORKSPACE_MODE="${AI_AGENT_HUB_WORKSPACE_MODE:-shared}"
WORKSPACES_FILE="${AI_AGENT_HUB_WORKSPACES_FILE:-}"
ALACRITTY_BIN="${ALACRITTY_BIN:-alacritty}"
CODEX_BIN="${CODEX_BIN:-codex}"
TMUX_BIN="${TMUX_BIN:-}"
TMUX_LOCAL_PREFIX="${TMUX_LOCAL_PREFIX:-${HOME}/.local/share/ai-agent-hub-tmux}"
FONT_SIZE="${ALACRITTY_FONT_SIZE:-}"
FONT_FAMILY="${ALACRITTY_FONT_FAMILY:-}"
DETACHED_MODE="${AI_AGENT_HUB_DETACHED:-0}"
ALACRITTY_THEME_FILE="${ROOT_DIR}/config/alacritty-apple.toml"
TMUX_THEME_FILE="${ROOT_DIR}/config/tmux-apple.conf"

case "${PANEL_COUNT}" in
  2|4|5|6) ;;
  *)
    echo "Panel count must be 2, 4, 5, or 6." >&2
    exit 1
    ;;
esac

resolve_tmux_bin() {
  if [[ -n "${TMUX_BIN}" && -x "${TMUX_BIN}" ]]; then
    printf '%s\n' "${TMUX_BIN}"
    return
  fi

  if command -v tmux >/dev/null 2>&1; then
    command -v tmux
    return
  fi

  if [[ -x "${TMUX_LOCAL_PREFIX}/bin/tmux" ]]; then
    printf '%s\n' "${TMUX_LOCAL_PREFIX}/bin/tmux"
    return
  fi

  "${ROOT_DIR}/scripts/build-tmux-local.sh" >/dev/null
  printf '%s\n' "${TMUX_LOCAL_PREFIX}/bin/tmux"
}

TMUX_BIN="$(resolve_tmux_bin)"

if ! command -v "${CODEX_BIN}" >/dev/null 2>&1; then
  echo "Codex binary not found: ${CODEX_BIN}" >&2
  exit 1
fi

declare -a AGENT_WORKSPACES=()

normalize_workspace() {
  local raw="$1"
  python3 - "$raw" <<'PY'
import os, pathlib, sys
path = pathlib.Path(sys.argv[1]).expanduser()
print(os.path.abspath(path))
PY
}

load_workspaces() {
  local raw_workspace

  case "${WORKSPACE_MODE}" in
    shared|split) ;;
    *)
      echo "Workspace mode must be shared or split." >&2
      exit 1
      ;;
  esac

  if [[ -n "${WORKSPACES_FILE}" ]]; then
    if [[ ! -f "${WORKSPACES_FILE}" ]]; then
      echo "Workspace file not found: ${WORKSPACES_FILE}" >&2
      exit 1
    fi

    while IFS= read -r raw_workspace; do
      [[ -z "${raw_workspace}" ]] && continue
      AGENT_WORKSPACES+=("$(normalize_workspace "${raw_workspace}")")
    done < "${WORKSPACES_FILE}"
  fi

  if [[ ${#AGENT_WORKSPACES[@]} -eq 0 ]]; then
    AGENT_WORKSPACES=("$(normalize_workspace "${WORKSPACE}")")
  fi

  if [[ "${WORKSPACE_MODE}" == "shared" ]]; then
    AGENT_WORKSPACES=("${AGENT_WORKSPACES[0]}")
  fi

  if [[ "${WORKSPACE_MODE}" == "split" && ${#AGENT_WORKSPACES[@]} -ne ${PANEL_COUNT} ]]; then
    echo "Split workspace mode requires exactly ${PANEL_COUNT} workspace entries." >&2
    exit 1
  fi

  if [[ "${WORKSPACE_MODE}" == "split" ]]; then
    local unique_count
    unique_count="$(printf '%s\n' "${AGENT_WORKSPACES[@]}" | awk 'NF { seen[$0] = 1 } END { print length(seen) }')"
    if [[ "${unique_count}" -ne "${#AGENT_WORKSPACES[@]}" ]]; then
      echo "Split workspace mode requires each agent to use a different workspace." >&2
      exit 1
    fi
  fi

  for raw_workspace in "${AGENT_WORKSPACES[@]}"; do
    if [[ ! -d "${raw_workspace}" ]]; then
      echo "Workspace not found: ${raw_workspace}" >&2
      exit 1
    fi
  done

  WORKSPACE="${AGENT_WORKSPACES[0]}"
}

workspace_for_pane() {
  local pane_number="$1"

  if [[ "${WORKSPACE_MODE}" == "shared" || ${#AGENT_WORKSPACES[@]} -eq 1 ]]; then
    printf '%s\n' "${AGENT_WORKSPACES[0]}"
    return
  fi

  printf '%s\n' "${AGENT_WORKSPACES[$((pane_number - 1))]}"
}

workspace_title() {
  local pane_number="$1"
  local pane_workspace="$2"
  local pane_name workspace_name

  pane_name="$(printf 'Agent %02d' "${pane_number}")"
  workspace_name="$(basename "${pane_workspace}")"

  if [[ "${workspace_name}" == "/" || -z "${workspace_name}" ]]; then
    workspace_name="${pane_workspace}"
  fi

  printf '%s · %s\n' "${pane_name}" "${workspace_name}"
}

load_workspaces

if [[ -z "${FONT_SIZE}" ]]; then
  case "${PANEL_COUNT}" in
    2) FONT_SIZE="12.5" ;;
    4) FONT_SIZE="11.25" ;;
    5) FONT_SIZE="10.5" ;;
    6) FONT_SIZE="9.5" ;;
  esac
fi

choose_font_family() {
  local family
  local candidates=(
    "SF Mono"
    "Menlo"
    "JetBrainsMono Nerd Font"
    "JetBrains Mono"
    "IBM Plex Mono"
    "Nimbus Mono PS"
    "DejaVu Sans Mono"
  )

  if [[ -n "${FONT_FAMILY}" ]]; then
    printf '%s\n' "${FONT_FAMILY}"
    return
  fi

  if command -v fc-match >/dev/null 2>&1; then
    for family in "${candidates[@]}"; do
      if [[ "$(fc-match -f '%{family[0]}\n' "${family}" 2>/dev/null | head -n 1)" == "${family}" ]]; then
        printf '%s\n' "${family}"
        return
      fi
    done

    fc-match -f '%{family[0]}\n' monospace 2>/dev/null | head -n 1
    return
  fi

  printf '%s\n' "monospace"
}

FONT_FAMILY="$(choose_font_family)"

run_in_pane() {
  local pane_target="$1"
  local pane_number="$2"
  local pane_workspace="$3"
  local pane_name
  local runner_q workspace_q codex_bin_q pane_name_q
  pane_name="$(workspace_title "${pane_number}" "${pane_workspace}")"
  printf -v runner_q '%q' "${ROOT_DIR}/scripts/run-codex-pane.sh"
  printf -v workspace_q '%q' "${pane_workspace}"
  printf -v codex_bin_q '%q' "${CODEX_BIN}"
  printf -v pane_name_q '%q' "${pane_name}"

  "${TMUX_BIN}" select-pane -t "${pane_target}" -T "${pane_name}"
  "${TMUX_BIN}" send-keys -t "${pane_target}" \
    "CODEX_WORKSPACE=${workspace_q} CODEX_BIN=${codex_bin_q} ${runner_q} ${workspace_q} ${pane_number} ${pane_name_q}" \
    C-m
}

prepare_session() {
  if "${TMUX_BIN}" has-session -t "${SESSION_NAME}" 2>/dev/null; then
    "${TMUX_BIN}" kill-session -t "${SESSION_NAME}"
  fi

  "${TMUX_BIN}" new-session -d -s "${SESSION_NAME}" -n codex-hub -c "${WORKSPACE}"
  "${TMUX_BIN}" set-option -t "${SESSION_NAME}" allow-rename off
  "${TMUX_BIN}" setw -t "${SESSION_NAME}" automatic-rename off
  "${TMUX_BIN}" set-option -t "${SESSION_NAME}" detach-on-destroy off
  "${TMUX_BIN}" source-file "${TMUX_THEME_FILE}"
  ROOT_PANE="$("${TMUX_BIN}" display-message -p -t "${SESSION_NAME}:0.0" '#{pane_id}')"
}

layout_two() {
  "${TMUX_BIN}" split-window -h -t "${ROOT_PANE}" -p 50 -c "${WORKSPACE}" >/dev/null
}

layout_four() {
  local right_pane
  right_pane="$("${TMUX_BIN}" split-window -h -P -F '#{pane_id}' -t "${ROOT_PANE}" -p 50 -c "${WORKSPACE}")"
  "${TMUX_BIN}" split-window -v -t "${ROOT_PANE}" -p 50 -c "${WORKSPACE}" >/dev/null
  "${TMUX_BIN}" split-window -v -t "${right_pane}" -p 50 -c "${WORKSPACE}" >/dev/null
}

layout_five() {
  "${TMUX_BIN}" split-window -v -t "${SESSION_NAME}:0.0" -p 50 -c "${WORKSPACE}"
  "${TMUX_BIN}" split-window -h -t "${SESSION_NAME}:0.0" -p 67 -c "${WORKSPACE}"
  "${TMUX_BIN}" split-window -h -t "${SESSION_NAME}:0.1" -p 50 -c "${WORKSPACE}"
  "${TMUX_BIN}" split-window -h -t "${SESSION_NAME}:0.3" -p 50 -c "${WORKSPACE}"
}

layout_six() {
  "${TMUX_BIN}" split-window -v -t "${SESSION_NAME}:0.0" -p 50 -c "${WORKSPACE}"
  "${TMUX_BIN}" split-window -h -t "${SESSION_NAME}:0.0" -p 67 -c "${WORKSPACE}"
  "${TMUX_BIN}" split-window -h -t "${SESSION_NAME}:0.1" -p 50 -c "${WORKSPACE}"
  "${TMUX_BIN}" split-window -h -t "${SESSION_NAME}:0.3" -p 67 -c "${WORKSPACE}"
  "${TMUX_BIN}" split-window -h -t "${SESSION_NAME}:0.4" -p 50 -c "${WORKSPACE}"
}

prepare_session

case "${PANEL_COUNT}" in
  2) layout_two ;;
  4) layout_four ;;
  5) layout_five ;;
  6) layout_six ;;
esac

for pane_id in $("${TMUX_BIN}" list-panes -t "${SESSION_NAME}" -F '#{pane_id}'); do
  "${TMUX_BIN}" send-keys -t "${pane_id}" C-c
  "${TMUX_BIN}" send-keys -t "${pane_id}" "clear" C-m
done

pane_number=1
while IFS= read -r pane_id; do
  pane_workspace="$(workspace_for_pane "${pane_number}")"
  run_in_pane "${pane_id}" "${pane_number}" "${pane_workspace}"
  pane_number=$((pane_number + 1))
done < <("${TMUX_BIN}" list-panes -t "${SESSION_NAME}" -F '#{pane_id}')

if [[ -n "${TMUX:-}" ]]; then
  exec "${TMUX_BIN}" switch-client -t "${SESSION_NAME}"
fi

if [[ "${DETACHED_MODE}" == "1" ]]; then
  echo "tmux session ready: ${SESSION_NAME}"
  echo "font: ${FONT_FAMILY} @ ${FONT_SIZE}"
  echo "attach with: ${TMUX_BIN} attach -t ${SESSION_NAME}"
  exit 0
fi

if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  echo "No graphical display detected. Attaching tmux in current terminal."
  exec "${TMUX_BIN}" attach -t "${SESSION_NAME}"
fi

if ! command -v "${ALACRITTY_BIN}" >/dev/null 2>&1; then
  echo "Alacritty binary not found: ${ALACRITTY_BIN}. Attaching tmux in current terminal."
  exec "${TMUX_BIN}" attach -t "${SESSION_NAME}"
fi

if "${ALACRITTY_BIN}" \
  --title "AI Agent Hub CLI" \
  --class "AIAgentHubCLI,AIAgentHubCLI" \
  --working-directory "${WORKSPACE}" \
  --config-file "${ALACRITTY_THEME_FILE}" \
  -o "font.normal.family=\"${FONT_FAMILY}\"" \
  -o "font.bold.family=\"${FONT_FAMILY}\"" \
  -o "font.italic.family=\"${FONT_FAMILY}\"" \
  -o "font.bold_italic.family=\"${FONT_FAMILY}\"" \
  -o "font.size=${FONT_SIZE}" \
  -e "${TMUX_BIN}" attach -t "${SESSION_NAME}"; then
  exit 0
fi

echo "Failed to launch Alacritty. Attaching tmux in current terminal."
exec "${TMUX_BIN}" attach -t "${SESSION_NAME}"
