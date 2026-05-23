/**
 * Vietnamese message catalog. MUST implement every key from
 * {@link ./en.ts EN_MESSAGES} — enforced at compile time by typing this
 * record as `MessageCatalog` in `../index.ts`.
 *
 * Editing rules: see ../messages/en.ts header. Keep emoji + Markdown layout
 * IDENTICAL to the EN counterpart so the rendered Telegram bubbles look the
 * same shape across locales (only the words change).
 */
import type { EnMessages } from './en.js';

export const VI_MESSAGES: EnMessages = {
  // ---- /start welcome ---------------------------------------------------
  'start.welcome.title': '👋 *Telecode* đã online',
  'start.activeSession': 'Active: `{label}`',
  'start.noActiveSession': 'Active: (chưa có — `/session new`)',
  'start.sessionsCount': 'Sessions: {count}',
  'start.commandsHint':
    'Lệnh: `/session`, `/projects`, `/cd`, `/stop`, `/status`, `/allow`, `/deny`, `/screenshot`',

  // ---- Language picker (first-boot + /language) -------------------------
  'language.picker.prompt':
    '🌐 *Choose your language* / *Chọn ngôn ngữ*\n\nChỉ ảnh hưởng tới message của bot. Đổi bất kỳ lúc nào qua `/language`.',
  'language.picker.button.en': '🇬🇧 English',
  'language.picker.button.vi': '🇻🇳 Tiếng Việt',
  'language.changed': '✅ Đã đặt ngôn ngữ thành *Tiếng Việt*.',
  'language.current':
    'Ngôn ngữ hiện tại: *Tiếng Việt* (`vi`).\nGõ `/language` rồi chọn để đổi.',
  'language.invalid': 'Ngôn ngữ `{value}` không hợp lệ. Dùng buttons ở trên.',

  // ---- v1.1 verbosity migration note (sent after language pick) ---------
  'verbosity.migrationNote':
    '📢 *Telecode v1.1* — verbosity modes\n\n' +
    'Mode mặc định giờ là 🎯 *Summary* — chỉ show approval + done + errors.\n\n' +
    'Muốn behavior cũ (verbose firehose):\n' +
    '  • `/mode verbose`           — chỉ áp dụng cho session active\n' +
    '  • `/settings mode verbose`  — đặt làm default cho cả chat\n\n' +
    'Đổi mode bất kỳ lúc nào qua slash menu (`/mode`, `/settings`).',

  // ---- Common errors ----------------------------------------------------
  'error.noActiveSession': 'chưa có session active',
  'error.noActiveSessionWithHint': 'chưa có session active — /new để tạo',
  'error.noActiveSessionForPrompt': 'chưa có session active — /session new <agent> <label> [path]',
  'error.notFound': 'không tìm thấy',
  'error.pathNotFound': 'không tìm thấy path: {path}',
  'error.i18nNotConfigured': 'i18n chưa được cấu hình.',

  // ---- /session ---------------------------------------------------------
  'session.usage.new': 'Usage: /session new <agent> <label> [path]',
  'session.usage.switch': 'Usage: /session switch <label>',
  'session.usage.rename': 'Usage: /session rename <new-label>',
  'session.usage.subcommands':
    'session subcommands: new <agent> <label> [path] | list | switch <label> | rename <label> | close [label] | clear',
  'session.list.empty': 'chưa có session nào',
  'session.list.entry': '• `{label}` — {agent} · {status}{resumable}',
  'session.list.resumable': ' · resumable',
  'session.error.agentNotRegistered': "agent '{agent}' chưa được đăng ký. Available: {known}",
  'session.error.agentNoneRegistered': '(chưa có agent nào)',
  'session.error.alreadyExists': 'session "{label}" đã tồn tại',
  'session.error.unknown': 'không tìm thấy: {label}',
  'session.error.labelTaken': 'label đã được dùng',
  'session.error.noSession': 'không có session',
  'session.created': '📍 [{label}] — agent=`{agent}`',
  'session.switched.preview': '📍 [{label}]\n{tail}',
  'session.switched.noTranscript': '(chưa có transcript)',
  'session.renamed': '✏️ {oldLabel} → {newLabel}',
  'session.closed': '🗑 đã đóng [{label}]',
  'session.cleared': '🧹 đã xoá context [{label}] — gõ prompt mới',

  // ---- /handoff ---------------------------------------------------------
  'handoff.error.noActive': 'chưa có session active — /new để tạo',

  // ---- /mode + /settings ------------------------------------------------
  'mode.error.noActive':
    'Chưa có session active — /new tạo session rồi mới đổi mode được.',
  'mode.error.invalid': "❓ Mode '{mode}' không hợp lệ. Chọn: {known}",
  'mode.changed': '{icon} [{label}] mode → *{displayName}* ({description})',
  'mode.status.title': '*Mode hiện tại của [{label}]:* {icon} {displayName}',
  'mode.status.description': '_{description}_',
  'mode.status.source': 'Source: {source}',
  'mode.status.sourceSession': 'session override',
  'mode.status.sourceChat': 'chat default → {displayName}',
  'mode.status.tap': 'Tap để đổi mode (chỉ áp dụng cho session này):',
  'settings.usage.modeUnset': 'Usage: /settings mode <summary|normal|thinking|verbose>',
  'settings.usage.unknown': 'Usage: /settings | /settings mode <summary|normal|thinking|verbose>',
  'settings.modeChanged':
    '{icon} Chat default → *{displayName}* ({description})\nÁp dụng cho session mới + session chưa set override.',
  'settings.title': '*Chat settings*',
  'settings.defaultMode': '*Default mode:* {icon} {displayName} — _{description}_',
  'settings.tap': 'Tap để đổi default cho cả chat (session mới sẽ dùng):',

  // ---- /projects + /add + /cd -------------------------------------------
  'add.usage': 'Usage: /add <path> [name]',
  'add.created': '📁 {name} → {path}',
  'cd.usage': 'Usage: /cd <name|path>',
  'cd.changed': '📁 cwd → {path}',

  // ---- /stop ------------------------------------------------------------
  'stop.stopping': '🛑 đang dừng [{label}]',
  'stop.nothing': 'không có gì để dừng',

  // ---- /status ----------------------------------------------------------
  'status.noLogs': 'không có log',
  'status.lineActive': 'Active: [{label}] {agent} · {status}',
  'status.lineActiveNone': 'Active: (none)',
  'status.lineResumeId': 'Resume id: {id}',
  'status.lineSessions': 'Sessions: {count}',
  'status.lineLastTools': 'Last tools:',
  'status.lineContext': 'Context: {used}/{max} ({pct}%){model}',
  'status.lineTokens': 'Tokens used: {used}{model}',
  'status.warnContext': '⚠️ Context window >70% — cân nhắc /handoff',

  // ---- /model -----------------------------------------------------------
  'model.current': 'Model hiện tại: {model}',
  'model.changed': '✓ Model đổi thành: {model}',
  'model.autoServerDefault': 'auto (server default)',

  // ---- /dashboard -------------------------------------------------------
  'dashboard.error.notRunning': 'Không có dashboard nào đang chạy.',
  'dashboard.stopped': '🛑 Đã tắt dashboard.',
  'dashboard.alreadyRunning': 'Dashboard đã chạy — gõ `/dashboard stop` để tắt trước khi mở mới.',
  'dashboard.idleAutoStop': '💤 Dashboard auto-tắt sau 5 phút idle.',
  'dashboard.startFailed': '⚠️ Không mở được dashboard — thử lại sau.',

  // ---- /allow + /deny ---------------------------------------------------
  'allow.usage': 'Usage: /allow <pattern>',
  'deny.usage': 'Usage: /deny <pattern>',
  'allow.added': '✅ allow += `{pattern}`',
  'deny.added': '🚫 deny += `{pattern}`',

  // ---- /notify (quiet hours) --------------------------------------------
  'notify.statusOff': '🔔 Quiet hours: OFF\n\nUsage:\n/notify quiet 22:00-08:00\n/notify quiet off',
  'notify.statusOn':
    '🔕 Quiet hours: {start}–{end} ({tz})\n\nMessages vẫn đến nhưng không kêu trong khung giờ này.\n/notify quiet off — tắt',
  'notify.disabled': '🔔 Quiet hours disabled.',
  'notify.usage':
    'Usage: /notify quiet 22:00-08:00 [timezone]\nVí dụ: /notify quiet 23:00-07:00 Asia/Ho_Chi_Minh',
  'notify.invalidTime': '❌ Giờ không hợp lệ — hours phải 0-23, minutes 0-59.',
  'notify.invalidTz': '❌ Timezone không hợp lệ: {tz}',
  'notify.set': '🔕 Quiet hours set: {start}–{end} ({tz})\nMessages vẫn đến nhưng silent trong khung giờ này.',

  // ---- /context (pinned) ------------------------------------------------
  'context.editFile':
    '📝 Pinned context file:\n`{path}`\n\nSửa file này để đổi context inject vào prompt.',
  'context.cleared': '🗑 Đã xoá pinned context.',
  'context.noFile': 'Không tìm thấy pinned context file.',
  'context.empty':
    'Chưa có pinned context.\n\nTạo `{path}` để inject context vào mọi prompt.',
  'context.show': '📌 Pinned context ({chars} chars):\n\n{preview}',

  // ---- /send (file sharing) ---------------------------------------------
  'send.usage': 'Usage: /send <path>\nGửi file từ project về Telegram. Path relative to active project.',
  'send.errorTraversal': '❌ Path traversal không được phép — chỉ gửi file trong project.',
  'send.error': '❌ {error}',

  // ---- /screenshot ------------------------------------------------------
  'screenshot.emptyDarwin':
    '📸 screencapture failed or returned empty image.\nThường do thiếu *Screen Recording* permission.\nSystem Settings → Privacy & Security → Screen & System Audio Recording → enable binary chạy daemon (Terminal / node / launchd) → restart daemon.',
  'screenshot.emptyOther':
    '📸 capture trả về empty image — kiểm tra daemon permissions hoặc X server access.',
  'screenshot.error': 'screenshot error: {error}',

  // ---- /history ---------------------------------------------------------
  'history.searchUsage': 'Usage: /history search <query>',
  'history.searchEmpty': '🔍 Không tìm thấy kết quả cho "{query}".',
  'history.searchTitle': '🔍 Kết quả tìm kiếm "{query}":',
  'history.lastEmpty': '📋 Không có session nào trong {days} ngày qua.',
  'history.lastTitle': '📋 Sessions ({days} ngày qua): {count}',
  'history.defaultEmpty': '📋 Không có session nào trong 7 ngày qua.',
  'history.defaultTitle': '📋 Sessions (7 ngày qua): {count}',
  'history.hint': '\n\n💡 /history search <query> — tìm kiếm\n💡 /history last <N>d — xem N ngày qua',

  // ---- /cost ------------------------------------------------------------
  'cost.errorSessionNotFound': '❌ Session "{label}" không tìm thấy.',
  'cost.session':
    '💰 Cost — [{label}] ({agent})\n├ Input: {input} tokens\n├ Output: {output} tokens\n└ Total: ${total}',
  'cost.summary':
    '💰 Cost summary\n├ Today:  ${today}\n├ 7 days: ${week}\n└ 30 days: ${month}',
  'cost.breakdownTitle': '\n\n📊 Per-agent (30d):',
  'cost.breakdownEntry': '\n  {agent}: ${total} ({input} in / {output} out)',

  // ---- /timeline --------------------------------------------------------
  'timeline.errorSessionNotFound': '❌ Session "{label}" không tìm thấy.',
  'timeline.errorNoActive': 'Chưa có session active — /timeline <label> hoặc switch session trước.',
  'timeline.errorServer': '❌ Timeline server chưa khởi động.',
  'timeline.url': '📜 http://localhost:{port}/timeline/{sessionId}',

  // ---- /verify ----------------------------------------------------------
  'verify.status':
    '🔍 Auto-verify config:\n├ Enabled: {enabled}\n├ Command: `{command}`\n├ Max retries: {maxRetries}\n└ Agents: {agents}',
  'verify.agentsAll': '(all)',
  'verify.errorNoActive': 'Chưa có session active — /session new <agent> <label> [path]',
  'verify.running': '🔍 Running: `{command}`…',
  'verify.passed': '✅ Verify passed.',
  'verify.failed': '❌ Verify failed (exit {exitCode}):\n```\n{output}\n```',

  // ---- /template --------------------------------------------------------
  'template.usage.save': 'Usage: /template save <name>',
  'template.usage.run': 'Usage: /template run <name>',
  'template.usage.delete': 'Usage: /template delete <name>',
  'template.error.noActive': '❌ Chưa có session active.',
  'template.error.notFound': '❌ Template "{name}" không tìm thấy.',
  'template.saved': '✅ Đã lưu template "{name}" (agent={agent}).',
  'template.listEmpty': '📋 Chưa có template nào. Dùng /template save <name>',
  'template.listTitle': '📋 Templates:',
  'template.listEntry': '• {name} — {agent} — "{prompt}"',
  'template.created': '📍 [{label}] tạo từ template "{name}" (agent={agent})',
  'template.deleted': '🗑 Đã xoá template "{name}".',
  'template.help':
    '📋 /template commands:\n• /template save <name> — lưu session hiện tại\n• /template list — liệt kê templates\n• /template run <name> — tạo session mới từ template\n• /template delete <name> — xoá template',

  // ---- /schedule --------------------------------------------------------
  'schedule.usage.add': 'Usage: /schedule add <name> <min> <hour> <dom> <mon> <dow> <prompt>',
  'schedule.usage.delete': 'Usage: /schedule delete <name>',
  'schedule.usage.enable': 'Usage: /schedule enable <name>',
  'schedule.usage.disable': 'Usage: /schedule disable <name>',
  'schedule.error.alreadyExists': '❌ Schedule "{name}" đã tồn tại. Xoá trước rồi tạo lại.',
  'schedule.error.notFound': '❌ Schedule "{name}" không tìm thấy.',
  'schedule.added': '✅ Schedule "{name}" created\n⏰ {cron} · {agent}\n📝 {prompt}',
  'schedule.listEmpty': '📋 Chưa có schedule nào. Dùng /schedule add <name> ...',
  'schedule.listTitle': '📋 Schedules:',
  'schedule.deleted': '🗑 Đã xoá schedule "{name}".',
  'schedule.enabled': '✅ Đã bật schedule "{name}".',
  'schedule.disabled': '⏸ Đã tắt schedule "{name}".',
  'schedule.help':
    '⏰ /schedule commands:\n• /schedule add <name> <cron 5-field> <prompt>\n• /schedule list — liệt kê schedules\n• /schedule enable <name>\n• /schedule disable <name>\n• /schedule delete <name>\n\nVí dụ: /schedule add daily-test 0 9 * * * pnpm test',

  // ---- /chain -----------------------------------------------------------
  'chain.help':
    '⛓️ /chain — multi-agent pipeline\n\nSyntax: /chain agent1: prompt1 | agent2: prompt2\nToken `{{prev}}` = output bước trước.\n\nVí dụ:\n/chain claude: viết unit test cho auth.ts | kiro: review code {{prev}} và suggest fixes\n\nMax 5 steps, phân cách bằng |.',
  'chain.error': '❌ {error}',
  'chain.starting': '⛓️ Đang bắt đầu chain ({total} steps)…',
  'chain.stepDone': '⛓️ Step {step}/{total} ({agent}) xong',
  'chain.result': '⛓️ Chain result:\n\n{output}',
  'chain.empty': '⛓️ Chain xong (không có text output).',

  // ---- Attachments / voice ---------------------------------------------
  'attachment.photo.noActive':
    '📸 Nhận được ảnh nhưng không có active session — /session new <agent> <label> [path] rồi gửi lại.',
  'attachment.photo.empty': '📸 message:photo nhưng photo[] empty — không tải được.',
  'attachment.photo.downloading': '📥 [{label}] downloading photo…',
  'attachment.document.noActive':
    '📎 Nhận được file nhưng không có active session — /session new <agent> <label> [path] rồi gửi lại.',
  'attachment.document.missing': '📎 message:document nhưng document object missing — không tải được.',
  'attachment.document.downloading': '📥 [{label}] downloading {name}…',
  'voice.noActive': '🎵 Nhận được voice nhưng không có active session — /new rồi gửi lại.',
  'voice.notConfigured': '🎵 Voice-to-prompt chưa được cấu hình. Thêm OPENAI_API_KEY vào .env.',
  'voice.noFilePath': '🎵 Không lấy được file path từ Telegram.',
  'voice.downloadFailed': '🎵 Download voice thất bại ({status}).',
  'voice.preview': '🎵 "{preview}"',
  'voice.error': '🎵 Lỗi xử lý voice: {error}',

  // ---- Wizard / dispatch shared ----------------------------------------
  'dispatch.dispatching': '[{label}] dispatching…',
  'dispatch.handoffInjected': '📥 [{label}] inject handoff context ({chars} chars) vào prompt — sẽ chỉ chạy 1 lần.',
};
