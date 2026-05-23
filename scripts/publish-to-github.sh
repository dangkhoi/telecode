#!/usr/bin/env bash
# publish-to-github.sh — sync this repo to a public GitHub mirror with
# clean history (1 commit per release).
#
# Workflow:
#   1. Run security scan (secrets + personal info + .gitignore coverage).
#   2. Shallow-clone the working tree to a scratch dir.
#   3. Reset .git, init fresh, commit once, push to GitHub (force).
#
# Honors two layered Kiro rules:
#   - ~/.kiro/steering/pre-commit-security.md     — global (all workspaces)
#   - .kiro/steering/security-overrides.md        — workspace-local (gitignored)
#
# The PERSONAL_PATTERNS variable below is hardcoded with this workspace's
# (telecode) identifiers as a defense-in-depth layer; copy this script to
# another workspace and edit the regex with that workspace's identifiers.
# Long-term: refactor to read from .kiro/steering/security-overrides.md
# directly.
#
# Usage:
#   scripts/publish-to-github.sh                       # default — uses defaults below
#   scripts/publish-to-github.sh --dry-run             # show what would happen, don't push
#   scripts/publish-to-github.sh --message "release v1.3"
#   scripts/publish-to-github.sh --remote git@github.com:owner/repo.git
#   scripts/publish-to-github.sh --skip-scan           # NOT recommended — must pair with explicit user override
#
# Environment:
#   GITHUB_REMOTE  — default remote URL (overridable by --remote)
#   COMMIT_MESSAGE — default commit message (overridable by --message)

set -euo pipefail

# ---- Defaults ----
GITHUB_REMOTE="${GITHUB_REMOTE:-git@github.com:dangkhoi/telecode.git}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:-Public release ($(date -u +%Y-%m-%d))}"
DRY_RUN=0
SKIP_SCAN=0
SCRATCH_DIR="/tmp/telecode-public-$$"
COMMIT_AUTHOR_NAME="${COMMIT_AUTHOR_NAME:-dangkhoi}"
COMMIT_AUTHOR_EMAIL="${COMMIT_AUTHOR_EMAIL:-khoiphamdang@gmail.com}"

# ---- CLI args ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    --skip-scan) SKIP_SCAN=1; shift;;
    --message) COMMIT_MESSAGE="$2"; shift 2;;
    --remote) GITHUB_REMOTE="$2"; shift 2;;
    --help|-h)
      sed -n '/^# /,/^$/p' "$0" | sed 's/^# //; s/^#$//'
      exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

# ---- Paths ----
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

log() { printf '\033[36m[publish]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[publish]\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[32m[publish]\033[0m %s\n' "$*"; }

