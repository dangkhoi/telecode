#!/usr/bin/env bash
# Telecode installer — macOS launchd
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${HOME}/.telecode"
PLIST="${HOME}/Library/LaunchAgents/dev.telecode.daemon.plist"
LABEL="dev.telecode.daemon"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

bold "Telecode install"

# 1. Check node version
if ! command -v node >/dev/null; then
  err "node not found — install Node 22+ first."
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  err "node ${NODE_MAJOR} too old (need >= 22)"
  exit 1
fi
ok "node $(node --version)"

# 2. ~/.telecode dir with 700
mkdir -p "${HOME_DIR}/logs"
chmod 700 "${HOME_DIR}"
ok "${HOME_DIR} (chmod 700)"

# 3. Seed config + policy if missing
if [[ ! -f "${HOME_DIR}/config.yaml" ]]; then
  cp "${REPO_DIR}/config.example.yaml" "${HOME_DIR}/config.yaml"
  chmod 600 "${HOME_DIR}/config.yaml"

  # Auto-resolve kiro-cli to its real absolute path so the daemon doesn't try
  # to spawn the example's bare `kiro-cli` when launchd's minimal PATH happens
  # to miss the install location (~/.local/bin etc.). Bare name still works
  # via runtime PATH enrichment (buildKiroMcpPath) but writing the absolute
  # path here is defence-in-depth and surfaces the resolution at install time.
  # Env var override: TELECODE_KIRO_BINARY=/abs/path/to/kiro-cli ./install...
  KIRO_BIN="${TELECODE_KIRO_BINARY:-$(command -v kiro-cli 2>/dev/null || echo "")}"
  if [[ -n "${KIRO_BIN}" && -x "${KIRO_BIN}" ]]; then
    # BSD sed (macOS) needs `-i ''`; substitute the example's `binary: kiro-cli`
    # line with the resolved absolute path. Use `|` delimiter so `/` in paths
    # doesn't conflict.
    sed -i '' "s|^    binary: kiro-cli$|    binary: ${KIRO_BIN}|" "${HOME_DIR}/config.yaml"
    ok "seeded config.yaml (kiro-cli → ${KIRO_BIN})"
  else
    ok "seeded config.yaml (kiro-cli not found in PATH — daemon will try bare name via enriched PATH)"
    warn "If Kiro sessions fail with 'exit ?', install kiro-cli or set binary: /abs/path in ~/.telecode/config.yaml"
  fi
else
  ok "config.yaml already present"
fi
if [[ ! -f "${HOME_DIR}/policy.yaml" ]]; then
  cp "${REPO_DIR}/policy.example.yaml" "${HOME_DIR}/policy.yaml"
  chmod 600 "${HOME_DIR}/policy.yaml"
  ok "seeded policy.yaml"
else
  ok "policy.yaml already present"
fi

# 4. .env wizard
if [[ ! -f "${HOME_DIR}/.env" || -z "$(grep -E '^TELEGRAM_BOT_TOKEN=' "${HOME_DIR}/.env" 2>/dev/null || true)" ]]; then
  bold ""
  bold "Telegram bot token wizard"
  cat <<'EOF'
  ┌──────────────────────────────────────────────────────────────┐
  │  1. Open Telegram on your phone or desktop.                  │
  │  2. Search @BotFather and start a chat.                      │
  │  3. Send  /newbot                                            │
  │  4. Pick a name + username (must end in `bot`).              │
  │  5. BotFather replies with a token like                      │
  │       1234567890:ABCdef-GhI...                               │
  │  6. Copy that token, then paste it here.                     │
  └──────────────────────────────────────────────────────────────┘
EOF
  read -rp "Paste TELEGRAM_BOT_TOKEN: " TOKEN
  if [[ -z "${TOKEN}" ]]; then
    err "empty token — aborting"
    exit 1
  fi
  touch "${HOME_DIR}/.env"
  chmod 600 "${HOME_DIR}/.env"
  # remove any old line, then append
  grep -v '^TELEGRAM_BOT_TOKEN=' "${HOME_DIR}/.env" > "${HOME_DIR}/.env.tmp" || true
  echo "TELEGRAM_BOT_TOKEN=${TOKEN}" >> "${HOME_DIR}/.env.tmp"
  mv "${HOME_DIR}/.env.tmp" "${HOME_DIR}/.env"
  chmod 600 "${HOME_DIR}/.env"
  ok "saved token"
else
  ok ".env already configured"
fi

# 5. Build
bold ""
bold "Building telecode"
( cd "${REPO_DIR}" && npm install --silent && npm run build )
ok "build OK"

# 6. Write plist
mkdir -p "$(dirname "${PLIST}")"
NODE_BIN="$(command -v node)"
cat > "${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>--enable-source-maps</string>
    <string>${REPO_DIR}/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${HOME_DIR}/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>${HOME_DIR}/logs/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${HOME}</string>
  </dict>
</dict>
</plist>
PLIST_EOF
ok "plist → ${PLIST}"

# 7. Load
launchctl unload "${PLIST}" 2>/dev/null || true
launchctl load "${PLIST}"
ok "loaded"

sleep 1
if launchctl list | grep -q "${LABEL}"; then
  ok "running: ${LABEL}"
else
  warn "not visible in launchctl list — check ${HOME_DIR}/logs/stderr.log"
fi

bold ""
bold "Install complete."
echo "  • Logs:    tail -f ${HOME_DIR}/logs/telecode.log"
echo "  • Stop:    launchctl unload ${PLIST}"
echo "  • Restart: launchctl kickstart -k gui/$(id -u)/${LABEL}"
