# Telecode

> 🌐 **English** (this file) · **[Tiếng Việt](README.vi.md)**

> Chat with Claude Code / Kiro / Codex / Cursor on your Mac / Linux / Windows machine through Telegram. Vibecode from anywhere.

Telecode is a local daemon that runs in the background on your machine, bridging Telegram and the coding-agent CLIs (**Claude Code**, **Kiro**, **Codex**, **Cursor**) you already have installed. You send a prompt from your phone → the agent runs on your machine → results stream back to Telegram. When the agent wants to run a dangerous command, you receive an inline approve/deny button right in the chat.

**Features**:
- 🧵 **Multiple parallel sessions**: e.g. "Claude #1 refactor module A" + "Codex write tests for module B" + "Cursor fix a bug in another project" — all running concurrently, no blocking.
- 🤖 **4 agent CLIs**, one UX: 🤖 Claude · ⚡ Kiro · 🅒 Codex · ✦ Cursor. Switch between agents in the same chat. **Open-set** adapter registry — adding a new agent (Gemini, Antigravity, …) takes one file plus one register line.
- 🛡 **Safe approvals**: policy engine + each CLI's native approval (`canUseTool` for Claude, `preToolUse` hook for Kiro, `approvalPolicy` for Codex, `session/request_permission` for Cursor). Safe tools auto-allow + notify; dangerous tools ask via Telegram inline buttons **[Allow once] [Allow always] [📌 Forever] [Deny]**. The `📌 Forever` button (2-step confirm) writes a permanent rule into `policy.yaml`.
- 📊 **Live dashboard**: `/dashboard` edits a single message every 2s with a snapshot of running sessions, pending approvals, buffer sizes.
- 💡 **Follow-up suggestions**: after each tool result, the bot offers next-action buttons (Continue / View file / Run again / Rollback) using simple heuristics.
- 👤 **Single user**: only your Telegram user_id can interact with the bot.
- 🔄 **Resumable sessions**: each session has its own UUID — context survives bot restarts.
- 🔐 **Secret-safe**: scrubs Telegram tokens, Anthropic keys, GitHub PATs, and Bearer headers from every log + outbound message. A per-boot HMAC token protects the Kiro hook server from same-user spoofing. A daemon singleton lockfile prevents races between dev / launchd / systemd / NSSM.
- 🌐 **Native cross-platform**: macOS (launchd), Linux (systemd `--user`), Windows 11 (NSSM service). No WSL needed.
- 🌍 **Bilingual UI** *(v1.2)*: English / Tiếng Việt picker on first boot; switch any time via `/language`. The agent's reply language follows your choice (LLM summarize prompts are locale-aware).

**Status**: **v1.2** — bilingual UI · streaming UX · 949 passing tests. Multi-version log:
- v0.4 — M0–M5 ship: core daemon + Claude adapter + multi-session + canUseTool.
- v0.5 — Kiro switched to `kiro-cli` headless (stream stdout, resume by UUID).
- v0.6 — Kiro mid-session approval via `preToolUse` hook bridge → same inline-button UX as Claude.
- v0.6.1 — P0 fix: scrub bot token from raw stderr (grammY runner error path).
- v0.7 — Telegram UX widgets: slash menu, persistent reply keyboard (6 buttons), Menu button, `/new` wizard, inline project picker, `/sessions` enhanced.
- v0.8 — Multi-session view discipline: only the active session streams live, background sessions buffer in RAM, auto-switch on approval, catch-up flush, session strip, silent stream.
- **v1.0** — Cross-platform + multi-agent: open-set adapter registry, Linux (systemd) + Windows (NSSM) installers, Codex + Cursor adapters, per-boot HMAC gate token, singleton daemon lockfile.
- **v1.1** — Streaming UX redesign: 4 verbosity modes (`/mode`, `/settings`), friendly tool rendering, MarkdownV2 auto code-fence, repeated tool collapse, agentic compression (auto-summarize long output), rolling progress message, idle ping ladder.
- **v1.2** — Bilingual UI (EN / VI) with locale-aware LLM prompts; first-boot language picker; `/language` command; chat-settings table extended with `language` column.

---

## Table of Contents

