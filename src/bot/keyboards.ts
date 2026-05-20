import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';

/**
 * Build the inline keyboard attached to an approval prompt.
 *
 * Row layout:
 *   [✅ Allow once] [🌟 Allow always]
 *   [🚫 Deny]
 *   <extraButtons rows appended verbatim, one row per outer array>
 *
 * `extraButtons` (v0.8 §3.5) lets the caller append a session strip
 * underneath the decision buttons so the user can quick-switch sessions
 * without losing the approval context. Each inner array is a row.
 */
export function approvalKeyboard(
  requestId: string,
  extraButtons: InlineKeyboardButton[][] = [],
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('✅ Allow once', `apv:once:${requestId}`)
    .text('🌟 Allow always', `apv:always:${requestId}`)
    .row()
    .text('🚫 Deny', `apv:deny:${requestId}`);
  for (const row of extraButtons) {
    if (row.length === 0) continue;
    kb.row(...row);
  }
  return kb;
}

export function sessionPickKeyboard(items: { id: string; label: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  let count = 0;
  for (const it of items) {
    kb.text(it.label, `ses:switch:${it.id}`);
    count++;
    if (count % 2 === 0) kb.row();
  }
  return kb;
}
