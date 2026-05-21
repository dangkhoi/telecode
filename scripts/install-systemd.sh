#!/usr/bin/env bash
# Telecode installer — Linux systemd --user
#
# Plan §5 (Phase 2 — Linux support). Mirrors the structure of
# scripts/install-launchd.sh (macOS). Writes a systemd user unit at
# ~/.config/systemd/user/telecode.service and enables it.
#
# Usage:
#   ./scripts/install-systemd.sh                # interactive install
#   ./scripts/install-systemd.sh --dry-run      # print unit + commands, do not execute
#   ./scripts/install-systemd.sh --help         # show usage
#
# Env overrides (handy for non-interactive automation, e.g. CI / Ansible):
#   TELECODE_BOT_TOKEN          — Telegram bot token (skips wizard prompt)
#   TELECODE_ALLOWED_CHAT_IDS   — comma-separated chat IDs (skips prompt)
#   TELECODE_KIRO_BINARY        — absolute path to kiro-cli (optional)
#   TELECODE_INSTALL_DIR        — install dir override (default: repo dir if dist/ exists, else /opt/telecode)
#
# shellcheck disable=SC2155  # local x=$(...) is fine for our purposes

set -euo pipefail

# --------------------------------------------------------------------------
# Globals
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOME_DIR="${HOME}/.telecode"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/telecode.service"
UNIT_NAME="telecode.service"

DRY_RUN=0
TMP_FILES=()

# --------------------------------------------------------------------------
# Output helpers — match install-launchd.sh's tone
# --------------------------------------------------------------------------
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*" 1>&2; }
info() { printf '  · %s\n' "$*"; }

