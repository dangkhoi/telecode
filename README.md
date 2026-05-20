# Telecode

Chat with Claude Code and Kiro from Telegram — local daemon that bridges your phone to coding agents running on your Mac.

## Status

v0.4 — M0–M5 ship-ready. macOS only (launchd).

## Quick install

```bash
git clone <repo> ~/Documents/workspaces/telecode
cd ~/Documents/workspaces/telecode
./scripts/install-launchd.sh   # walks you through @BotFather + token
```

The installer:

1. Verifies Node 22+.
2. Creates `~/.telecode/` (chmod 700).
3. Seeds `config.yaml`, `policy.yaml`.
4. Walks you through `@BotFather → /newbot` if `~/.telecode/.env` is missing.
5. `npm install && npm run build`.
6. Writes `~/Library/LaunchAgents/dev.telecode.daemon.plist`, loads it.

## Telegram commands

```
/start                                show active session + counts
/session new <agent> <label> [path]   claude | kiro
/session list                         + inline keyboard quick-switch
/session switch <label>               sets active session, shows transcript tail
/session rename <label>
/session close [label]
/session reset                        keep label, drop resume id
/projects                             list registered projects
/add <path> [name]                    register a project
/cd <name|path>                       point active session at a project
/stop                                 interrupt active session
/status                               session + last 5 tool calls
/status logs [n]                      tail tool_log (default 20)
/allow <pattern>                      append to policy.yaml allow
/deny <pattern>                       append to policy.yaml deny
/screenshot                           grab desktop (needs Screen Recording perm)
<plain text>                          → dispatched to active session
```

## Multi-session

One Telegram chat can have many sessions running in parallel. Each session is an
(agent, project, thread) tuple with its own mutex. Plain-text messages go to the
active session — `/session switch <label>` to swap. Sessions in different
projects do not block each other.

## Permissions

`canUseTool` is wired into the Claude adapter. Each tool call hits the policy
engine first:

| outcome | flow                                                                  |
| ------- | --------------------------------------------------------------------- |
| allow   | resolved immediately, fire-and-forget Telegram notify (`🔧 …`)        |
| deny    | resolved with a deny message                                          |
| ask     | Telegram inline button `[Allow once] [Allow always] [Deny]`           |

Policy lives in `~/.telecode/policy.yaml` (atomic write + `fs.watch` reload).
`/allow` and `/deny` co-edit it; you can also edit by hand and the daemon picks
it up.

Timeout fallback: no tap inside `daemon.approval_timeout_sec` (default 300s) →
auto-deny.

## Logs

- `~/.telecode/logs/telecode.log` — pino, daily rotation, 7-day retention.
- `~/.telecode/logs/stdout.log` + `stderr.log` — launchd-captured fallback.

Secrets (bot token, `sk-ant-*`, GitHub PATs, Bearer headers) are scrubbed in
both pino redact and the Telegram notifier.

## Kiro caveat

`kiro chat --mode agent --reuse-window <prompt>` loads the prompt into the Kiro
IDE window but does not stream agent output to stdout. Phase 1 is
fire-and-notify; open Kiro to see the agent run. Stream-back is a stretch goal.

## Uninstall

```bash
./scripts/uninstall-launchd.sh
```

User data at `~/.telecode/` is preserved.