- [Requirements](#requirements)
- [Step-by-step install](#step-by-step-install)
  - [1. Clone the repo](#1-clone-the-repo)
  - [2. Create your own Telegram bot](#2-create-your-own-telegram-bot)
  - [3. Get your Telegram user_id](#3-get-your-telegram-user_id)
  - [4. Run the installer](#4-run-the-installer)
  - [5. Verify the daemon is running](#5-verify-the-daemon-is-running)
- [First smoke test](#first-smoke-test)
- [Daily workflow](#daily-workflow)
- [Multi-session UX](#multi-session-ux)
- [Live dashboard](#live-dashboard)
- [Verbosity modes (v1.1)](#verbosity-modes-v11)
- [Agentic compression (v1.1)](#agentic-compression-v11)
- [Smart rendering (v1.1)](#smart-rendering-v11)
- [Language settings (v1.2)](#language-settings-v12)
- [Full command reference](#full-command-reference)
- [Policy & Approval](#policy--approval)
- [Adapter registry — adding a new agent](#adapter-registry--adding-a-new-agent)
- [Logs & debugging](#logs--debugging)
- [Troubleshooting](#troubleshooting)
- [Updating Telecode](#updating-telecode)
- [Uninstall](#uninstall)
- [Architecture & docs](#architecture--docs)
- [Known limitations](#known-limitations)


---

## Requirements

| Item | Minimum | Verify |
| --- | --- | --- |
| OS | macOS 13+ **or** Linux (Ubuntu 24.04+ / Fedora 39+ / RHEL 9+, glibc 2.34+) **or** Windows 11 | `uname -s` / `sw_vers -productVersion` / `ldd --version` / `winver` |
| Node.js | **22 LTS** | `node -v` |
| npm | bundled with Node 22 | `npm -v` |
| `claude` CLI | 2.1+ | `which claude && claude --version` |
| `kiro-cli` (optional) | 2.3+ | `which kiro-cli && kiro-cli --version` |
| `codex` CLI (optional) | rust-v0.75+ | `which codex && codex --version` |
| `cursor-agent` CLI (optional) | latest | `which cursor-agent && cursor-agent --version` |
| Telegram account | any | — |
| systemd (Linux only) | shipped with every modern distro | `systemctl --user --version` |
| NSSM (Windows only) | 2.24 | `nssm --version` |

> **Minimum**: you need Claude Code CLI **OR** Kiro CLI **OR** Codex CLI **OR** Cursor CLI. The more you install, the more agents show up in the `/new` wizard.

**Install Node 22** if you don't have it yet:
```bash
brew install node@22
brew link --overwrite node@22
```

**Install Claude Code CLI**:
```bash
# Official guide: https://docs.claude.com/en/docs/claude-code/setup
curl -fsSL https://claude.ai/install.sh | sh
```

**Install Kiro CLI** (optional): note that `kiro-cli` (the headless CLI) is different from `kiro` (the IDE launcher).
```bash
# Official guide: https://kiro.dev/docs/cli/installation
# macOS / Linux:
curl -fsSL https://cli.kiro.dev/install | bash
# Windows (PowerShell):
#   irm 'https://cli.kiro.dev/install.ps1' | iex
kiro-cli --version    # must print 2.3+
```

> **Note**: `kiro` (IDE launcher) and `kiro-cli` (headless CLI) are two different binaries. `kiro` only opens an IDE window; `kiro-cli` is the one that streams stdout headlessly — Telecode uses `kiro-cli`.

**Install Codex CLI** (optional, OpenAI Codex):
```bash
# Official guide: https://github.com/openai/codex
# Then: codex login   ← Telecode does NOT handle auth, you log in yourself first
codex --version
```

**Install Cursor CLI** (optional, Cursor agent):
```bash
# Official guide: https://cursor.com/docs/cli
# Then: cursor-agent login   ← Telecode does NOT handle auth, you log in yourself first
cursor-agent --version
```

> **Auth philosophy**: Telecode is a **bridge** — it does not store the API
> key of any CLI. You log each CLI in with its own native command (`codex
> login`, `cursor-agent login`, etc.) before starting the daemon. The daemon
> spawns the binary and streams output; it never touches credentials.

You can run Telecode without any of the optional CLIs — adapters with a missing binary are simply skipped, and you use whichever ones are available. As a minimum you need either Claude Code CLI or Kiro CLI so at least one adapter works.

---

## Step-by-step install

### 1. Clone the repo

```bash
git clone https://github.com/dangkhoi/telecode.git ~/Documents/workspaces/telecode
cd ~/Documents/workspaces/telecode
```

> You can clone anywhere. If you put it under `~/Documents/workspaces/`, Telecode auto-scans sibling projects under that root.

### 2. Create your own Telegram bot

Each user gets their own bot (the bot is the gateway to your machine — it cannot be shared).

1. Open Telegram, search for **@BotFather** (the verified blue-tick account).
2. Send `/newbot`.
3. BotFather asks for a **display name** → anything goes, e.g. `Telecode (you)`.
4. BotFather asks for a **username** (must end with `bot`) → e.g. `your_telecode_bot`. If taken, try another.
5. BotFather replies with a token like `123456789:ABCdefGHI…` (~46 characters). **Copy this token.**
6. (Optional) `/setprivacy` → pick your bot → **Disable** (lets the bot read messages in groups later if needed; doesn't matter for 1-on-1 DMs).

### 3. Get your Telegram user_id

Telecode only accepts messages from user_ids on its whitelist. To find yours:

1. In Telegram, search for **@userinfobot** (run by the Telegram team).
2. Tap **Start**. The bot replies with something like:
   ```
   👤 You
   ├ id: 123456789
   ├ is_bot: false
   ├ first_name: ...
   └ username: ...
   ```
3. **Copy the `id`** (a numeric string). That's your Telegram user_id.

### 4. Run the installer

Telecode ships three installers — pick by OS:

#### macOS — launchd

```bash
cd ~/Documents/workspaces/telecode
./scripts/install-launchd.sh
```

The installer will:
1. Verify Node 22+.
2. Create `~/.telecode/` (chmod 700) if missing.
3. Copy `config.example.yaml` → `~/.telecode/config.yaml` (if missing).
4. Copy `policy.example.yaml` → `~/.telecode/policy.yaml` (if missing).
5. Show a BotFather wizard if `~/.telecode/.env` is empty — paste the token from step 2.
6. Run `npm install && npm run build`.
7. Generate `~/Library/LaunchAgents/dev.telecode.daemon.plist`.
8. `launchctl load` + start.

#### Linux — systemd (`--user` unit)

```bash
cd ~/workspaces/telecode
./scripts/install-systemd.sh
```

The installer will:
1. Verify Node 22+ (via `command -v node`, falling back to `~/.nvm/versions/node/...`).
2. Create `~/.telecode/` (chmod 700) if missing.
3. Ask for 3 inputs (skippable via env vars, useful for automation):
   - **Telegram bot token** (`TELECODE_BOT_TOKEN`) — from @BotFather (step 2).
   - **Allowed chat IDs** (`TELECODE_ALLOWED_CHAT_IDS`) — comma-separated, from @userinfobot (step 3).
   - **Kiro CLI path** (`TELECODE_KIRO_BINARY`) — optional, absolute path to `kiro-cli`.
4. Atomic-write `~/.telecode/config.yaml` (chmod 600) + `~/.telecode/.env` (chmod 600).
5. `npm install && npm run build` if `dist/` is missing.
6. Generate `~/.config/systemd/user/telecode.service` (atomic write, mode 0644).
7. `systemctl --user daemon-reload && systemctl --user enable --now telecode.service`.
8. Verify via `systemctl --user status telecode.service` + tail 20 lines of journal.

> **Tip — keep running after logout**: on a server / WSL, the default systemd `--user` instance stops when you log out. Enable user lingering so the daemon runs 24/7:
> ```bash
> sudo loginctl enable-linger $USER
> ```
> The installer prints this hint if it isn't already enabled.

**Verify install OK**:
```bash
systemctl --user status telecode.service
journalctl --user -u telecode.service -n 20
```

**Dry-run / preview** before running for real (prints the unit file + commands without executing):
```bash
./scripts/install-systemd.sh --dry-run
```

**Tested distros** (via dry-run unit-file generation; full E2E smoke comes in a later phase):
- Ubuntu 24.04 LTS
- Fedora 41
- Debian 13 (Trixie)
- RHEL 9 / Rocky 9 (glibc 2.34)

#### Windows 11 — NSSM service

**Pre-requisites** (install once, reusable for every Telecode version afterwards):

```powershell
winget install OpenJS.NodeJS.LTS    # Node 22+
winget install NSSM.NSSM            # service manager (https://nssm.cc)
winget install Git.Git              # if you don't have it yet
# Optional adapters (as needed):
irm 'https://cli.kiro.dev/install.ps1' | iex   # Kiro CLI
# Codex CLI: per OpenAI installer
# Cursor CLI: per Cursor docs
```

> NSSM (the Non-Sucking Service Manager) is a popular Windows-service
> wrapper, BSD-licensed, ~330 KB. Telecode does NOT bundle the binary —
> the installer fails fast with a winget hint if it's missing.

**Install**:

```powershell
cd C:\Users\<you>\workspaces\telecode    # (clone first if needed)
git clone https://github.com/dangkhoi/telecode.git
cd telecode
.\scripts\install-windows.ps1
```

The installer will:
1. Verify NSSM + Node 22+ (via `Get-Command`, falling back to `%ProgramFiles%\nodejs` + `%APPDATA%\nvm\v...`).
2. Create `%USERPROFILE%\.telecode\` + a `logs` subdir.
3. Ask for 3 inputs (skippable via env vars):
   - **Telegram bot token** (`$env:TELECODE_BOT_TOKEN`)
   - **Allowed chat IDs** (`$env:TELECODE_ALLOWED_CHAT_IDS`)
   - **Kiro CLI path** (`$env:TELECODE_KIRO_BINARY`) — optional.
4. Atomic-write `config.yaml` + `.env` with **owner-only ACL** (Windows equivalent of `chmod 600` — strip inheritance, single explicit ACE for the current user).
5. `npm install && npm run build` if `dist\` is missing.
6. NSSM service install: `nssm install Telecode <node.exe> --enable-source-maps <dist\index.js>` + AppDirectory + AppEnvironmentExtra (TELECODE_HOME, NODE_ENV, **USERPROFILE/HOMEDRIVE/HOMEPATH** of the installing user — so `~`-expansion still points home when the service runs as LocalSystem, plus PATH) + AppRestartDelay 5000 + AppExit Default Restart + AppStopMethodConsole 15000 + AppStdout/AppStderr → `%USERPROFILE%\.telecode\logs\` + AppRotateFiles + AppRotateBytes (10 MiB) + Start `SERVICE_AUTO_START`.
7. `nssm start Telecode` + verify `Get-Service Telecode` status = `Running` (retry 6×1s for SCM transition lag).

**Verify install OK**:
```powershell
Get-Service Telecode
Get-Content $env:USERPROFILE\.telecode\logs\stdout.log -Tail 30 -Wait
```

**Dry-run / preview** before running for real:
```powershell
.\scripts\install-windows.ps1 -DryRun
```

**Lightweight fallback (no NSSM)**: if you don't want to install NSSM, you
can register a Task Scheduler entry with an `OnLogon` trigger that runs
`node.exe C:\...\dist\index.js`. You lose crash-restart semantics (NSSM
restarts the process 5s after exit), but you have zero dependencies. This
option is intentionally not implemented — roll your own if needed.

**PowerShell compatibility**: the script runs on both Windows PowerShell
5.1 (default on Windows 10/11) and PowerShell 7+ (via winget). Static
tests (`tests/install-windows.test.ts`) block 7+-only operators (`??`,
ternary) so we don't accidentally raise the minimum runtime.

**After the installer finishes**, edit `~/.telecode/config.yaml`:

```bash
# Open in your favourite editor
code ~/.telecode/config.yaml
# or
nano ~/.telecode/config.yaml
```

Edit the key sections:

```yaml
telegram:
  allowed_user_ids: [123456789]    # ← replace with YOUR user_id (from step 3)

daemon:
  workspace_scan:
    roots: [~/Documents/workspaces]  # ← path to your project root

agents:
  claude:
    binary: claude
    setting_sources: [user, project, local]
  kiro:
    binary: kiro-cli                 # ← bare name (resolved via PATH) or absolute path
  codex:                             # ← optional, requires `codex login` first
    command: codex
    model: o3
  cursor:                            # ← optional, requires `cursor-agent login` first
    command: cursor-agent
    model: auto
```

> **Only agents listed under `agents:` appear in the `/new` wizard.** Remove or comment out any agent you don't use. The minimum is one agent (Claude or Kiro).

Reload the daemon to pick up the new config:

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist

# Linux
systemctl --user restart telecode.service
```

```powershell
# Windows
nssm restart Telecode
```

### 5. Verify the daemon is running

**macOS**:
```bash
# Check the process is up
launchctl list | grep telecode

# Tail logs in real time
tail -f ~/.telecode/logs/telecode.log
```

**Linux**:
```bash
# Service status
systemctl --user status telecode.service

# Tail logs (journald)
journalctl --user -u telecode.service -f

# Telecode's own log file (same content, pino format)
tail -f ~/.telecode/logs/telecode.log
```

**Windows**:
```powershell
# Service status
Get-Service Telecode

# Tail logs (NSSM redirects stdout/stderr)
Get-Content $env:USERPROFILE\.telecode\logs\stdout.log -Tail 30 -Wait
Get-Content $env:USERPROFILE\.telecode\logs\stderr.log -Tail 30 -Wait
```

You should see logs like:
```
{"level":"info","msg":"telecode starting","version":"1.2.0"}
{"level":"info","msg":"lockfile acquired","pid":12345,"path":"~/.telecode/daemon.lock"}
{"level":"info","msg":"adapter registry initialized","kinds":["claude","kiro","codex","cursor"]}
{"level":"info","msg":"workspace scan complete","projects":12}
{"level":"info","msg":"telegram bot connected","username":"your_telecode_bot"}
```

If not → see [Troubleshooting](#troubleshooting).


---

## First smoke test

1. In Telegram, search for your bot by username (e.g. `@your_telecode_bot`) and tap **Start**.
2. **First-boot language picker (v1.2)**: the bot replies with a language picker `[🇬🇧 English] [🇻🇳 Tiếng Việt]`. Pick one. The bot then sends the welcome + the v1.1 verbosity migration note in your chosen language. You can switch later via `/language`.
3. After picking a language, send `/start`. The bot replies with the welcome + the **persistent reply keyboard** (6 buttons below the input box: 📋 Sessions, 📁 Projects, 📊 Status, 🛑 Stop, 📸 Screen, ❓ Help). Next to the paperclip icon there's also a **Menu** button — tap it to see all 8 slash commands. Typing `/` shows the same menu.
4. Send `/projects` (or tap 📁 Projects). The bot lists every project it scanned under `~/Documents/workspaces/`, one inline button per project labelled with the **project name**; tapping sets that project active. The currently active project is prefixed with `●` (e.g. `● telecode`). Pagination kicks in automatically when there are more than 8.
5. Create a session with the **wizard** — type `/new`. The bot walks you through 3 inline steps:
   1. Pick an agent → keyboard rendered dynamically from the adapter registry. Default: `[🤖 Claude] [⚡ Kiro] [🅒 Codex] [✦ Cursor] [✖ Cancel]` (only adapters configured in `~/.telecode/config.yaml` show up).
   2. Pick a project → inline list (paginated 8/page when there are many).
   3. Type a label → validated by `/^[a-zA-Z0-9_-]{1,40}$/`.

   The bot replies: `📍 [smoke] — agent=claude` plus two inline buttons `[🔀 Switch other] [📋 Tail logs]`. The legacy syntax still works: `/session new claude smoke ~/Documents/workspaces/telecode`.
6. Send a regular prompt:
   ```
   list 3 files in src
   ```
   After a few seconds the bot replies with `[smoke] 🔧 Read src/index.ts ...` and streams output.
7. Test approval: send:
   ```
   run `git status` to see the repo state
   ```
   The bot will show inline buttons `[Allow once] [Allow always] [Deny]` (because `Bash(git status)` is on the allow list it will auto-pass; try a different command like `npm outdated` to see the prompt).

If you got this far smoothly → setup OK ✓.

---

## Daily workflow

### Create a new session

The fast way — type `/new` (or tap `[➕ New session]` at the bottom of `/sessions`). The bot guides you through 3 inline steps:

1. Pick an agent — keyboard rendered dynamically from configured adapters: `[🤖 Claude] [⚡ Kiro] [🅒 Codex] [✦ Cursor] [✖ Cancel]`. Adapters not configured in `~/.telecode/config.yaml` don't appear in the picker.
2. Pick a project: inline list (paginated when >8); also has `[← Back] [✖ Cancel]`.
3. Type a label: `/^[a-zA-Z0-9_-]{1,40}$/` — the bot rejects + asks again if the format is wrong.

After the wizard finishes, the bot sends a success message with two inline buttons:
- **🔀 Switch other** — renders the `/sessions` list to switch to an existing session.
- **📋 Tail logs** — shows the last 30 tool logs of the just-created session.

Want a session for a specific project? Use the `/new` wizard and pick the project at step 2 — that's the single source of truth for session creation.

The legacy syntax is still supported — faster if you remember the path:

```
/session new claude refactor-auth ~/work/api
/session new claude debug ~/work/api          # same project, different session
/session new kiro mobile-ui ~/work/mobile
/session new codex tests ~/work/api
/session new cursor docs ~/work/api
```

### List + switch quickly

```
/sessions
```

The bot replies in the new format — active session prefix `●`, agent badge 🤖 (Claude) / ⚡ (Kiro) / 🅒 (Codex) / ✦ (Cursor), last activity:

```
📋 Sessions (4):
● refactor-auth · 🤖 · 2m ago
  debug-api     · 🤖 · 1h ago
  mobile-ui     · ⚡ · 3h ago
  ts-tests      · 🅒 · 30m ago
```

One inline button per session — tap to switch (no need to type the name). The bottom row always has `[➕ New session]` to open the wizard.

The legacy `/session list` (with the older `sessionPickKeyboard`) still works. Switch by label:

```
/session switch refactor-auth
```

The bot replies with `📍 [refactor-auth]` plus the last 3 lines of context as a memory aid.

### Plain text → active session

After switching, send a regular message:
```
keep refactoring the userService module — split the auth logic into its own file
```

The bot prefixes every reply with `[refactor-auth]` so you know which session you're chatting with.

### Approval flow

When the agent wants to run a tool outside the policy (e.g. `gh pr create`, `npm install <new-pkg>`):

```
🛡 Approval needed
Session: refactor-auth
Tool: Bash
Input: gh pr create --title "..."

[✅ Once] [🔁 Always]
[📌 Forever] [🚫 Deny]
```

- **✅ Once**: allow this one call.
- **🔁 Always**: allow within the **current session** (lost on daemon restart).
- **📌 Forever** *(v1.0)*: **2-step confirm** — tap 1 → the message edits to `⚠️ Persist this permission? Tool: <tool> Args: <...>. Rule will apply to every future session.` plus `[✅ Confirm] [❌ Cancel]`. Tap `Confirm` → atomic write of the rule into `~/.telecode/policy.yaml` (`tmp + rename`) → auto-allow both the current session and every session after restart.
- **🚫 Deny**: reject + the agent gets the error back.

If you don't tap within 5 minutes → auto-deny + Telegram pings `⏱ timeout, denied`.

After every tool result, the bot appends **follow-up suggestion buttons** (heuristic, no extra LLM calls):
- `fs_write` success → `[👁 View file] [▶ Continue] [↺ Rollback]`
- `execute_bash` exit 0 → `[▶ Continue] [🔁 Run again]`
- default → `[▶ Continue]`

### Manage policy

```
/allow Bash(gh pr*)             # append allow pattern
/allow Edit(/Users/khoa/work/api/**)
/deny Bash(rm -rf /work/**)     # append deny
```

Or edit `~/.telecode/policy.yaml` directly with any editor — the daemon auto-reloads via `fs.watchFile`.

### Tail logs while a task runs long

```
/status logs 30
```

Shows the last 30 tool calls of the active session. Useful when a prompt is long and you want to see where the agent is.

### Stop & reset

```
/stop                  # interrupt the running task (AbortController)
/session reset         # keep the label but wipe the resume id → fresh context
/session close debug   # close the "debug" session for good
```

---

## Multi-session UX

When you run several sessions in parallel, Telecode keeps the Telegram chat focused on **exactly one active session** instead of spamming interleaved output. The mechanism:

### Per-session view
- The **active** session → output (text + tool_use) streams directly to Telegram, prefixed with `[label]`.
- A **background** session → output goes into a per-session RAM buffer (default cap 50 KB, drop-oldest when full).
- Two sessions never spam the chat — you only see the one you're watching.

### Auto-switch on approval
When a background session needs approval:
1. The bot **auto-switches active to that session** (first-come-first-active, no thrashing — if you're approving another session it queues).
2. Sends the `🛡 Approval needed` prompt as usual.
3. **Flushes the catch-up buffer** of the just-switched session right after the prompt (see below).

Example: you're watching `refactor-auth` and the `mobile-ui` session needs `Bash(pod install)` → the bot pings `🔔 switched → [mobile-ui]` + the approval card + the `mobile-ui` catch-up dump.

### Catch-up on switch
On every switch (manual via `/sessions` tap, or auto via approval), the bot sends one **silent** message (`disable_notification: true`):

```
📥 catch-up (12 events from background)
[mobile-ui] 🔧 Read Podfile
[mobile-ui] ... pod install --repo-update ...
```

Auto-splits when it exceeds 3400 chars per message (Telegram's per-message limit is 4096, minus overhead). After flushing, that session's buffer is cleared.

### Session strip
Every approval / critical message comes with one trailing inline-button row:

```
[refactor-auth] [● mobile-ui] [debug-api] [+ New]
```

The `●` marker = active. Tap a different session = switch + trigger catch-up (as above). `[+ New]` opens the `/new` wizard.

### Silent stream
- Text + tool_use chunks are sent with `disable_notification: true` — no sound, no vibration. Scroll up when you want to read them.
- **Approval**, **done**, and **error** events still notify normally (sound + badge).
- Catch-up flushes are also silent.

### Tuning
Edit `~/.telecode/config.yaml` — add a `notifier:` section (defaults are used if missing):

```yaml
notifier:
  debounce_ms: 3000        # stream chunks are batched for N ms before flushing to Telegram
  buffer_cap_bytes: 50000  # RAM cap per background session (drop-oldest when full)
```

Increase `debounce_ms` if the bot feels too chatty; increase `buffer_cap_bytes` if a background task is long and you want a complete catch-up.


---

## Live dashboard

Type `/dashboard` → the bot sends one message and `editMessageText`'s it every **2s** with a snapshot of the daemon state:

```
📊 Telecode dashboard (auto-refresh 2s)

Sessions (3 active):
● refactor-auth · 🤖 · busy · 12.4 KB buffered
  debug-api     · 🤖 · idle ·  0.0 KB
  ts-tests      · 🅒 · busy ·  5.1 KB buffered

Approvals: 1 pending (mobile-ui: shell)
Wizard: idle

Last update: 14:23:05
```

**Stop conditions** (the loop stops by itself):
- Type `/dashboard stop`.
- The message is deleted (Telegram returns 400 `message_to_edit_not_found`).
- 5 minutes idle (no user input).

Telegram's edit limit is ~30/min; 2s sits right at the threshold so the bot uses a throttler. On 429 it skips the update and retries on the next tick.

---

## Verbosity modes (v1.1)

Telecode v1.0 streamed EVERY event to Telegram (firehose) → hard to read on a phone. v1.1 adds 4 modes to control verbosity. **Default = `summary`** for new users.

| Mode | Icon | Shows |
| --- | --- | --- |
| `summary` | 🎯 | Approval + done (+ AI summary) + errors only |
| `normal` | 📝 | + compact tool calls + compact tool results |
| `thinking` | 🧠 | + Claude thinking blocks + Cursor thought chunks (prefixed 🧠) |
| `verbose` | 🔬 | + raw text chunks + status events + full preview (= v1.0 firehose, byte-identical) |

**Commands**:
- `/mode` — show the current effective mode + a 4-button picker to switch (per active session).
- `/mode <name>` — set per-session, e.g. `/mode normal`.
- `/settings mode <name>` — set the chat default (applied to new sessions).

Resolution order: session mode → chat default → `summary`. Edits take effect immediately but are NOT retroactive (already-rendered events keep their format).

**Migration v1.0 → v1.1**: on first v1.1 boot, telecode sends one announcement explaining the new default + how to get the old behaviour back via `/mode verbose`. Backward compat 100% — `verbose` mode reproduces v1.0 byte-identical.

---

## Agentic compression (v1.1)

Instead of rule-based truncation ("200 lines → cut to 240 chars"), Telecode reuses the running session to **AI-summarize**. Cost comes out of the session's own agent budget — no separate API key needed.

### Auto-summarize long tool_result (>500 chars)

A bash command with long output → 2-phase render:

```
[refactor-auth] 🔧 Bash · npm test
    ⏳ Summarizing 1.2KB output...   ← silent placeholder

(after 2-3s)

[refactor-auth] 🔧 Bash · npm test ✅ (3.5s)
    Ran 432 tests, 2 skipped, all pass.
    [📜 Full output (200 lines)] [💬 Re-summarize]
```

Tap `[📜 Full output]` → the bot sends the original full content (split if >3500 chars, wrapped in a MarkdownV2 ```bash fence).

### On-demand `[💬 AI summary]` button

Every tool_result with a cached full preview gets a `[💬 AI summary]` button. Tap → re-runs summarize → edits the message with the new summary.

### Auto done-summary

When a task finishes (`done` event) in `summary` or `normal` mode:
```
[refactor-auth] ✅ Done · 47s · $0.0231
Split validateToken into a separate file, added 5 unit tests, all pass.
```
The bot injects "summarize what was just done in 1-2 sentences" into the session → reply summary. `verbose` mode skips this — still shows `✅ done · $0.0231` plain like v1.0.

### Cost transparency

Every summarize call logs structured pino: `{ sessionId, kind: 'auto-tool-result'|'on-demand'|'auto-done', elapsedMs, inputChars, outputChars }`. Audit via `tail -f ~/.telecode/logs/telecode.log | grep summarize` or `journalctl --user -u telecode | grep summarize` (Linux).

Conservative defaults (500-char threshold, per-session mutex against burst spam, verbose-mode opt-out) keep the cost story honest.

---

## Smart rendering (v1.1)

### Friendly tool rendering

Path collapse + basename rendering instead of raw JSON params:

| Tool | v1.1 format |
| --- | --- |
| Read | `🔧 Read · notifier.ts` |
| Edit | `📝 Edit · auth.ts (-3 +7)` (diff stats) |
| Bash | `🔧 Bash · npm test` (command first 80 chars) |
| Grep | `🔍 Grep "AgentEvent" in src/` |
| Write | `🔧 Write · output.ts (1.2 KB)` |

Path: absolute → `~/` (home) or `./` (project cwd) or git-root-relative for monorepo siblings or `...auth/validate.ts` (deeply nested).

### Repeated tool collapse (5s window)

Three reads in a row → 1 message edit instead of 3 sends:
```
🔧 Read ×3 · notifier.ts, types.ts, reply-builders.ts ✅
```

### MarkdownV2 auto code-fence

The bot detects + wraps content in text events:
- JSON-like (`{...":...}`) → ```json
- Diff hunks (`+`/`-` lines + `@@`) → ```diff
- Bash output (`$ ` / `> ` prompts) → ```bash
- Stack traces (`at Function ...`) → ``` (plain monospace)

Falls back to plain text if Telegram fails to parse it (400 bad markdown).

---

## Language settings (v1.2)

Telecode v1.2 adds a per-chat language switch:

- **First boot**: when you tap `/start` for the first time, the bot replies with a language picker `[🇬🇧 English] [🇻🇳 Tiếng Việt]`. The pick is persisted in `chat_settings.language` and the welcome + the verbosity migration note are sent in the chosen language.
- **Switch later**: type `/language` → the bot shows the current language plus the same bilingual picker. Tap to flip.
- **What it affects**: every command reply, wizard step, approval flow text, dashboard, and **the LLM summarize-prompt language** (so the agent's auto-summary lands in your chosen language too).
- **Existing users**: chats that already had a row in `chat_settings` before v1.2 are auto-backfilled to `'vi'` on first daemon boot — your existing UX stays Vietnamese until you change it.

The catalog source-of-truth is `src/i18n/messages/en.ts`; `src/i18n/messages/vi.ts` must implement the same keys (compile-time gated). Adding a new locale: drop a file under `src/i18n/messages/`, extend the `Language` union in `src/i18n/index.ts`.

---

## Activity indicators (v1.1)

In `summary` / `normal` / `thinking` mode, the bot maintains **one edit-only progress message per session** showing the current activity:

```
⏳ [refactor-auth] Starting Claude...
        ↓ (after first tool_use)
⏳ [refactor-auth] Running Read...
        ↓ (after tool_result)
⏳ [refactor-auth] Generating response...
        ↓ (done event)
✅ Done · 47s · $0.0231
{auto-summary}
```

**Idle ping ladder** (summary mode only): 30s → 1m → 2m → 3m → 4m → 5m+ cap. The message updates `⏳ Working... (1m)` so the user knows the bot is still alive, not hung.

`verbose` mode SKIPs the progress message entirely (preserves the raw firehose UX for debugging).


---

## Full command reference

Typing `/` in the Telegram chat shows the top-level commands (same list as the **Menu** button next to the paperclip). Every approval / critical message also carries a **session strip** of inline buttons `[session1] [● active] [session2] [+ New]` so you can tap-switch without typing a command.

| Command | Description |
| --- | --- |
| **Top-level (slash menu)** | |
| `/start` | Welcome + active session info + re-issues the persistent reply keyboard. |
| `/new` | Wizard to create a session (agent → project → label). |
| `/sessions` | Enhanced list — active marker `●`, agent badge 🤖/⚡, last activity. Each row has 3 buttons: `[label]` (switch) + `[🤝]` (handoff) + `[🗑]` (close). |
| `/projects` | Inline picker, one button per project labelled with the project name, active prefix `●`. Pagination >8. |
| `/status` | Active session, agent, project, last 5 tool calls. |
| `/clear` | Clear the active session's context (wipe sdk_session_id + transcript). The label stays — typing the next prompt is a fresh start. |
| `/handoff` | Agent self-summarizes context (5–15 lines) → wipes context → injects the summary as a preamble for the next prompt (1-shot). Use when the context window is full but you want to keep the task. |
| `/stop` | Interrupt the running task. |
| `/screenshot` | Capture the desktop and send it back (macOS needs Screen Recording permission; Linux needs `grim`/`gnome-screenshot`/`scrot`; Windows uses native PowerShell). |
| `/dashboard` | *(v1.0)* Live edit-loop dashboard, 2s refresh. `/dashboard stop` to close. |
| `/mode` | *(v1.1)* Show current verbosity mode + 4-button picker. `/mode <name>` sets per-session: `summary` (default) / `normal` / `thinking` / `verbose`. |
| `/settings` | *(v1.1)* Show chat-level settings. `/settings mode <name>` sets the chat default mode (applies to new sessions). |
| `/language` | *(v1.2)* Show current language + EN/VI picker. Affects all bot messages and the LLM summarize-prompt language. |
| `/help` | Quick guide — lists the 6 keyboard buttons + slash commands. |
| **Session (legacy `/session ...` — still works)** | |
| `/session new <agent> <label> [path]` | `claude` / `kiro` / `codex` / `cursor`. Default path = active project. |
| `/session list` | List sessions + inline keyboard switch (older compact format). |
| `/session switch <label>` | Change the active session + show the last 3 lines of context. |
| `/session rename <new-label>` | Rename the active session. |
| `/session close [label]` | Close a session (default = active). Or tap `[🗑]` in `/sessions`. |
| `/session clear` | Clear context (alias of top-level `/clear`). `/session reset` is a legacy alias. |
| **Project** | |
| `/add <path> [name]` | Register a path as a project. |
| `/cd <name\|path>` | Change project for the active session. |
| **Policy & misc** | |
| `/status logs [n]` | Tail n tool calls (default 20). |
| `/allow <pattern>` | Append a pattern to policy allow. |
| `/deny <pattern>` | Append a pattern to policy deny. |
| `<plain text>` | Dispatch to the active session. |

### Session lifecycle — clear / handoff / close

Three AI-agentic actions to manage the context window when working in one session for a long time:

| Command | When to use | Effect |
|---|---|---|
| **`/clear`** | The old context isn't relevant anymore, you want a fresh start but keep the session + label | Wipes `sdk_session_id` + `transcript_tail`. The next prompt = brand-new session (claude mints a fresh resume id). |
| **`/handoff`** or `[🤝]` button | The context window is filling up but you want to keep the task — need a summary + continue | (1) The agent self-summarizes 5–15 lines (2) Save the summary in DB (3) Wipe context (4) The NEXT prompt auto-injects the summary as a preamble — 1-shot, doesn't repeat. The `[🤝]` button in `/sessions` lets you handoff any session (including background — no need to switch first). |
| **`/session close`** or `[🗑]` button | Done with this session, don't need it anymore | Interrupt running task + mark closed + discard buffer. Hidden from `/sessions` (still in DB with `status='closed'`). |

**`/handoff` flow in detail**:
```
You> /handoff
Bot> 🤝 [refactor-auth] requesting handoff summary from the agent…
Agent> "We're refactoring src/auth.ts. Done: extracted validateToken into
        a separate file. Next: write unit tests for the new validator..."
Bot> [refactor-auth] 🤝 handoff complete — 387 chars saved.
     Context window cleared. Send the next prompt; the summary will be injected as a preamble (1-shot).

You> keep writing the unit tests
Bot> 📥 [refactor-auth] injecting handoff context (387 chars) into prompt — runs only once.
     [refactor-auth] dispatching…
Agent> [resumes with summary + new prompt, in a fresh context window]
```

### Reply keyboard (6 persistent buttons)

After `/start`, Telegram shows 6 fixed buttons below the input box (Telegram Desktop ≥ 4.6 keeps the keyboard persistent; older clients degrade to non-persistent but still work):

```
[📋 Sessions] [📁 Projects]
[📊 Status]   [🛑 Stop]
[📸 Screen]   [❓ Help]
```

Each button = tap to send the matching command (`/sessions`, `/projects`, `/status`, `/stop`, `/screenshot`, `/help`). The keyboard auto-hides while a wizard is running so you don't tap the wrong thing; finishing the wizard restores it.

### Wizard `/new`

Multi-step inline; each step has Cancel / Back buttons; callback data is namespaced `wizard:new-*`:

| Step | UI | Validate |
| --- | --- | --- |
| 1. Agent | Keyboard rendered **dynamically** from the adapter registry — only adapters with config in `~/.telecode/config.yaml` show up. Full set: `[🤖 Claude] [⚡ Kiro] [🅒 Codex] [✦ Cursor]` + `[✖ Cancel]`. | — |
| 2. Project | One button per project, `[← Prev] [page x/y] [Next →]` when >8, `[← Back] [✖ Cancel]` | The project must exist + still be registered. |
| 3. Label | Plain text reply | `/^[a-zA-Z0-9_-]{1,40}$/`. Reject + ask again if invalid. |

Conversation state is persisted in SQLite (`conversations` table) — restarting the daemon mid-wizard preserves the step.

**Wizard-aware auto-switch** *(v1.0)*: while a wizard is running, ApprovalBroker defers auto-switches (queues them) until the wizard exits. This prevents the wizard's text input from being hijacked by an auto-switch mid-flow.

---

## Policy & Approval

`policy.yaml` has two lists: `allow` (auto-pass) and `deny` (auto-reject). Tools that match neither → asked via Telegram.

```yaml
allow:
  - Read
  - Grep
  - Glob
  - "Edit({{project_dir}}/**)"        # restrict to active project
  - "Bash(npm test*)"
  - "Bash(npm run *)"
  - "Bash(git status*)"
  - "Bash(git diff*)"
deny:
  - "Bash(rm -rf*)"
  - "Bash(git push --force*)"
  - "Bash(curl * | sh*)"
  - "Edit(~/.ssh/**)"                 # ~/ auto-expands to $HOME
  - "Edit(~/.aws/**)"
```

Patterns use a simple glob:
- `*` = any character (including space, slash)
- `{{project_dir}}` = path of the active project (resolved at runtime)
- `~/` = home directory (resolved at compile time)

**Best practice**: deny broadly (e.g. `Bash(rm*)`), allow narrowly (e.g. `Bash(npm test*)` not `Bash(npm*)`).

### One policy engine for all 4 agents

The policy engine is shared. The differences are tool-name format + how the approval is routed:

| Agent | Tool name | Input shape | Approval mechanism |
| --- | --- | --- | --- |
| Claude | `Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob` | `{ command }`, `{ file_path }` | SDK `canUseTool` callback in-process |
| Kiro | `shell`, `write`, `read`, `fs_read`, `fs_write` | `{ command }`, `{ path }` | `preToolUse` hook (HTTP bridge with HMAC Bearer token) |
| Codex | `execute_bash`, `read`, `write`, `apply_patch` | `{ command }`, `{ path }` | JSON-RPC `turn/permissionRequest` (native) |
| Cursor | `readToolCall`, `writeToolCall`, `bashToolCall`, … | tool-specific args | ACP `session/request_permission` (native) |

Each pattern must use the right tool name for its agent:

```yaml
allow:
  # Claude
  - Read
  - "Bash(npm test*)"
  - "Edit({{project_dir}}/**)"
  # Kiro
  - read
  - "shell(npm test*)"
  - "write({{project_dir}}/**)"
  # Codex
  - "execute_bash(npm test*)"
  - "write({{project_dir}}/**)"
  # Cursor
  - readToolCall
  - "bashToolCall(npm test*)"
deny:
  - "Bash(rm -rf*)"
  - "shell(rm -rf*)"
  - "execute_bash(rm -rf*)"
  - "bashToolCall(rm -rf*)"
```

**Kiro bridge**: the daemon writes `~/.kiro/agents/telecode.json` with a `preToolUse` hook pointing at the daemon's loopback HTTP server (random port, per-boot HMAC Bearer token to prevent same-user spoofing). The hook command is Windows-aware (`node "C:\..."` with quote escaping); POSIX uses a bare path. Each kiro-cli tool call → daemon decides → exit 0 (allow) or 2 (deny + reason fed back to the model).

**Codex / Cursor**: use native protocol approvals; no hook bridge needed. All 4 agents route through the same `ApprovalBroker` → same inline-button UX.

---

## Adapter registry — adding a new agent

Telecode uses an **open-set registry** (`src/agents/registry.ts`) — adding a new CLI agent takes:

```typescript
// src/agents/<myagent>.ts (NEW file)
import type { AgentAdapter, AdapterMetadata } from './types.js';

export const myagentMetadata: AdapterMetadata = {
  kind: 'myagent',
  displayName: 'My Agent',
  badge: '🆎',
  description: 'My custom agent CLI',
};

export class MyAgentAdapter implements AgentAdapter {
  readonly kind = 'myagent' as const;
  async run(opts: AgentStartOpts): Promise<void> {
    // spawn the CLI, stream output via opts.onEvent, route approval via opts.broker
  }
}
```

```typescript
// src/agents/index.ts — add one line to register:
if (deps.myagent) {
  registry.register('myagent', () => new MyAgentAdapter(deps.myagent), myagentMetadata);
}
```

```yaml
# ~/.telecode/config.yaml — add the overlay
agents:
  myagent:
    command: my-agent-cli
    model: default
```

The `/new` wizard picker, reply-builders badge, dashboard list — everything picks up the new adapter automatically via `registry.list()`. No fixed types / UI / config schema to touch.

Currently four built-ins ship: Claude (in-process SDK), Kiro (CLI + hook bridge), Codex (CLI JSON-RPC), Cursor (CLI ACP).


---

## Logs & debugging

| File | Description |
| --- | --- |
| `~/.telecode/logs/telecode.log` | Pino structured logs, daily rotation, 7-day retention |
| `~/.telecode/logs/stdout.log` | launchd/systemd/NSSM-captured stdout |
| `~/.telecode/logs/stderr.log` | launchd/systemd/NSSM-captured stderr |
| `~/.telecode/state.db` | SQLite WAL (sessions, projects, tool_log, approvals) |
| `~/.telecode/daemon.lock` *(v1.0)* | Singleton lockfile (PID + startedAtMs) — blocks two daemons running simultaneously |
| `~/.telecode/policy.yaml` | Policy rules (allow/deny). The `📌 Forever` button atomic-appends rules here. |

Tail in real time:
```bash
tail -f ~/.telecode/logs/telecode.log | jq -r '"[\(.level)] \(.msg) \(.session_id // "")"'
```

Inspect SQLite:
```bash
sqlite3 ~/.telecode/state.db ".tables"
sqlite3 ~/.telecode/state.db "SELECT label, agent, project_id, status FROM sessions;"
sqlite3 ~/.telecode/state.db "SELECT tool_name, decision, datetime(created_at,'unixepoch','localtime') FROM tool_log ORDER BY id DESC LIMIT 20;"
```

**Secret scrub**: bot tokens, `sk-ant-*`, GitHub PATs, and `Bearer ...` headers are scrubbed in both pino redact and the Telegram notifier — even if a log/notify accidentally contains one.

---

## Troubleshooting

### Daemon won't start

**macOS**:
```bash
launchctl list | grep telecode
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
cat ~/.telecode/logs/stderr.log
```

**Linux**:
```bash
systemctl --user status telecode.service
systemctl --user restart telecode.service
journalctl --user -u telecode.service -n 50
```

**Windows**:
```powershell
Get-Service Telecode
nssm restart Telecode
Get-Content $env:USERPROFILE\.telecode\logs\stderr.log -Tail 50
```

### Daemon already running (lockfile conflict — v1.0)

Boot fails with `Telecode daemon already running with PID 12345`:

```bash
# Check whether the PID is alive
ps -p 12345           # macOS / Linux
Get-Process -Id 12345 # Windows PowerShell

# If the PID is dead (stale lockfile):
rm ~/.telecode/daemon.lock                                # macOS / Linux
Remove-Item $env:USERPROFILE\.telecode\daemon.lock        # Windows
```

Common cause: you're running `npm run dev` while a launchd/systemd/NSSM service is also running. Pick one — dev mode or service mode, not both.

### The bot doesn't reply in Telegram

1. Verify the token:
   ```bash
   TOKEN=$(grep TELEGRAM_BOT_TOKEN ~/.telecode/.env | cut -d= -f2)
   curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | jq
   ```
   Should print `"ok": true` and the bot info.

2. Verify your user_id is on the whitelist:
   ```bash
   grep allowed_user_ids ~/.telecode/config.yaml
   ```
   Compare with the id from @userinfobot.

3. Verify the daemon connected:
   ```bash
   grep "telegram bot connected" ~/.telecode/logs/telecode.log
   ```

4. **Privacy mode**: if you added the bot to a group and it doesn't see messages → @BotFather → `/setprivacy` → `Disable`.

### `/screenshot` fails

**macOS**: needs Screen Recording permission for `screencapture`:
- System Settings → Privacy & Security → Screen & System Audio Recording.
- Add `node` (path: `which node`) or whichever terminal app launched launchctl.

**Linux**: needs at least one of: `grim` (Wayland) / `gnome-screenshot` / `scrot`. Install via package manager:
```bash
sudo apt install gnome-screenshot   # Ubuntu / Debian
sudo dnf install gnome-screenshot   # Fedora
sudo apt install grim               # Wayland (sway, …)
```

**Windows**: uses PowerShell `[Screen]::PrimaryScreen` — nothing extra to install. If it fails, check the NSSM stderr log.

### `/session new kiro ...` doesn't open the IDE

```bash
# Do you have the Kiro CLI (headless)?
which kiro-cli
kiro-cli --version   # should print 2.3+
```

If not → install kiro-cli (see [Requirements](#requirements)). `kiro` (IDE) ≠ `kiro-cli` (headless).

### Kiro session fails immediately with `kiro-cli exit ?`

**Symptom**: create a Kiro session → bot replies `❌ kiro-cli exit ?` immediately, no output.

**Common cause**: `~/.telecode/config.yaml` has `binary: /Users/YOU/.local/bin/kiro-cli` (placeholder leftover from a pre-v1.0 bug) or an absolute path that doesn't exist on this machine.

**Fix**:
```bash
# Option 1 — bare name (v1.0+, recommended) — runtime PATH enrichment resolves it
sed -i '' 's|^    binary: .*kiro-cli.*$|    binary: kiro-cli|' ~/.telecode/config.yaml

# Option 2 — absolute path correct for this machine
KIRO_BIN=$(command -v kiro-cli)
sed -i '' "s|^    binary: .*$|    binary: ${KIRO_BIN}|" ~/.telecode/config.yaml

# Reload the daemon
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
```

**Verify**: `~/.telecode/logs/telecode.log` should have a `kiro adapter ready` line (no warning about the binary).

### Claude / Codex / Cursor says "Not logged in"

**Symptom**: session starts → bot replies `❌ Not logged in · Please run /login` (Claude) or `❌ not authenticated — please run cursor-agent login` (Cursor) or Codex fails to refresh access token.

**Root cause**: these agents use **OAuth tokens with a TTL**. When you run the CLI in your terminal, it can refresh the token interactively (browser popup). The daemon runs non-interactive → when the token expires, it cannot refresh and reports "not logged in".

**Fix** — re-login from your terminal, then restart the daemon:

```bash
# Claude — opens browser for OAuth refresh
claude
# then type: /login
# or just running any claude command triggers a refresh

# Codex — opens browser for OAuth refresh
codex login

# Cursor — opens browser for OAuth refresh
cursor-agent login

# Restart daemon to pick up fresh tokens
# macOS:
launchctl bootout gui/$(id -u)/dev.telecode.daemon
rm -f ~/.telecode/daemon.lock
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.telecode.daemon.plist

# Linux:
systemctl --user restart telecode.service

# Windows:
nssm restart Telecode
```

**How often?** Depends on the provider's token TTL — typically a few hours to a few days. If it happens frequently, consider running a cron/launchd job that periodically invokes the CLI to keep the token fresh.

### Daemon crash loop

```bash
tail -50 ~/.telecode/logs/stderr.log
```

Common causes:
- `~/.telecode/config.yaml` has invalid YAML → validate via `python3 -c "import yaml; yaml.safe_load(open('$HOME/.telecode/config.yaml'))"`.
- Port conflict (unlikely — the daemon long-polls, doesn't listen).
- SQLite lock — check whether `~/.telecode/state.db-wal` and `state.db-shm` are stuck after a crash; delete if needed.

### Machine sleeps → bot offline

The bot uses long-poll against the Telegram API; when the machine sleeps the daemon pauses. Options per OS:

**macOS**: `caffeinate -i` in a terminal, or [Amphetamine](https://apps.apple.com/app/amphetamine/id937984704).

**Linux**: `systemd-inhibit --what=sleep:idle --who=telecode --why="long-poll" sleep infinity`, or disable suspend in Settings.

**Windows**: Settings → System → Power & battery → Screen and sleep → set to "Never". Or install [Caffeine for Windows](https://www.zhornsoftware.co.uk/caffeine/).

Future: VPS relay mode (roadmap v1.1+).

---

## Updating Telecode

**macOS**:
```bash
cd ~/Documents/workspaces/telecode
git pull
npm install
npm run build
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
```

**Linux**:
```bash
cd ~/workspaces/telecode
git pull
npm install
npm run build
systemctl --user restart telecode.service
```

**Windows**:
```powershell
cd C:\Users\<you>\workspaces\telecode
git pull
npm install
npm run build
nssm restart Telecode
```

Config + policy + DB + lockfile under `~/.telecode/` (`%USERPROFILE%\.telecode\` on Windows) is preserved across updates.

### Migration v1.1 → v1.2 (bilingual UI)

**Backward compat 100%** — no manual config or DB migration needed.

**On first v1.2 boot**, the daemon runs an idempotent migration:
1. `ALTER TABLE chat_settings ADD COLUMN language TEXT` (DEFAULT `'en'` for fresh installs).
2. Backfill existing rows: `UPDATE chat_settings SET language = 'vi' WHERE language IS NULL` so existing chats keep their Vietnamese UX until you change it via `/language`.

**For brand-new chats**: the v1.1 verbosity announcement is replaced by a language picker. Pick once → the chat_settings row is created with your chosen language → the verbosity migration note is then sent in that language.

### Migration v1.0 → v1.1 (streaming UX redesign)

**Backward compat 100%** — no `config.yaml` or manual DB migration.

**On first v1.1 boot**, the daemon detects via the new `chat_settings` table and sends one announcement per `allowed_user_id` explaining the new default + how to get the old behaviour back via `/mode verbose`. The migration adds:
1. Column `sessions.verbosity_mode TEXT` (NULL → fallback chain → `summary`).
2. `chat_settings` table.

Existing sessions, policy.yaml, and .env are untouched.

### Migration v0.8 → v1.0

Backward compat 100% — no edits to `config.yaml` if you only use Claude + Kiro.

**Optional** — add Codex / Cursor adapters:

```yaml
agents:
  # already have claude: / kiro: ...
  codex:
    command: codex
    model: gpt-5.1-codex
    effort: medium
  cursor:
    command: cursor-agent
    model: auto
```

**Auth setup** (required if you enable Codex / Cursor):
```bash
codex login           # OpenAI account, persistent token
cursor-agent login    # Cursor account, persistent token
```

Telecode does NOT handle auth — log in via the native command in your shell first; the daemon spawns the binary and assumes credentials are ready.

**Daemon singleton**: v1.0 added `~/.telecode/daemon.lock`. If boot fails with "Telecode daemon already running with PID X" → check whether that PID is alive (`ps -p X` / `Get-Process -Id X`). If dead → remove the lockfile manually: `rm ~/.telecode/daemon.lock`.

### Migration v0.4 → v0.6 (Kiro config schema changed)

If you have config from before v0.5, edit `~/.telecode/config.yaml`:

```yaml
agents:
  kiro:
    binary: kiro-cli                         # ← bare name (v1.0+) or absolute path
    # default_mode: agent                    # ← remove this line (obsolete schema)
```

**v1.0+**: bare name `kiro-cli` is resolved via runtime PATH enrichment (`buildKiroMcpPath()` prepends `~/.local/bin`, `~/.cargo/bin`, `~/.nvm/...` to PATH at spawn time). Before that, an absolute path was required because launchd's default PATH had no user runtime dirs.

> **If you upgraded from v0.5–v0.8 and notice the old config has `binary: /Users/YOU/.local/bin/kiro-cli`** (a placeholder leftover from `config.example.yaml`): that's a bug fixed in v1.0. Change it to `binary: kiro-cli` or `binary: $(which kiro-cli)` and restart the daemon. The new installer (`install-launchd.sh`) auto-detects the path via `command -v kiro-cli`.

### Migration v0.7 → v0.8

No migration needed: if `~/.telecode/config.yaml` has no `notifier:` section, defaults apply automatically (`debounce_ms: 3000`, `buffer_cap_bytes: 50000`). Add the section to tune as described in [Multi-session UX](#multi-session-ux).

---

## Uninstall

**macOS**:
```bash
cd ~/Documents/workspaces/telecode
./scripts/uninstall-launchd.sh
```

**Linux**:
```bash
cd ~/workspaces/telecode
./scripts/uninstall-systemd.sh             # interactive — prompts about ~/.telecode
./scripts/uninstall-systemd.sh --keep-data # keep ~/.telecode without asking
./scripts/uninstall-systemd.sh --purge     # delete ~/.telecode (needs `yes` confirm)
./scripts/uninstall-systemd.sh --purge --yes  # automation, skip confirm
./scripts/uninstall-systemd.sh --dry-run   # print commands, don't execute
```

**Windows**:
```powershell
cd C:\Users\<you>\workspaces\telecode
.\scripts\uninstall-windows.ps1                # interactive — prompts about ~/.telecode
.\scripts\uninstall-windows.ps1 -KeepData      # keep %USERPROFILE%\.telecode
.\scripts\uninstall-windows.ps1 -Purge         # delete it (needs confirm)
.\scripts\uninstall-windows.ps1 -Purge -Yes    # automation, skip confirm
.\scripts\uninstall-windows.ps1 -DryRun        # print commands, don't execute
```

The script stops the daemon + removes the service unit/registration. By default `~/.telecode/` (config, token, DB, log) is **kept** so you can reinstall later without losing setup (unless you pass `--purge` / `-Purge`).

To wipe completely (cross-platform):
```bash
# macOS / Linux
rm -rf ~/.telecode/

# Windows
Remove-Item -Recurse -Force $env:USERPROFILE\.telecode
```
Optional: revoke the bot → @BotFather → `/mybots` → pick the bot → Delete Bot.

---

## Architecture & docs

- [docs/plans/telecode-v1.0-cross-platform-multi-agent.html](docs/plans/telecode-v1.0-cross-platform-multi-agent.html) — **Plan v1.0** (cross-platform + multi-agent: T3 carry-over + foundation refactor + Linux/Windows + Codex/Cursor + hardening).
- [docs/design/telecode-v1.0-cross-platform-multi-agent.html](docs/design/telecode-v1.0-cross-platform-multi-agent.html) — **SDD v1.0** (design decisions, tech freshness via Context7, 5 senior review patch sections — Opus 4.7).
- [docs/plans/per-session-view-buffering.html](docs/plans/per-session-view-buffering.html) + [docs/design/per-session-view-buffering.html](docs/design/per-session-view-buffering.html) — Plan + SDD v0.8 (multi-session view discipline).
- [docs/plans/ux-telegram-widgets.html](docs/plans/ux-telegram-widgets.html) + [docs/design/ux-telegram-widgets.html](docs/design/ux-telegram-widgets.html) — Plan + SDD v0.7 (slash menu, persistent keyboard, `/new` wizard, project picker).
- [docs/plans/telegram-bridge.html](docs/plans/telegram-bridge.html) + [docs/design/telegram-bridge.html](docs/design/telegram-bridge.html) — Plan + SDD original M0–M5 (core daemon).
- [docs/SMOKE_TEST_v0.6.md](docs/SMOKE_TEST_v0.6.md) — Smoke-test runbook for v0.6 (Kiro approval hook bridge).

Open a plan/SDD in your browser: `open docs/plans/telecode-v1.0-cross-platform-multi-agent.html`.

Stack summary:
- **Node 22 ESM + TypeScript strict** (engines.node >= 22)
- [grammY](https://grammy.dev) `1.43.0` + `@grammyjs/conversations` `2.1.1` + `@grammyjs/runner` `2.0.3` (Telegram bot, conversation wizard)
- `@anthropic-ai/claude-agent-sdk` `0.3.145` (Claude — in-process SDK, `canUseTool` + hooks + resume)
- `kiro-cli chat --no-interactive` (Kiro — headless streaming, resume-id, HMAC-protected `preToolUse` hook)
- `codex app-server` (Codex — JSON-RPC over stdio, native `approvalPolicy` + `sandboxPolicy`)
- `cursor-agent acp` (Cursor — ACP JSON-RPC over stdio, `session/request_permission`)
- `better-sqlite3` `12.10.0` WAL (state)
- `pino` `10.3.1` + `pino-roll` `4.0.0` (logs with secret redaction)
- `async-mutex` `0.5.0` (per-session serialization)
- `zod` `4.4.3` + `yaml` `2.9.0` (config validation, `z.record` open-set adapter schema)
- `execa` `9.6.1` (cross-platform child process)
- `vitest` `4.1.7` (949 passing tests)

---

## Known limitations

- **Single user per daemon** — multi-tenant isn't supported. Each user runs their own daemon + their own bot.
- **Sleep / suspend → bot offline** — the daemon uses Telegram long-poll; when the machine sleeps the daemon pauses. On Linux use `caffeine` / disable suspend; on Mac use `caffeinate -i` or Amphetamine; on Windows turn off sleep in Power Settings. VPS relay mode is on the roadmap.
- **No web UI** — managed via Telegram + YAML edits.
- **Auth is native** — Telecode does NOT handle login flows. Run `codex login` / `cursor-agent login` / `kiro-cli login` from a shell before starting the daemon. Adapters spawn the binary and assume credentials are ready. If a CLI reports unauth, the adapter surfaces the error with a hint.
- **`/screenshot` on Linux** needs at least one of: `grim` (Wayland) / `gnome-screenshot` / `scrot`. Install via your package manager.
- **Antigravity adapter** — Google launched on 2026-05-19 but the CLI is **GUI-first**; headless mode isn't supported yet. Re-evaluate in 6 months. The open-set registry in v1.0 is enough to add it later without re-planning.

Roadmap (v1.3+):
- Gemini CLI adapter (Google ecosystem branch, ACP-like protocol).
- Antigravity adapter once headless mode matures.
- VPS relay mode for 24/7 operation (bypasses local sleep).
- Aggregated notifications (combine N done events into 1).
- Per-event user-configurable notification toggle.

Contributions / bug reports: open an issue in this repo.