# --------------------------------------------------------------------------
# Cleanup trap — remove any temp files we created
# --------------------------------------------------------------------------
cleanup() {
  # Don't let a trap return non-zero — the EXIT trap inherits the failing
  # command's status when set -e is active, which would mask the real exit
  # code if the trap's last command happens to be a false-evaluated test.
  local f
  for f in "${TMP_FILES[@]:-}"; do
    [[ -n "${f}" && -e "${f}" ]] && rm -f "${f}"
  done
  return 0
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# Usage
# --------------------------------------------------------------------------
usage() {
  cat <<EOF
Telecode systemd installer

USAGE:
  ${0##*/} [--dry-run] [--help]

OPTIONS:
  --dry-run       Print the unit file and systemctl commands but do not
                  execute them. Useful for verifying output in tests or
                  reviewing config before applying.
  --help, -h      Show this message.

ENVIRONMENT:
  TELECODE_BOT_TOKEN, TELECODE_ALLOWED_CHAT_IDS, TELECODE_KIRO_BINARY,
  TELECODE_INSTALL_DIR — non-interactive overrides (see header comment).
EOF
}

# --------------------------------------------------------------------------
# Parse args
# --------------------------------------------------------------------------
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown arg: ${arg}"; usage; exit 2 ;;
  esac
done

# --------------------------------------------------------------------------
# run_cmd — execute (or print, when --dry-run)
# --------------------------------------------------------------------------
run_cmd() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

# --------------------------------------------------------------------------
# Atomic write — tmpfile + mv. Sets mode if given.
# --------------------------------------------------------------------------
atomic_write() {
  local target="$1"
  local mode="${2:-}"
  local tmp
  tmp="$(mktemp "${target}.XXXXXX")"
  TMP_FILES+=("${tmp}")
  # Read stdin into tmp.
  cat > "${tmp}"
  if [[ -n "${mode}" ]]; then
    chmod "${mode}" "${tmp}"
  fi
  mv -f "${tmp}" "${target}"
  # remove from cleanup list (already moved)
  local i
  for i in "${!TMP_FILES[@]}"; do
    [[ "${TMP_FILES[$i]}" == "${tmp}" ]] && unset 'TMP_FILES[i]'
  done
}

# --------------------------------------------------------------------------
# Detect node binary — prefer absolute path so the unit file is robust
# under systemd's restricted PATH.
# --------------------------------------------------------------------------
detect_node() {
  local n
  n="$(command -v node 2>/dev/null || true)"
  if [[ -n "${n}" ]]; then
    printf '%s' "${n}"
    return 0
  fi
  # NVM fallback — pick highest installed version.
  if [[ -d "${HOME}/.nvm/versions/node" ]]; then
    local latest
    latest="$(ls -1 "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -n1 || true)"
    if [[ -n "${latest}" && -x "${HOME}/.nvm/versions/node/${latest}/bin/node" ]]; then
      printf '%s' "${HOME}/.nvm/versions/node/${latest}/bin/node"
      return 0
    fi
  fi
  return 1
}

# --------------------------------------------------------------------------
# Detect install directory
# --------------------------------------------------------------------------
detect_install_dir() {
  if [[ -n "${TELECODE_INSTALL_DIR:-}" ]]; then
    printf '%s' "${TELECODE_INSTALL_DIR}"
    return 0
  fi
  # Running from a checkout that already has dist/ ? use it.
  if [[ -f "${REPO_DIR}/dist/index.js" ]]; then
    printf '%s' "${REPO_DIR}"
    return 0
  fi
  # Running from a checkout that we can build? still use it.
  if [[ -f "${REPO_DIR}/package.json" ]]; then
    printf '%s' "${REPO_DIR}"
    return 0
  fi
  # Otherwise default to /opt/telecode.
  printf '/opt/telecode'
}

# --------------------------------------------------------------------------
# Prompt-or-env helpers
# --------------------------------------------------------------------------
prompt_or_env() {
  # $1 = env name, $2 = prompt text, $3 = required (1/0), [$4 = default]
  local name="$1" prompt="$2" required="$3" default="${4:-}"
  # ${!name+x} distinguishes "set-to-empty" (honor it) from "unset" (prompt).
  if [[ -n "${!name+x}" ]]; then
    local val="${!name}"
    # For REQUIRED fields, refuse a set-to-empty env override — otherwise an
    # `export TELECODE_BOT_TOKEN=` in CI would silently produce an empty
    # config + .env, which the daemon then rejects with a cryptic zod error
    # at boot. Fail fast at the install seam where the user can correct it.
    if [[ -z "${val}" && "${required}" -eq 1 ]]; then
      err "${name} is set but empty — required for install. unset it to be prompted, or supply a value."
      exit 1
    fi
    printf '%s' "${val}"
    return 0
  fi
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    # In dry-run we don't ask. Required prompts emit a visible placeholder so
    # the user can see the field's shape in the rendered output; optional
    # ones emit nothing.
    if [[ "${required}" -eq 1 ]]; then
      printf '%s' "${default:-<PROMPTED-AT-RUNTIME>}"
    else
      printf '%s' "${default}"
    fi
    return 0
  fi
  local val=""
  if [[ -n "${default}" ]]; then
    read -rp "${prompt} [${default}]: " val || true
    val="${val:-${default}}"
  else
    read -rp "${prompt}: " val || true
  fi
  if [[ -z "${val}" && "${required}" -eq 1 ]]; then
    err "value is required — aborting"
    exit 1
  fi
  printf '%s' "${val}"
}

# --------------------------------------------------------------------------
# Render the unit file body to stdout
# --------------------------------------------------------------------------
render_unit() {
  local node_bin="$1" install_dir="$2" path_env="$3"
  cat <<UNIT_EOF
[Unit]
Description=Telecode daemon (Telegram bridge for Claude Code / Kiro / Codex / Cursor)
Documentation=https://github.com/dangkhoi/telecode
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node_bin} --enable-source-maps ${install_dir}/dist/index.js
WorkingDirectory=${install_dir}
Restart=always
RestartSec=5
Environment=PATH=${path_env}
Environment=TELECODE_HOME=%h/.telecode
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=telecode

[Install]
WantedBy=default.target
UNIT_EOF
}

