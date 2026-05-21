import type { InlineKeyboardButton } from 'grammy/types';

/**
 * Follow-up suggestion buttons appended underneath agent tool/result events.
 * Plan P0.3 (Tier-3 #7): after a tool finishes, surface 2-3 inline actions
 * the user might want next so they don't have to type. Pure heuristic — no
 * extra LLM call — keyed off the tool name + exit signal.
 *
 * Callback data scheme (consumed in src/bot/router.ts):
 *
 *  - `suggest:continue:<sessionId>`         → user wants the agent to keep
 *                                              going. Posts a short "tiếp tục"
 *                                              prompt to the session via the
 *                                              plain-text dispatch path.
 *  - `suggest:run-again:<sessionId>`        → re-run the last command.
 *  - `suggest:rollback:<sessionId>`         → ask the agent to revert.
 *  - `suggest:view-file:<sessionId>:<path>` → hint to /open <path> (path may
 *                                              contain ':' on Windows; the
 *                                              router joins remaining parts).
 *  - `suggest:summarize:<sessionId>`        → trigger /handoff-style summary.
 *
 * All callbacks fit < 64 bytes for sessionId=36 + path<25 chars; paths
 * longer than that are truncated (caller's responsibility — `buildSuggestions`
 * skips view-file if path exceeds budget).
 */

export interface SuggestionEvent {
  /** Tool name as emitted by the adapter (case-sensitive — Bash, fs_write, …). */
  toolName: string;
  /**
   * 0 = success, non-zero = failure. `null` when the event is not a
   * command-style tool (no exit code semantics — e.g. fs_read, web_fetch).
   */
  exitCode?: number | null;
  /** File path the tool touched, when applicable (fs_write / fs_read). */
  filePath?: string | null;
  /** Session the suggestions should target. */
  sessionId: string;
}

/**
 * Telegram caps callback_data at 64 bytes. We use the full budget here —
 * callers never embed user-provided text (paths are the only variable, and
 * the overflow guard drops the button rather than crashing).
 */
const CALLBACK_BUDGET = 64;

function btn(text: string, data: string): InlineKeyboardButton | null {
  // Skip silently when the data string would overflow Telegram's 64-byte cap.
  // Telegram will REJECT the message if any single callback_data exceeds the
  // cap — fail-soft is the safer UX here (button just doesn't render).
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_BUDGET) return null;
  return { text, callback_data: data };
}

/**
 * Heuristic mapping from a tool event to a single row of follow-up buttons.
 * Returns an empty array when no suggestion fits — callers should treat that
 * as "no extras row" rather than emit an empty row (Telegram silently drops
 * empty rows but the keyboard still bloats by one).
 *
 * Decision matrix (kept simple — easy to extend later):
 *   fs_write success → [Xem file] [Tiếp tục] [Rollback]
 *   fs_write fail    → [Tiếp tục]
 *   execute_bash/Bash success → [Tiếp tục] [Run again]
 *   execute_bash/Bash fail    → [Tiếp tục] [Run again]
 *   default          → [Tiếp tục]
 */
export function buildSuggestions(ev: SuggestionEvent): InlineKeyboardButton[] {
  const sid = ev.sessionId;
  const tool = ev.toolName;
  const row: InlineKeyboardButton[] = [];
  const push = (b: InlineKeyboardButton | null): void => {
    if (b) row.push(b);
  };

  if (tool === 'fs_write' || tool === 'Write' || tool === 'Edit') {
    if (ev.filePath) {
      // Encode the path raw — callback_router splits on ':' but uses
      // .slice(2).join(':') for payload, so paths with colons round-trip.
      push(btn('📄 Xem file', `suggest:view-file:${sid}:${ev.filePath}`));
    }
    push(btn('▶️ Tiếp tục', `suggest:continue:${sid}`));
    if ((ev.exitCode ?? 0) === 0) {
      push(btn('↩️ Rollback', `suggest:rollback:${sid}`));
    }
    return row;
  }

  if (tool === 'execute_bash' || tool === 'Bash' || tool === 'shell') {
    push(btn('▶️ Tiếp tục', `suggest:continue:${sid}`));
    push(btn('🔁 Run again', `suggest:run-again:${sid}`));
    return row;
  }

  // Default fallback for any other tool. Keep it minimal — a single
  // "continue" hint is enough; surfacing more would be noise.
  push(btn('▶️ Tiếp tục', `suggest:continue:${sid}`));
  return row;
}

/**
 * User-facing hint text emitted when a suggestion callback fires. Returned
 * (instead of sent here) so the caller can route through their own bot.api
 * — keeps this module dependency-free for testing.
 */
export function suggestionAck(action: string): string {
  switch (action) {
    case 'continue':
      return '▶️ Gõ "tiếp tục" hoặc prompt mới để agent đi tiếp.';
    case 'run-again':
      return '🔁 Gõ "run again" hoặc lặp lại lệnh để chạy lại.';
    case 'rollback':
      return '↩️ Gõ prompt yêu cầu agent rollback thay đổi gần nhất.';
    case 'view-file':
      return '📄 Gõ "show <path>" hoặc dùng /screenshot để xem.';
    case 'summarize':
      return '📝 Dùng /handoff để summarize + clear context.';
    default:
      return '(unknown suggestion)';
  }
}
