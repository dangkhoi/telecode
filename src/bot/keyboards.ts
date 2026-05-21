import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import {
  MODE_METADATA,
  VERBOSITY_MODES,
  type VerbosityMode,
} from '../session/verbosity.js';

/**
 * Build the inline keyboard attached to an approval prompt.
 *
 * Row layout:
 *   [✅ Allow once] [🌟 Allow always]
 *   [📌 Forever]    [🚫 Deny]
 *   <extraButtons rows appended verbatim, one row per outer array>
 *
 * `[📌 Forever]` (plan P0.4) emits `apv:forever-init:<id>` — the router
 * pivots the message into a 2-step confirm flow before persisting a
 * `policy.yaml` allow rule. We keep the click distinct from `🌟 Allow always`
 * (the session-scoped variant) so users can choose persistence explicitly.
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
    .text('📌 Forever', `apv:forever-init:${requestId}`)
    .text('🚫 Deny', `apv:deny:${requestId}`);
  for (const row of extraButtons) {
    if (row.length === 0) continue;
    kb.row(...row);
  }
  return kb;
}

/**
 * 2-step confirm keyboard shown after the user taps `[📌 Forever]`. Replaces
 * the original 4-button approval keyboard via `editMessageReplyMarkup`.
 *
 * Layout:
 *   [✅ Xác nhận] [❌ Hủy]
 *
 * Callback data:
 *   - `apv:forever-confirm:<id>` → persist + resolve as allow_always
 *   - `apv:forever-cancel:<id>`  → restore the original 4-button keyboard
 */
export function approvalForeverConfirmKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Xác nhận', `apv:forever-confirm:${requestId}`)
    .text('❌ Hủy', `apv:forever-cancel:${requestId}`);
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

/**
 * Phase C.3 — single-button inline keyboard for the `[📜 Show diff]` reveal
 * attached to Edit-family tool_use messages in thinking/verbose modes. The
 * callback data carries the session id + the per-call diff cache key the
 * dispatcher minted at tool_use time.
 *
 * Keyboard layout: one row, one button. Callers can compose this with other
 * rows (e.g. the suggestion strip) by reading `inline_keyboard` off the
 * returned object — but typically the integration just constructs an inline
 * keyboard with `kb.text(...)` directly to combine rows cleanly. This helper
 * exists for tests + the diff-show callback test seam.
 */
export function diffShowButton(sessionId: string, callId: string): InlineKeyboard {
  return new InlineKeyboard().text('📜 Show diff', `diff:show:${sessionId}:${callId}`);
}

/**
 * 4-button inline keyboard for the /mode or /settings flow (plan §B.3).
 *
 * Layout (2×2 so iOS portrait doesn't wrap mid-row):
 *   [🎯 Summary]  [📝 Normal]
 *   [🧠 Thinking] [🔬 Verbose]
 *
 * Callback namespace is parameterised so the same builder serves both:
 *   /mode      → `mode:set:<name>`         (session-scoped)
 *   /settings  → `settings:mode:<name>`    (chat-default)
 *
 * The currently-effective mode is highlighted with a leading `●` so the user
 * can spot it without scrolling. We avoid disabling the button (Telegram has
 * no native disabled state for inline buttons) — re-tapping the current mode
 * is a harmless no-op.
 */
export function verbosityModeKeyboard(
  callbackPrefix: 'mode:set' | 'settings:mode',
  current: VerbosityMode,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < VERBOSITY_MODES.length; i++) {
    const mode = VERBOSITY_MODES[i]!;
    const meta = MODE_METADATA[mode];
    const marker = mode === current ? '● ' : '';
    kb.text(`${marker}${meta.icon} ${meta.displayName}`, `${callbackPrefix}:${mode}`);
    // Insert a row break between pairs but NOT after the last button — a
    // trailing .row() would emit an empty 3rd row in the inline_keyboard
    // array (cosmetically harmless but breaks shape assertions).
    if (i % 2 === 1 && i < VERBOSITY_MODES.length - 1) kb.row();
  }
  return kb;
}