# --------------------------------------------------------------------------
# Render config.yaml body to stdout
# --------------------------------------------------------------------------
render_config() {
  local kiro_binary="$1" chat_ids_csv="$2"
  # Convert "1,2,3" to YAML inline list "[1, 2, 3]".
  local yaml_list="[]"
  if [[ -n "${chat_ids_csv}" ]]; then
    yaml_list="[$(printf '%s' "${chat_ids_csv}" | sed 's/, */, /g')]"
  fi
  # Build the kiro overlay block separately so we avoid a stray blank line
  # in the generated YAML when no kiro binary was supplied. Heredoc command
  # substitution `$(... <<EOF ... EOF)` always emits a trailing newline that
  # we'd otherwise have to chase from the call site.
  local kiro_block=""
  if [[ -n "${kiro_binary}" ]]; then
    kiro_block=$'  kiro:\n    binary: '"${kiro_binary}"
  fi
  cat <<CONFIG_EOF
# ~/.telecode/config.yaml — generated by install-systemd.sh
telegram:
  bot_token: \${TELEGRAM_BOT_TOKEN}     # loaded from ~/.telecode/.env
  allowed_user_ids: ${yaml_list}
daemon:
  log_dir: ~/.telecode/logs
  approval_timeout_sec: 300
  workspace_scan:
    roots: [~/Documents/workspaces, ~/workspaces, ~/projects]
    max_depth: 1
    exclude: [node_modules, .git, dist, build]
agents:
  claude:
    binary: claude
    setting_sources: [user, project, local]
CONFIG_EOF
  if [[ -n "${kiro_block}" ]]; then
    printf '%s\n' "${kiro_block}"
  fi
  cat <<CONFIG_TAIL_EOF
defaults:
  agent: claude
session_switch_preview_lines: 3
notifier:
  debounce_ms: 3000
  buffer_cap_bytes: 50000
CONFIG_TAIL_EOF
}

# --------------------------------------------------------------------------
# MAIN
# --------------------------------------------------------------------------
bold "Telecode systemd installer"

if [[ "$(uname -s)" != "Linux" && "${DRY_RUN}" -eq 0 ]]; then
  err "this installer is Linux-only (detected: $(uname -s))."
  err "use scripts/install-launchd.sh on macOS, scripts/install-windows.ps1 on Windows."
  exit 1
fi

# 1. Detect node
NODE_BIN="$(detect_node)" || { err "node not found in PATH or ~/.nvm — install Node 22+ first."; exit 1; }
if [[ "${DRY_RUN}" -eq 0 ]]; then
  NODE_MAJOR="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]')"
  if [[ "${NODE_MAJOR}" -lt 22 ]]; then
    err "node ${NODE_MAJOR} too old (need >= 22). Found: ${NODE_BIN}"
    exit 1
  fi
fi
ok "node: ${NODE_BIN}"

# 2. Detect install dir
INSTALL_DIR="$(detect_install_dir)"
if [[ "${DRY_RUN}" -eq 0 && ! -d "${INSTALL_DIR}" ]]; then
  err "install dir does not exist: ${INSTALL_DIR}"
  err "set TELECODE_INSTALL_DIR=... or clone the repo and run from inside it."
  exit 1
fi
ok "install dir: ${INSTALL_DIR}"

# 3. Build PATH for the unit (must be absolute paths — systemd has no shell)
NODE_BIN_DIR="$(dirname "${NODE_BIN}")"
PATH_ENV="${NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# De-dupe just in case node lives in /usr/local/bin.
PATH_ENV="$(printf '%s' "${PATH_ENV}" | awk -v RS=: -v ORS=: '!seen[$0]++' | sed 's/:$//')"

# 4. Prompts (skipped in --dry-run; can be pre-fed via env)
bold ""
bold "Configuration"
BOT_TOKEN="$(prompt_or_env TELECODE_BOT_TOKEN 'Telegram bot token (from @BotFather)' 1 '<TELEGRAM_BOT_TOKEN>')"
CHAT_IDS="$(prompt_or_env TELECODE_ALLOWED_CHAT_IDS 'Allowed Telegram chat IDs (comma-separated, from @userinfobot)' 1 '<USER_ID>')"
KIRO_BINARY="$(prompt_or_env TELECODE_KIRO_BINARY 'Kiro CLI absolute path (blank to skip)' 0 '')"

# 5. Create ~/.telecode (mode 0700)
bold ""
bold "Files"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf '+ install -d -m 0700 %s\n' "${HOME_DIR}"
  printf '+ install -d -m 0700 %s\n' "${HOME_DIR}/logs"
else
  install -d -m 0700 "${HOME_DIR}"
  install -d -m 0700 "${HOME_DIR}/logs"
  ok "${HOME_DIR} (chmod 700)"
fi

# 6. Write config.yaml (mode 0600) — atomic
CONFIG_PATH="${HOME_DIR}/config.yaml"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf '+ atomic_write %s (mode 0600) — body:\n' "${CONFIG_PATH}"
  render_config "${KIRO_BINARY}" "${CHAT_IDS}" | sed 's/^/    /'
elif [[ -f "${CONFIG_PATH}" ]]; then
  ok "config.yaml already present — skipping (edit manually if needed)"