# ---- §1. Security scan (per ~/.kiro/steering/pre-commit-security.md) ----
run_security_scan() {
  log "Security scan — secrets / personal info / .gitignore"
  local fail=0

  # 1.1 Secret patterns across all tracked files (not just diff — public mirror
  # snapshots the FULL working tree, so any leak anywhere is exposed).
  local SECRET_PATTERNS='sk-ant-[a-z0-9]{32,}|sk-proj-[a-zA-Z0-9_-]{32,}|ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{82,}|xoxb-[A-Za-z0-9-]{40,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  if git ls-files -z | xargs -0 grep -nlE "$SECRET_PATTERNS" 2>/dev/null | grep -vE "^(tests/(scrub|console-scrub)\.test\.ts$|.*\.example\..*)" | head -1 | grep -q .; then
    err "FAIL: secret patterns found in tracked files:"
    git ls-files -z | xargs -0 grep -nE "$SECRET_PATTERNS" 2>/dev/null | grep -vE "(tests/(scrub|console-scrub)\.test\.ts|\.example\.)" | head -10 >&2
    fail=1
  fi

  # Telegram bot tokens shape: <8-11 digits>:<30-40 base64> — exclude test scrubber fixtures.
  if git ls-files -z | xargs -0 grep -nlE '[0-9]{8,11}:[A-Za-z0-9_-]{30,40}' 2>/dev/null | grep -vE "^tests/(scrub|console-scrub)\.test\.ts$" | head -1 | grep -q .; then
    err "FAIL: possible Telegram bot token found:"
    git ls-files -z | xargs -0 grep -nE '[0-9]{8,11}:[A-Za-z0-9_-]{30,40}' 2>/dev/null | grep -vE "tests/(scrub|console-scrub)\.test\.ts" | head -5 >&2
    fail=1
  fi

  # 1.2 Tracked-file leak — these must NEVER be in `git ls-files`
  local FORBIDDEN='^(\.env$|\.env\.[^e]|.*\.key$|.*\.pem$|.*\.p12$|.*\.pfx$|state\.db$|.*\.sqlite$|daemon\.lock$)'
  if git ls-files | grep -E "$FORBIDDEN" | head -1 | grep -q .; then
    err "FAIL: forbidden file types tracked:"
    git ls-files | grep -E "$FORBIDDEN" >&2
    fail=1
  fi

  # 1.3 Personal info — known sensitive identifiers (override per repo)
  # Whitelist files that legitimately contain the patterns as METADATA
  # (regex definitions, security-policy docs, scan tooling). These files
  # document what to BLOCK; the literal occurrence is intentional, not a
  # leak. Other tracked files match → BLOCK.
  local PERSONAL='@u2526|/Users/koi(/|$)|khoa_telecode_bot|khoiphamdang@gmail\.com|675265747'
  local PERSONAL_WHITELIST='^(scripts/(publish-to-github|security-scan)\.sh$|\.kiro/steering/.*\.example$|\.gitignore$)'
  if git ls-files -z | xargs -0 grep -lE "$PERSONAL" 2>/dev/null | grep -vE "$PERSONAL_WHITELIST" | head -1 | grep -q .; then
    err "FAIL: personal info found in tracked files:"
    git ls-files -z | xargs -0 grep -lE "$PERSONAL" 2>/dev/null | grep -vE "$PERSONAL_WHITELIST" | while read -r f; do
      grep -nE "$PERSONAL" "$f" | head -3 | sed "s|^|  $f:|" >&2
    done
    fail=1
  fi

  # 1.4 .gitignore coverage
  for required in '.env' '*.key' '*.pem' '*.db' '*.lock' 'node_modules' 'dist'; do
    if ! grep -qF "$required" .gitignore 2>/dev/null; then
      err "FAIL: .gitignore missing pattern: $required"
      fail=1
    fi
  done

  if [[ $fail -ne 0 ]]; then
    err ""
    err "Security scan FAILED. Fix the issues above OR re-run with --skip-scan AFTER explicit user override."
    err "See ~/.kiro/steering/pre-commit-security.md for the full rule."
    return 1
  fi
  ok "Security scan passed."
}

if [[ $SKIP_SCAN -eq 1 ]]; then
  err "WARNING: --skip-scan was passed. This bypasses the user-level Kiro security rule."
  err "         Continue ONLY if the user explicitly confirmed the override in writing."
  sleep 2
else
  run_security_scan || exit 1
fi

# ---- §2. Build verify ----
log "Build verify (typecheck + tests)"
if [[ -f package.json ]]; then
  npm run typecheck 2>&1 | tail -3
  npm test 2>&1 | tail -3
fi

# ---- §3. Shallow clone → fresh init ----
log "Preparing scratch dir: $SCRATCH_DIR"
trap 'rm -rf "$SCRATCH_DIR"' EXIT
git clone --depth 1 "file://$REPO_ROOT" "$SCRATCH_DIR" 2>&1 | tail -3

cd "$SCRATCH_DIR"
rm -rf .git
git init -b main 2>&1 | tail -1
git config user.name "$COMMIT_AUTHOR_NAME"
git config user.email "$COMMIT_AUTHOR_EMAIL"
git add .
git commit -m "$COMMIT_MESSAGE" 2>&1 | tail -3

git remote add origin "$GITHUB_REMOTE"

# ---- §4. Push (force — public mirror is single-commit history) ----
if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY RUN — would push to: $GITHUB_REMOTE"
  log "Files: $(git ls-files | wc -l | tr -d ' '), commit SHA: $(git rev-parse HEAD)"
  log "Skipping actual push. Inspect: cd $SCRATCH_DIR"
  trap - EXIT
  exit 0
fi

log "Pushing to $GITHUB_REMOTE (force)"
git push --force --set-upstream origin main 2>&1 | tail -3

ok "Published successfully."
ok "Public URL: $(echo "$GITHUB_REMOTE" | sed 's|git@github.com:|https://github.com/|; s|\.git$||')"
ok "Files: $(git ls-files | wc -l | tr -d ' ')"
ok "Commit: $(git rev-parse HEAD)"
