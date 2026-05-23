import type { Api, Bot, Context } from 'grammy';
import type { BotCommand } from 'grammy/types';

/**
 * Slash-command menu shown to the user in Telegram private chats.
 *
 * Order matters — Telegram clients render the list verbatim. Keep this
 * synced with §4.1 of `docs/plans/ux-telegram-widgets.html`.
 *
 * Default descriptions are in Vietnamese (legacy single-language project);
 * the bilingual override below ({@link COMMANDS_EN}) is pushed per-chat
 * when the user picks `/language en`.
 */
export const COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Welcome + list session' },
  { command: 'new', description: 'Tạo session mới (wizard)' },
  { command: 'sessions', description: 'List + switch + close session' },
  { command: 'projects', description: 'List + chọn project' },
  { command: 'status', description: 'Trạng thái session active' },
  { command: 'dashboard', description: 'Live dashboard (auto-refresh 2s)' },
  { command: 'clear', description: 'Clear context của session active' },
  { command: 'handoff', description: 'Summary context → clear → inject vào prompt kế tiếp' },
  // Phase B (v1.1) — verbosity controls. /mode = per-session, /settings = chat-level.
  { command: 'mode', description: 'Đổi verbosity mode của session active' },
  { command: 'settings', description: 'Chat-level defaults (mode mặc định …)' },
  { command: 'cost', description: 'Xem chi phí API (today / 7d / 30d)' },
  { command: 'template', description: 'Lưu / chạy session template' },
  // Per-session model override
  { command: 'model', description: 'Xem/đổi model AI của session' },
  // v1.2 D2 — quiet hours
  { command: 'notify', description: 'Quiet hours — tắt notification ban đêm' },
  // v1.2 D5 — scheduled tasks
  { command: 'schedule', description: 'Lên lịch task tự động (cron)' },
  // v1.2 D6 — session search & history
  { command: 'history', description: 'Tìm kiếm session cũ' },
  // v1.2 D7 — pinned context
  { command: 'context', description: 'Xem/sửa pinned context (.telecode/context.md)' },
  // v1.2 D10 — agent chain
  { command: 'chain', description: 'Chạy multi-agent pipeline' },
  // v1.2 D11 — auto-verify
  { command: 'verify', description: 'Chạy verify command thủ công' },
  // v1.2 D8 — voice-to-prompt
  { command: 'timeline', description: 'Xem timeline của session (web)' },
  // v1.2 D1 — outbound file sharing
  { command: 'send', description: 'Gửi file từ project về Telegram' },
  { command: 'stop', description: 'Dừng task đang chạy' },
  { command: 'screenshot', description: 'Chụp desktop Mac' },
  // Bilingual UI picker — description bilingual nên cả EN + VI users đều hiểu
  // (boot push scope=all_private_chats không split per locale).
  { command: 'language', description: 'Đổi ngôn ngữ UI / Change UI language (EN / VI)' },
  { command: 'help', description: 'Hướng dẫn nhanh' },
];

/**
 * Phase v1.2 — English mirror of {@link COMMANDS}, pushed per-chat via
 * `setMyCommands({ scope: { type: 'chat', chat_id } })` whenever a user
 * sets `/language en`. Telegram caches the per-chat scope independently
 * from the bot-wide default, so a chat that picks EN sees this list while
 * other chats keep the VN one.
 *
 * Order MUST match COMMANDS exactly so users who switch back to VI don't
 * see a re-shuffled menu (Telegram clients animate menu changes; reorders
 * look like new commands appearing/disappearing).
 */
export const COMMANDS_EN: readonly BotCommand[] = [
  { command: 'start', description: 'Welcome + list sessions' },
  { command: 'new', description: 'Create a new session (wizard)' },
  { command: 'sessions', description: 'List + switch + close sessions' },
  { command: 'projects', description: 'List + pick a project' },
  { command: 'status', description: 'Active session status' },
  { command: 'dashboard', description: 'Live dashboard (auto-refresh 2s)' },
  { command: 'clear', description: "Clear the active session's context" },
  { command: 'handoff', description: 'Summarize context → clear → inject as next-prompt preamble' },
  { command: 'mode', description: 'Change verbosity mode of the active session' },
  { command: 'settings', description: 'Chat-level defaults (default mode, …)' },
  { command: 'cost', description: 'API cost (today / 7d / 30d)' },
  { command: 'template', description: 'Save / run a session template' },
  { command: 'model', description: "View / change the session's AI model" },
  { command: 'notify', description: 'Quiet hours — silence overnight notifications' },
  { command: 'schedule', description: 'Schedule automated tasks (cron)' },
  { command: 'history', description: 'Search past sessions' },
  { command: 'context', description: 'View / edit pinned context (.telecode/context.md)' },
  { command: 'chain', description: 'Run a multi-agent pipeline' },
  { command: 'verify', description: 'Run the verify command manually' },
  { command: 'timeline', description: 'Open session timeline (web)' },
  { command: 'send', description: 'Send a file from the project to Telegram' },
  { command: 'stop', description: 'Stop the running task' },
  { command: 'screenshot', description: 'Capture macOS desktop' },
  { command: 'language', description: 'Change UI language / Đổi ngôn ngữ UI (EN / VI)' },
  { command: 'help', description: 'Quick guide' },
];

/**
 * Push the slash-command list + menu button to Telegram. Idempotent —
 * Telegram replaces any previous state on each call. Safe to invoke on every
 * boot.
 *
 * - `setMyCommands` is scoped to `all_private_chats` because the bot is a
 *   single-user DM tool; groups never see these commands.
 * - `setChatMenuButton({ menu_button: { type: 'commands' } })` swaps the
 *   default "Menu" button (beside the paperclip) to open the command list
 *   above, giving the user a tap-to-discover surface in addition to typing
 *   `/`.
 *
 * No top-level side effects — only callers (e.g. boot wiring) trigger the
 * remote calls.
 */
export async function applyCommandsAndMenu<C extends Context = Context>(
  // Generic over the context flavor so callers using a custom `Bot<C>` (e.g.
  // `Bot<BotContext>` after conversations plugin installs) don't need a cast.
  // Only `bot.api` is touched — Telegram-side state, not local context type.
  bot: Bot<C, Api>,
): Promise<void> {
  await bot.api.setMyCommands(COMMANDS as BotCommand[], {
    scope: { type: 'all_private_chats' },
  });
  await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
}

/**
 * Phase v1.2 — push the locale-appropriate command list scoped to a single
 * chat. Called from the `lang:set:*` callback + from `/language` so the
 * slash menu flips to English (or back to Vietnamese) immediately after the
 * user picks.
 *
 * Telegram caches per-chat scope independently from the bot-wide default,
 * so passing the EN list with scope=`{ type: 'chat', chat_id }` overrides
 * the VN default for THAT chat alone — other chats keep VN.
 *
 * Idempotent: Telegram replaces the per-chat list on each call. Safe to
 * call repeatedly. Errors are non-fatal — caller logs + continues so a
 * Telegram hiccup doesn't break the language-switch confirmation flow.
 */
export async function pushChatCommands<C extends Context = Context>(
  bot: Bot<C, Api>,
  chatId: number,
  language: 'en' | 'vi',
): Promise<void> {
  const list = language === 'en' ? COMMANDS_EN : COMMANDS;
  await bot.api.setMyCommands(list as BotCommand[], {
    scope: { type: 'chat', chat_id: chatId },
  });
}
