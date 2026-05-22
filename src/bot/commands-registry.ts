import type { Api, Bot, Context } from 'grammy';
import type { BotCommand } from 'grammy/types';

/**
 * Slash-command menu shown to the user in Telegram private chats.
 *
 * Order matters — Telegram clients render the list verbatim. Keep this
 * synced with §4.1 of `docs/plans/ux-telegram-widgets.html`.
 *
 * Descriptions are in Vietnamese (single-user, single-language project).
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
  { command: 'help', description: 'Hướng dẫn nhanh' },
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
