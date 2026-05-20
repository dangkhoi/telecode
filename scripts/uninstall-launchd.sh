#!/usr/bin/env bash
set -euo pipefail
PLIST="${HOME}/Library/LaunchAgents/dev.telecode.daemon.plist"
if [[ -f "${PLIST}" ]]; then
  launchctl unload "${PLIST}" 2>/dev/null || true
  rm -f "${PLIST}"
  echo "removed ${PLIST}"
else
  echo "no plist found at ${PLIST}"
fi
echo "user data preserved at ${HOME}/.telecode (delete manually if desired)."