else
  render_config "${KIRO_BINARY}" "${CHAT_IDS}" | atomic_write "${CONFIG_PATH}" 0600
  ok "${CONFIG_PATH} (chmod 600)"
fi

# 7. Write .env (mode 0600) — atomic
ENV_PATH="${HOME_DIR}/.env"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf '+ atomic_write %s (mode 0600) — body:\n' "${ENV_PATH}"
  printf '    TELEGRAM_BOT_TOKEN=%s\n' "${BOT_TOKEN}"
elif [[ -f "${ENV_PATH}" ]] && grep -qE '^TELEGRAM_BOT_TOKEN=' "${ENV_PATH}"; then
  ok ".env already configured — skipping"
else
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "${BOT_TOKEN}" | atomic_write "${ENV_PATH}" 0600
  ok "${ENV_PATH} (chmod 600)"
fi

# 8. Seed policy.yaml if missing
POLICY_PATH="${HOME_DIR}/policy.yaml"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf '+ copy %s/policy.example.yaml -> %s (mode 0600) if missing\n' "${REPO_DIR}" "${POLICY_PATH}"
elif [[ ! -f "${POLICY_PATH}" && -f "${REPO_DIR}/policy.example.yaml" ]]; then
  cp "${REPO_DIR}/policy.example.yaml" "${POLICY_PATH}"
  chmod 600 "${POLICY_PATH}"
  ok "seeded policy.yaml (chmod 600)"
fi

# 9. Build (skip in --dry-run)
if [[ "${DRY_RUN}" -eq 0 && -f "${INSTALL_DIR}/package.json" && ! -f "${INSTALL_DIR}/dist/index.js" ]]; then
  bold ""
  bold "Building telecode"
  ( cd "${INSTALL_DIR}" && npm install --silent && npm run build )
  ok "build OK"
fi

# 10. Write unit file (atomic, mode 0644)
bold ""
bold "Unit file"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf '+ atomic_write %s (mode 0644) — body:\n' "${UNIT_FILE}"
  render_unit "${NODE_BIN}" "${INSTALL_DIR}" "${PATH_ENV}" | sed 's/^/    /'
else
  install -d -m 0755 "${UNIT_DIR}"
  render_unit "${NODE_BIN}" "${INSTALL_DIR}" "${PATH_ENV}" | atomic_write "${UNIT_FILE}" 0644
  ok "${UNIT_FILE}"
fi

# 11. systemctl
bold ""
bold "Activating service"
run_cmd systemctl --user daemon-reload
run_cmd systemctl --user enable --now "${UNIT_NAME}"

# 12. Verify — retry briefly because systemd's transition active→running can
# lag a few hundred ms on slow / VM hosts; a single `sleep 1` flakes there.
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf '+ systemctl --user status %s --no-pager\n' "${UNIT_NAME}"
  printf '+ journalctl --user -u %s -n 20 --no-pager\n' "${UNIT_NAME}"
else
  ACTIVE=0
  for _ in 1 2 3 4 5 6; do
    if systemctl --user is-active --quiet "${UNIT_NAME}"; then
      ACTIVE=1
      break
    fi
    sleep 1
  done
  if [[ "${ACTIVE}" -eq 1 ]]; then
    ok "running: ${UNIT_NAME}"
  else
    warn "service not active after ~6s — recent journal output below:"
    journalctl --user -u "${UNIT_NAME}" -n 20 --no-pager || true
  fi
  systemctl --user status "${UNIT_NAME}" --no-pager || true
fi

# 13. Lingering hint (so the service survives logout on headless boxes)
if [[ "${DRY_RUN}" -eq 0 ]]; then
  if command -v loginctl >/dev/null 2>&1; then
    if ! loginctl show-user "$(id -un)" 2>/dev/null | grep -q '^Linger=yes'; then
      bold ""
      info "tip: to keep telecode running after logout, enable user lingering:"
      info "    sudo loginctl enable-linger $(id -un)"
    fi
  fi
fi

bold ""
bold "Install complete."
echo "  • Status:  systemctl --user status ${UNIT_NAME}"
echo "  • Logs:    journalctl --user -u ${UNIT_NAME} -f"
echo "  • Stop:    systemctl --user stop ${UNIT_NAME}"
echo "  • Restart: systemctl --user restart ${UNIT_NAME}"
echo "  • Uninstall: ./scripts/uninstall-systemd.sh"
