/**
 * ANSI escape sequence stripping helpers (Phase A.3).
 *
 * Extracted from {@link ../agents/kiro.ts} so other adapters can share the
 * same behaviour. Kept as pure functions (no module-level state) — safe to
 * call concurrently from streaming hot paths.
 *
 * The two regexes cover what we actually see from CLIs Telecode talks to:
 *
 *   - {@link ANSI_RE}              — CSI / SGR sequences emitted by tools that
 *                                    colourise their output (gcc, npm, cargo,
 *                                    pytest, …). Matches `ESC [ … letter`.
 *   - {@link CURSOR_HIDE_SHOW_RE}  — `ESC [ ? 25 h|l` (DECTCEM show/hide cursor).
 *                                    Emitted by progress spinners (npm,
 *                                    spinners.js, etc) — would otherwise
 *                                    survive a generic SGR strip because the
 *                                    terminating char is `h`/`l` not a letter
 *                                    in the SGR range.
 *
 * NOT exhaustive (we don't strip OSC `ESC ]…BEL`, DCS, or 8-bit single-shifts)
 * because the four adapters we ship don't emit them. Add patterns here if a
 * future CLI does — keep the helper pure.
 */
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const CURSOR_HIDE_SHOW_RE = /\x1b\[\?25[hl]/g;

/**
 * Strip ANSI escape sequences from a string. Idempotent; returns the input
 * unchanged when no escapes are present (which is the hot-path case for
 * adapters that already emit clean text).
 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(CURSOR_HIDE_SHOW_RE, '');
}

/** Exported for tests that want to assert against the underlying patterns. */
export const _internals = { ANSI_RE, CURSOR_HIDE_SHOW_RE };
