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
  { command: 'sessions', description: 'List + switch session' },
  { command: 'projects', description: 'List + chọn project' },
  { command: 'status', description: 'Trạng thái session active' },
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
