/**
 * English message catalog. The KEYS in this file form the source of truth
 * for the i18n type system — `MessageKey = keyof typeof EN_MESSAGES`. Every
 * other locale catalog (vi, …) must implement the SAME keys, enforced at
 * compile time via the `MessageCatalog` type in `../index.ts`.
 *
 * Conventions:
 *   - Keys are dotted, namespaced by feature (`start.*`, `language.*`).
 *   - Values may contain `{var}` placeholders interpolated by `t()` via the
 *     `vars` parameter — see {@link interpolate} in `../index.ts`.
 *   - Telegram Markdown is allowed; callers pass `parse_mode: 'Markdown'`
 *     where appropriate. Keep emoji + asterisks in BOTH catalogs so the
 *     visual layout matches across locales.
 */
export const EN_MESSAGES = {
  // ---- /start welcome ---------------------------------------------------
  'start.welcome.title': '👋 *Telecode* online',
  'start.activeSession': 'Active: `{label}`',
  'start.noActiveSession': 'Active: (none — `/session new`)',
  'start.sessionsCount': 'Sessions: {count}',
  'start.commandsHint':
    'Commands: `/session`, `/projects`, `/cd`, `/stop`, `/status`, `/allow`, `/deny`, `/screenshot`',

  // ---- Language picker (first-boot + /language) -------------------------
  'language.picker.prompt':
    '🌐 *Choose your language* / *Chọn ngôn ngữ*\n\nThis affects bot messages only. You can change it any time via `/language`.',
  'language.picker.button.en': '🇬🇧 English',
  'language.picker.button.vi': '🇻🇳 Tiếng Việt',
  'language.changed': '✅ Language set to *English*.',
  'language.current': 'Current language: *English* (`en`).\nUse `/language` and pick to change.',
  'language.invalid': 'Unknown language `{value}`. Use the buttons above.',

  // ---- v1.1 verbosity migration note (sent after language pick) ---------
  'verbosity.migrationNote':
    '📢 *Telecode v1.1* — verbosity modes\n\n' +
    'Default mode is now 🎯 *Summary* — only approval, done, and errors are shown.\n\n' +
    'Want the old verbose firehose:\n' +
    '  • `/mode verbose`           — applies to the active session only\n' +
    '  • `/settings mode verbose`  — sets the chat default\n\n' +
    'Switch any time via the slash menu (`/mode`, `/settings`).',

  // ---- Common errors ----------------------------------------------------
  'error.noActiveSession': 'no active session',
  'error.noActiveSessionWithHint': 'no active session — /new to create',
  'error.noActiveSessionForPrompt': 'no active session — /session new <agent> <label> [path]',
  'error.notFound': 'not found',
  'error.pathNotFound': 'path not found: {path}',
  'error.i18nNotConfigured': 'i18n not configured.',

  // ---- /session ---------------------------------------------------------
  'session.usage.new': 'Usage: /session new <agent> <label> [path]',
  'session.usage.switch': 'Usage: /session switch <label>',
  'session.usage.rename': 'Usage: /session rename <new-label>',
  'session.usage.subcommands':
    'session subcommands: new <agent> <label> [path] | list | switch <label> | rename <label> | close [label] | clear',
  'session.list.empty': 'no sessions',
  'session.list.entry': '• `{label}` — {agent} · {status}{resumable}',
  'session.list.resumable': ' · resumable',
  'session.error.agentNotRegistered': "agent '{agent}' is not registered. Available: {known}",
  'session.error.agentNoneRegistered': '(none registered)',
  'session.error.alreadyExists': 'session "{label}" already exists',
  'session.error.unknown': 'unknown: {label}',
  'session.error.labelTaken': 'label taken',
  'session.error.noSession': 'no session',
  'session.created': '📍 [{label}] — agent=`{agent}`',
  'session.switched.preview': '📍 [{label}]\n{tail}',
  'session.switched.noTranscript': '(no transcript yet)',
  'session.renamed': '✏️ {oldLabel} → {newLabel}',
  'session.closed': '🗑 closed [{label}]',
  'session.cleared': '🧹 cleared [{label}] — context wiped, send a new prompt',

  // ---- /handoff ---------------------------------------------------------
  'handoff.error.noActive': 'no active session — /new to create',

  // ---- /mode + /settings ------------------------------------------------
  'mode.error.noActive':
    'No active session — /new to create a session, then change mode.',
  'mode.error.invalid': "❓ Mode '{mode}' is invalid. Choose: {known}",
  'mode.changed': '{icon} [{label}] mode → *{displayName}* ({description})',
  'mode.status.title': '*Current mode of [{label}]:* {icon} {displayName}',
  'mode.status.description': '_{description}_',
  'mode.status.source': 'Source: {source}',
  'mode.status.sourceSession': 'session override',
  'mode.status.sourceChat': 'chat default → {displayName}',
  'mode.status.tap': 'Tap to change mode (this session only):',
  'settings.usage.modeUnset': 'Usage: /settings mode <summary|normal|thinking|verbose>',
  'settings.usage.unknown': 'Usage: /settings | /settings mode <summary|normal|thinking|verbose>',
  'settings.modeChanged':
    '{icon} Chat default → *{displayName}* ({description})\nApplies to new sessions + sessions without overrides.',
  'settings.title': '*Chat settings*',
  'settings.defaultMode': '*Default mode:* {icon} {displayName} — _{description}_',
  'settings.tap': 'Tap to change the chat-wide default (used by new sessions):',

  // ---- /projects + /add + /cd -------------------------------------------
  'add.usage': 'Usage: /add <path> [name]',
  'add.created': '📁 {name} → {path}',
  'cd.usage': 'Usage: /cd <name|path>',
  'cd.changed': '📁 cwd → {path}',

  // ---- /stop ------------------------------------------------------------
  'stop.stopping': '🛑 stopping [{label}]',
  'stop.nothing': 'nothing to stop',

  // ---- /status ----------------------------------------------------------
  'status.noLogs': 'no logs',
  'status.lineActive': 'Active: [{label}] {agent} · {status}',
  'status.lineActiveNone': 'Active: (none)',
  'status.lineResumeId': 'Resume id: {id}',
  'status.lineSessions': 'Sessions: {count}',
  'status.lineLastTools': 'Last tools:',
  'status.lineContext': 'Context: {used}/{max} ({pct}%){model}',
  'status.lineTokens': 'Tokens used: {used}{model}',
  'status.warnContext': '⚠️ Context window >70% — consider /handoff',

  // ---- /model -----------------------------------------------------------
  'model.current': 'Current model: {model}',
  'model.changed': '✓ Model changed to: {model}',
  'model.autoServerDefault': 'auto (server default)',

  // ---- /dashboard -------------------------------------------------------
  'dashboard.error.notRunning': 'No dashboard is running.',
  'dashboard.stopped': '🛑 Dashboard stopped.',
  'dashboard.alreadyRunning': 'Dashboard is already running — type `/dashboard stop` to close it before opening a new one.',
  'dashboard.idleAutoStop': '💤 Dashboard auto-stopped after 5 minutes idle.',
  'dashboard.startFailed': '⚠️ Could not open dashboard — try again later.',

  // ---- /allow + /deny ---------------------------------------------------
  'allow.usage': 'Usage: /allow <pattern>',
  'deny.usage': 'Usage: /deny <pattern>',
  'allow.added': '✅ allow += `{pattern}`',
  'deny.added': '🚫 deny += `{pattern}`',

  // ---- /notify (quiet hours) --------------------------------------------
  'notify.statusOff': '🔔 Quiet hours: OFF\n\nUsage:\n/notify quiet 22:00-08:00\n/notify quiet off',
  'notify.statusOn':
    '🔕 Quiet hours: {start}–{end} ({tz})\n\nMessages still arrive but are silent during this window.\n/notify quiet off — disable',
  'notify.disabled': '🔔 Quiet hours disabled.',
  'notify.usage':
    'Usage: /notify quiet 22:00-08:00 [timezone]\nExample: /notify quiet 23:00-07:00 Asia/Ho_Chi_Minh',
  'notify.invalidTime': '❌ Invalid time — hours must be 0-23, minutes 0-59.',
  'notify.invalidTz': '❌ Invalid timezone: {tz}',
  'notify.set': '🔕 Quiet hours set: {start}–{end} ({tz})\nMessages still arrive but silent in this window.',

  // ---- /context (pinned) ------------------------------------------------
  'context.editFile':
    '📝 Pinned context file:\n`{path}`\n\nEdit this file to change the context injected into prompts.',
  'context.cleared': '🗑 Pinned context cleared.',
  'context.noFile': 'No pinned context file found.',
  'context.empty':
    'No pinned context found.\n\nCreate `{path}` to inject context into every prompt.',
  'context.show': '📌 Pinned context ({chars} chars):\n\n{preview}',

  // ---- /send (file sharing) ---------------------------------------------
  'send.usage': 'Usage: /send <path>\nSend a file from the project to Telegram. Path is relative to the active project.',
  'send.errorTraversal': '❌ Path traversal not allowed — only files inside the project.',
  'send.error': '❌ {error}',

  // ---- /screenshot ------------------------------------------------------
  'screenshot.emptyDarwin':
    '📸 screencapture failed or returned an empty image.\nMost often this means *Screen Recording* permission is missing.\nSystem Settings → Privacy & Security → Screen & System Audio Recording → enable the binary running the daemon (Terminal / node / launchd) → restart daemon.',
  'screenshot.emptyOther':
    '📸 capture returned an empty image — check daemon permissions or X server access.',
  'screenshot.error': 'screenshot error: {error}',

  // ---- /history ---------------------------------------------------------
  'history.searchUsage': 'Usage: /history search <query>',
  'history.searchEmpty': '🔍 No results for "{query}".',
  'history.searchTitle': '🔍 Search results for "{query}":',
  'history.lastEmpty': '📋 No sessions in the last {days} days.',
  'history.lastTitle': '📋 Sessions (last {days} days): {count}',
  'history.defaultEmpty': '📋 No sessions in the last 7 days.',
  'history.defaultTitle': '📋 Sessions (last 7 days): {count}',
  'history.hint': '\n\n💡 /history search <query> — search\n💡 /history last <N>d — last N days',

  // ---- /cost ------------------------------------------------------------
  'cost.errorSessionNotFound': '❌ Session "{label}" not found.',
  'cost.session':
    '💰 Cost — [{label}] ({agent})\n├ Input: {input} tokens\n├ Output: {output} tokens\n└ Total: ${total}',
  'cost.summary':
    '💰 Cost summary\n├ Today:  ${today}\n├ 7 days: ${week}\n└ 30 days: ${month}',
  'cost.breakdownTitle': '\n\n📊 Per-agent (30d):',
  'cost.breakdownEntry': '\n  {agent}: ${total} ({input} in / {output} out)',

  // ---- /timeline --------------------------------------------------------
  'timeline.errorSessionNotFound': '❌ Session "{label}" not found.',
  'timeline.errorNoActive': 'No active session — /timeline <label> or switch session first.',
  'timeline.errorServer': '❌ Timeline server is not running.',
  'timeline.url': '📜 http://localhost:{port}/timeline/{sessionId}',

  // ---- /verify ----------------------------------------------------------
  'verify.status':
    '🔍 Auto-verify config:\n├ Enabled: {enabled}\n├ Command: `{command}`\n├ Max retries: {maxRetries}\n└ Agents: {agents}',
  'verify.agentsAll': '(all)',
  'verify.errorNoActive': 'No active session — /session new <agent> <label> [path]',
  'verify.running': '🔍 Running: `{command}`…',
  'verify.passed': '✅ Verify passed.',
  'verify.failed': '❌ Verify failed (exit {exitCode}):\n```\n{output}\n```',

  // ---- /template --------------------------------------------------------
  'template.usage.save': 'Usage: /template save <name>',
  'template.usage.run': 'Usage: /template run <name>',
  'template.usage.delete': 'Usage: /template delete <name>',
  'template.error.noActive': '❌ No active session.',
  'template.error.notFound': '❌ Template "{name}" not found.',
  'template.saved': '✅ Template "{name}" saved (agent={agent}).',
  'template.listEmpty': '📋 No templates yet. Use /template save <name>',
  'template.listTitle': '📋 Templates:',
  'template.listEntry': '• {name} — {agent} — "{prompt}"',
  'template.created': '📍 [{label}] created from template "{name}" (agent={agent})',
  'template.deleted': '🗑 Template "{name}" deleted.',
  'template.help':
    '📋 /template commands:\n• /template save <name> — save the current session\n• /template list — list templates\n• /template run <name> — create a new session from a template\n• /template delete <name> — remove a template',

  // ---- /schedule --------------------------------------------------------
  'schedule.usage.add': 'Usage: /schedule add <name> <min> <hour> <dom> <mon> <dow> <prompt>',
  'schedule.usage.delete': 'Usage: /schedule delete <name>',
  'schedule.usage.enable': 'Usage: /schedule enable <name>',
  'schedule.usage.disable': 'Usage: /schedule disable <name>',
  'schedule.error.alreadyExists': '❌ Schedule "{name}" already exists. Delete it first to recreate.',
  'schedule.error.notFound': '❌ Schedule "{name}" not found.',
  'schedule.added': '✅ Schedule "{name}" created\n⏰ {cron} · {agent}\n📝 {prompt}',
  'schedule.listEmpty': '📋 No schedules yet. Use /schedule add <name> ...',
  'schedule.listTitle': '📋 Schedules:',
  'schedule.deleted': '🗑 Schedule "{name}" deleted.',
  'schedule.enabled': '✅ Schedule "{name}" enabled.',
  'schedule.disabled': '⏸ Schedule "{name}" disabled.',
  'schedule.help':
    '⏰ /schedule commands:\n• /schedule add <name> <cron 5-field> <prompt>\n• /schedule list — list schedules\n• /schedule enable <name>\n• /schedule disable <name>\n• /schedule delete <name>\n\nExample: /schedule add daily-test 0 9 * * * pnpm test',

  // ---- /chain -----------------------------------------------------------
  'chain.help':
    '⛓️ /chain — multi-agent pipeline\n\nSyntax: /chain agent1: prompt1 | agent2: prompt2\nToken `{{prev}}` = output of previous step.\n\nExample:\n/chain claude: write unit tests for auth.ts | kiro: review {{prev}} and suggest fixes\n\nMax 5 steps, separated by |.',
  'chain.error': '❌ {error}',
  'chain.starting': '⛓️ Starting chain ({total} steps)…',
  'chain.stepDone': '⛓️ Step {step}/{total} ({agent}) complete',
  'chain.result': '⛓️ Chain result:\n\n{output}',
  'chain.empty': '⛓️ Chain complete (no text output).',

  // ---- Attachments / voice ---------------------------------------------
  'attachment.photo.noActive':
    '📸 Got a photo but no active session — /session new <agent> <label> [path] then resend.',
  'attachment.photo.empty': '📸 message:photo but photo[] empty — could not download.',
  'attachment.photo.downloading': '📥 [{label}] downloading photo…',
  'attachment.document.noActive':
    '📎 Got a file but no active session — /session new <agent> <label> [path] then resend.',
  'attachment.document.missing': '📎 message:document but document object missing — could not download.',
  'attachment.document.downloading': '📥 [{label}] downloading {name}…',
  'voice.noActive': '🎵 Got voice but no active session — /new then resend.',
  'voice.notConfigured': '🎵 Voice-to-prompt is not configured. Add OPENAI_API_KEY to .env.',
  'voice.noFilePath': '🎵 Could not get file path from Telegram.',
  'voice.downloadFailed': '🎵 Voice download failed ({status}).',
  'voice.preview': '🎵 "{preview}"',
  'voice.error': '🎵 Voice processing error: {error}',

  // ---- Wizard / dispatch shared ----------------------------------------
  'dispatch.dispatching': '[{label}] dispatching…',
  'dispatch.handoffInjected': '📥 [{label}] injecting handoff context ({chars} chars) into prompt — runs only once.',
};

/**
 * Catalog shape derived from the EN baseline. Every locale catalog must
 * implement this shape (TS enforces this in `vi.ts` via the type annotation).
 * Values are widened to `string` so non-EN translations don't have to match
 * the EN literal — that would defeat the purpose of translation.
 */
export type EnMessages = Record<keyof typeof EN_MESSAGES, string>;
