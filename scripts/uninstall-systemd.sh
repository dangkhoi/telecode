#!/usr/bin/env bash
# Telecode uninstaller — Linux systemd --user
#
# Plan §5 (Phase 2 — Linux support). Stops + disables the user unit, removes
# the unit file, optionally wipes ~/.telecode (user is prompted).
#
# Usage:
#   ./scripts/uninstall-systemd.sh                    # interactive
#   ./scripts/uninstall-systemd.sh --dry-run          # print commands only
#   ./scripts/uninstall-systemd.sh --purge            # also wipe ~/.telecode (one confirm)
#   ./scripts/uninstall-systemd.sh --purge --yes      # skip confirm (CI / automation)
#   ./scripts/uninstall-systemd.sh --keep-data        # explicit: keep ~/.telecode
#   ./scripts/uninstall-systemd.sh --help

set -euo pipefail

UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/telecode.service"
UNIT_NAME="telecode.service"
HOME_DIR="${HOME}/.telecode"

DRY_RUN=0
PURGE_MODE=""   # "", "purge", "keep"
ASSUME_YES=0   # --yes — skip the --purge confirm prompt (CI / automation)

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*" 1>&2; }

usage() {
  cat <<EOF
Telecode systemd uninstaller

USAGE:
  ${0##*/} [--dry-run] [--purge|--keep-data] [--yes] [--help]

OPTIONS:
  --dry-run     Print commands only, do not execute.
  --purge       Also delete ~/.telecode (config, .env, DB, logs). Prompts once
                before deleting unless --yes is also supplied.
  --keep-data   Skip the ~/.telecode prompt and keep user data.
  --yes         Skip --purge's confirm prompt. No effect without --purge.
                Useful for CI / automation pipelines that already gated on user
                intent before invoking this script.
  --help, -h    Show this message.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run)     DRY_RUN=1 ;;
    --purge)       PURGE_MODE="purge" ;;
    --keep-data)   PURGE_MODE="keep" ;;
    --yes|-y)      ASSUME_YES=1 ;;
    -h|--help)     usage; exit 0 ;;
    *) err "unknown arg: ${arg}"; usage; exit 2 ;;
  esac
done

run_cmd() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

bold "Telecode uninstall"

# 1. systemctl disable + stop (allow failures — service may already be gone)
if [[ "${DRY_RUN}" -eq 1 ]] || systemctl --user list-unit-files 2>/dev/null | grep -q "^${UNIT_NAME}"; then
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '+ systemctl --user disable --now %s\n' "${UNIT_NAME}"
  else
    systemctl --user disable --now "${UNIT_NAME}" 2>/dev/null || true
    ok "disabled ${UNIT_NAME}"
  fi
else
  warn "${UNIT_NAME} not registered — skipping disable"
fi

# 2. Remove unit file
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf '+ rm -f %s\n' "${UNIT_FILE}"
elif [[ -f "${UNIT_FILE}" ]]; then
  rm -f "${UNIT_FILE}"
  ok "removed ${UNIT_FILE}"
else
  warn "no unit file at ${UNIT_FILE}"
fi

# 3. Reload so systemd forgets about the unit
run_cmd systemctl --user daemon-reload

# 4. ~/.telecode handling
bold ""
if [[ -d "${HOME_DIR}" ]]; then
  case "${PURGE_MODE}" in
    purge)
      # Plan §5 P2.1 requires a confirm prompt before rm -rf — irreversible
      # data loss (config, .env, sessions DB, logs). Honor --yes only for
      # explicit automation use.
      if [[ "${DRY_RUN}" -eq 1 ]]; then
        if [[ "${ASSUME_YES}" -eq 1 ]]; then
          printf '+ rm -rf %s   # --yes, no confirm\n' "${HOME_DIR}"
        else
          printf '+ prompt: PURGE %s? (yes/N) — abort if not "yes"\n' "${HOME_DIR}"
          printf '+ rm -rf %s\n' "${HOME_DIR}"
        fi
      else
        if [[ "${ASSUME_YES}" -ne 1 ]]; then
          warn "About to PERMANENTLY DELETE ${HOME_DIR} (config, .env, sessions DB, logs)."
          warn "This cannot be undone."
          read -rp "Type 'yes' to confirm purge: " ans || ans=""
          if [[ "${ans}" != "yes" ]]; then
            ok "purge aborted — ${HOME_DIR} kept"
            PURGE_MODE="keep"
          fi
        fi
        if [[ "${PURGE_MODE}" == "purge" ]]; then
          rm -rf "${HOME_DIR}"
          ok "removed ${HOME_DIR} (purge)"
        fi
      fi
      ;;
    keep)
      ok "keeping ${HOME_DIR} (--keep-data)"
      ;;
    *)
      if [[ "${DRY_RUN}" -eq 1 ]]; then
        printf '+ prompt: delete %s? (y/N) — default keep\n' "${HOME_DIR}"
      else
        read -rp "Also delete ${HOME_DIR}? [y/N] " ans || true
        ans="${ans:-N}"
        if [[ "${ans}" =~ ^[Yy]$ ]]; then
          rm -rf "${HOME_DIR}"
          ok "removed ${HOME_DIR}"
        else
          ok "kept ${HOME_DIR} (reinstall later to reuse it)"
        fi
      fi
      ;;
  esac
else
  [[ "${DRY_RUN}" -eq 0 ]] && warn "${HOME_DIR} not present"
fi

bold ""
bold "Uninstall complete."
