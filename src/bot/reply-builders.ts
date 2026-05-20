import { Keyboard, InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';

/**
 * Common payload returned by reply builders. Handlers spread `reply_markup`
 * (+ optional `parse_mode`) into a `ctx.reply` / `bot.api.sendMessage` call.
 *
 * Builders are **pure functions** — no I/O, no logger, no bot reference. This
 * keeps them trivially testable and allows reuse from T3 features (follow-up
 * suggestions, dashboards) without rework.
 */
export interface ReplyPayload {
  text: string;
  reply_markup: InlineKeyboard;
  parse_mode?: 'Markdown' | 'HTML';
}

/**
 * 6-button persistent reply keyboard (Tier 1 §4.2 of plan). Layout:
 *
 * ```
 * [📋 Sessions] [📁 Projects]
 * [📊 Status]   [🛑 Stop]
 * [📸 Screen]   [❓ Help]
 * ```
 *
 * Properties:
 * - `resize_keyboard = true` — minimize height on supported clients.
 * - `is_persistent = true` — keyboard stays visible (Telegram Desktop ≥ 4.6).
 *   Older clients gracefully degrade to non-persistent.
 *
 * Match the emoji-prefixed text in a separate `keyboard-actions.ts` map so
 * accidental user typing of "Sessions" (no emoji) does not trigger commands.
 */
export function buildPersistentKeyboard(): Keyboard {
  return new Keyboard()
    .text('📋 Sessions').text('📁 Projects').row()
    .text('📊 Status').text('🛑 Stop').row()
    .text('📸 Screen').text('❓ Help')
    .resized()
    .persistent();
}

/**
 * Remove the persistent reply keyboard. Used when entering a wizard
 * (multi-step input) to prevent users tapping a keyboard button by accident
 * mid-flow. Restore via {@link buildPersistentKeyboard} on wizard exit.
 *
 * Returned shape matches Telegram's `ReplyKeyboardRemove` markup — pass
 * directly as `reply_markup`.
 */
export function removeKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true as const };
}

// ---------------------------------------------------------------------------
// Session list (§5.3)
// ---------------------------------------------------------------------------

export interface SessionListItem {
  id: string;
  label: string;
  agent: 'claude' | 'kiro';
  /** unix ms timestamp of last activity (e.g. `SessionRow.updated_at`). */
  updatedAt: number;
  status: string;
}

const AGENT_ICON: Record<SessionListItem['agent'], string> = {
  claude: '🤖',
  kiro: '⚡',
};

/**
 * Convert a millisecond timestamp into a short human-readable relative time.
 * Boundaries:
 *   - `< 60s`              → `"just now"`
 *   - `< 60m`              → `"Xm ago"` (rounded down)
 *   - `< 24h`              → `"Xh ago"` (rounded down)
 *   - `>= 24h`             → `"Xd ago"` (rounded down)
 *   - future timestamps     → `"just now"` (defensive — clock skew)
 *
 * `now` is overridable for deterministic tests.
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Build the `/sessions` list reply (Tier 2 §5.3):
 *
 * Text format:
 * ```
 * 📋 Sessions (N):
 * ● refactor-auth · 🤖 · 2m ago
 *   debug-api    · 🤖 · 1h ago
 *   mobile-ui    · ⚡ · 3h ago
 * ```
 * - Active session prefixed with `●`, inactive lines get two spaces (`  `) so
 *   labels align visually.
 *
 * Inline keyboard:
 * - 3 buttons per session — `[label]` → `session:switch:<uuid>`,
 *   `[🤝]` → `session:handoff:<uuid>` (summarize + clear context),
 *   `[🗑]` → `session:close:<uuid>` (close session). All callbacks are well
 *   under the 64-byte Telegram limit (longest = `session:handoff:` 16 + UUID
 *   36 = 52 bytes).
 * - Trailing row: `[➕ New session]` → `wizard:new-start`.
 * - `extraButtons` rows appended after the new-session row (T3 hook).
 *
 * @param sessions     Sessions ordered newest-first by the caller.
 * @param activeId     Currently active session id (or `null`).
 * @param extraButtons Optional rows appended after `[+ New session]`.
 * @param now          Override "now" for deterministic relative-time strings.
 */
export function buildSessionList(
  sessions: SessionListItem[],
  activeId: string | null,
  extraButtons: InlineKeyboardButton[][] = [],
  now: number = Date.now(),
): ReplyPayload {
  const lines: string[] = [`📋 Sessions (${sessions.length}):`];
  for (const s of sessions) {
    const marker = s.id === activeId ? '●' : '  ';
    const icon = AGENT_ICON[s.agent];
    lines.push(`${marker} ${s.label} · ${icon} · ${relativeTime(s.updatedAt, now)}`);
  }

  const kb = new InlineKeyboard();
  let first = true;
  for (const s of sessions) {
    if (!first) kb.row();
    kb.text(s.label, `session:switch:${s.id}`)
      .text('🤝', `session:handoff:${s.id}`)
      .text('🗑', `session:close:${s.id}`);
    first = false;
  }
  if (!first) kb.row();
  kb.text('➕ New session', 'wizard:new-start');
  for (const row of extraButtons) {
    kb.row(...row);
  }

  return { text: lines.join('\n'), reply_markup: kb };
}

// ---------------------------------------------------------------------------
// Catch-up message splitting (v0.8 §7 risk register: P2 — Telegram 4096 limit)
// ---------------------------------------------------------------------------

/**
 * Hard cap kept slightly under the notifier's `MAX_MSG_CHARS` (3500) so the
 * notifier never has to clip a part of a split catch-up. Telegram's actual
 * limit is 4096 chars per message.
 */
const CATCHUP_MAX_CHARS = 3400;

/**
 * Split a long catch-up payload into one-or-more Telegram-safe message bodies.
 *
 * The buffer can hold up to ~50KB (default cap), which when joined into a
 * single string overflows Telegram's per-message 4096-char limit and would
 * otherwise be silently clipped by `Notifier.sendPlain`. We split at line
 * boundaries when possible (keeping events together), falling back to a hard
 * char cut when a single line exceeds the cap.
 *
 * The header is included only on the first part; subsequent parts get a short
 * `[label] 📥 catch-up (cont.):` continuation header so the user knows the
 * message belongs to the same logical catch-up.
 *
 * @param header        Already-rendered first-part header (e.g.
 *                      `"[A] 📥 catch-up (5 events from background):"`).
 * @param contHeader    Short continuation header for parts ≥ 2.
 * @param lines         The event-data strings (one per buffered event), in
 *                      arrival order.
 * @param maxChars      Override the per-message cap (default 3400). Tests use
 *                      smaller values to force splits.
 */
export function splitCatchUp(
  header: string,
  contHeader: string,
  lines: string[],
  maxChars: number = CATCHUP_MAX_CHARS,
): string[] {
  if (lines.length === 0) return [];
  const parts: string[] = [];
  let current = header;
  let hasContent = false; // true once a line (or slice) has been appended to current

  const flush = (): void => {
    if (!hasContent) return;
    parts.push(current);
    current = contHeader;
    hasContent = false;
  };

  for (const raw of lines) {
    // A single line longer than `maxChars` is rare but possible (e.g. a tool
    // output blob). Hard-split it into chunks small enough to fit on their
    // own, prefixed with the appropriate header.
    let remaining = raw;
    while (remaining.length > 0) {
      // Space available in `current` to append `\n + slice`.
      // We use `\n` to separate the header from the first line and successive
      // lines from each other, so every appended chunk costs 1 extra char.
      const available = maxChars - current.length - 1;
      if (available <= 0) {
        if (hasContent) {
          // No room left — flush and try again with a fresh continuation
          // header (which is shorter, so more room becomes available).
          flush();
          continue;
        }
        // Pathological: `maxChars` is so small that even the header alone
        // leaves no room for a single character. Force-append 1 char so we
        // always make progress and never loop forever. The resulting message
        // overshoots the cap by however much the header exceeds maxChars-2 —
        // acceptable; caller's cap was unrealistic.
        current = `${current}\n${remaining.slice(0, 1)}`;
        remaining = remaining.slice(1);
        hasContent = true;
        flush();
        continue;
      }
      const take = Math.min(available, remaining.length);
      current = `${current}\n${remaining.slice(0, take)}`;
      remaining = remaining.slice(take);
      hasContent = true;
      // If we still have remaining payload, the slice exactly filled the
      // available room → flush and continue with the rest in a new part.
      if (remaining.length > 0) flush();
    }
  }
  // Push any tail that wasn't flushed yet.
  if (hasContent) parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------
// Session strip (v0.8 §3.4) — quick-switch inline keyboard
// ---------------------------------------------------------------------------

export interface SessionStripOptions {
  /** 1-indexed page number. Defaults to `1`. */
  page?: number;
  /** Sessions per page. Defaults to `4`. */
  perPage?: number;
}

/**
 * Build an inline `[s1] [● s2] [s3] [+ New]` quick-switch strip appended to
 * critical messages (approval, error, done) so the user can jump between
 * sessions without opening `/sessions`.
 *
 * Layout rules (v0.8 plan §3.4):
 * - Empty sessions    → single `[➕ New session]` row.
 * - `≤ perPage`       → row 1 = all session buttons; row 2 = `[➕ New session]`.
 * - `> perPage`       → row 1 = current page slice (≤ perPage buttons);
 *                       row 2 = `[← Prev] [Next →] [➕ New]`.
 *                       At a boundary the unavailable nav button is replaced
 *                       with a disabled-looking spacer (no-op callback) so the
 *                       row keeps a stable shape.
 *
 * Active session: prefix label with `●` (e.g. `● refactor-auth`).
 * Inactive: label only.
 *
 * Callback data (all verified < 64 bytes for realistic 36-char uuids):
 * - session button: `session:switch:<uuid>`   (reuses existing handler)
 * - pagination:     `session:strip-page:<n>`  (1-indexed)
 * - new session:    `wizard:new-start`        (reuses existing wizard)
 *
 * Page clamping: requested page is clamped to `[1, totalPages]` so callers
 * never crash on stale callback data. Returns a 2-D button array (not an
 * `InlineKeyboard` instance) so it can be passed as `extraButtons` to
 * {@link buildSessionList} / {@link buildProjectList} or spread directly into
 * an `inline_keyboard` field.
 */
export function buildSessionStrip(
  sessions: SessionListItem[],
  activeId: string | null,
  opts: SessionStripOptions = {},
): InlineKeyboardButton[][] {
  const perPage = opts.perPage ?? 4;
  const total = sessions.length;

  // Empty list: only [+ New session].
  if (total === 0) {
    return [[{ text: '➕ New session', callback_data: 'wizard:new-start' }]];
  }

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const requestedPage = opts.page ?? 1;
  const page = Math.min(totalPages, Math.max(1, requestedPage));
  const start = (page - 1) * perPage;
  const end = Math.min(total, start + perPage);
  const slice = sessions.slice(start, end);

  const sessionRow: InlineKeyboardButton[] = slice.map((s) => ({
    text: s.id === activeId ? `● ${s.label}` : s.label,
    callback_data: `session:switch:${s.id}`,
  }));

  const controlRow: InlineKeyboardButton[] = [];
  if (totalPages > 1) {
    // Keep a stable [Prev | Next | New] shape; replace unavailable nav with
    // a no-op spacer so the row doesn't reflow as the user paginates.
    controlRow.push(
      page > 1
        ? { text: '← Prev', callback_data: `session:strip-page:${page - 1}` }
        : { text: '·', callback_data: 'session:strip-page:noop' },
    );
    controlRow.push(
      page < totalPages
        ? { text: 'Next →', callback_data: `session:strip-page:${page + 1}` }
        : { text: '·', callback_data: 'session:strip-page:noop' },
    );
    // Short label when paginated to keep the 3-button row visually compact.
    controlRow.push({ text: '➕ New', callback_data: 'wizard:new-start' });
  } else {
    // No pagination → use the longer "New session" label for clarity.
    controlRow.push({ text: '➕ New session', callback_data: 'wizard:new-start' });
  }

  return [sessionRow, controlRow];
}

// ---------------------------------------------------------------------------
// Project list (§5.2)
// ---------------------------------------------------------------------------

export interface ProjectListItem {
  id: number;
  name: string;
  path: string;
}

export interface BuildProjectListOptions {
  /** 1-indexed page number. Defaults to `1`. */
  page?: number;
  /** Projects per page. Defaults to `8`. */
  perPage?: number;
  /**
   * Currently active project id for the chat. The matching row gets a `●`
   * prefix on its label. Pass `null` / omit when no project is active.
   */
  activeId?: number | null;
  /** Extra rows appended after the (optional) pagination row. */
  extraButtons?: InlineKeyboardButton[][];
}

/**
 * Shorten a filesystem path for display by collapsing the user home segment
 * and keeping only the last 2 path components: `/Users/x/y/z` → `…/y/z`.
 * Pure formatting — does not touch the filesystem.
 */
function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * Build the `/projects` picker reply (Tier 2 §5.2).
 *
 * Text format:
 * ```
 * 📁 Projects (N):
 * • telecode · …/workspaces/telecode
 * • api-service · …/workspaces/api
 * ```
 *
 * Inline keyboard:
 * - 1 button per project (one per row), label = project name. The currently
 *   active project gets a `●` prefix (e.g. `● telecode`). Callback
 *   `project:cd:<id>` → switch active project for the chat.
 *   Integer `project_id` keeps callback_data ≤ ~25 bytes (well below 64).
 *   The previous `[📍 Switch] [➕ New]` two-button layout was removed in the
 *   post-v0.8 UX revision — users couldn't tell which row belonged to which
 *   project, and the per-row "New" button duplicated the `/new` wizard's
 *   project picker. To create a session for a specific project, use `/new`
 *   and pick the project in step 2.
 * - When `total > perPage`, a pagination nav row is added:
 *   `[← Prev] [page x/y] [Next →]` with callbacks `project:page:<n>` and a
 *   no-op `project:page:current` on the page indicator.
 * - `extraButtons` rows appended after the nav row.
 *
 * Out-of-range `page` clamps to `[1, totalPages]`.
 */
export function buildProjectList(
  projects: ProjectListItem[],
  opts: BuildProjectListOptions = {},
): ReplyPayload {
  const perPage = opts.perPage ?? 8;
  const total = projects.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const requestedPage = opts.page ?? 1;
  const page = Math.min(totalPages, Math.max(1, requestedPage));
  const start = (page - 1) * perPage;
  const end = Math.min(total, start + perPage);
  const slice = projects.slice(start, end);
  const activeId = opts.activeId ?? null;

  const lines: string[] = [`📁 Projects (${total}):`];
  for (const p of slice) {
    const marker = p.id === activeId ? '● ' : '';
    lines.push(`• ${marker}${p.name} · ${shortenPath(p.path)}`);
  }
  if (total === 0) {
    lines.push('(no projects registered yet — use /add <path> [name])');
  }

  const kb = new InlineKeyboard();
  let first = true;
  for (const p of slice) {
    if (!first) kb.row();
    const label = p.id === activeId ? `● ${p.name}` : p.name;
    kb.text(label, `project:cd:${p.id}`);
    first = false;
  }

  if (totalPages > 1) {
    kb.row();
    if (page > 1) {
      kb.text('← Prev', `project:page:${page - 1}`);
    }
    kb.text(`page ${page}/${totalPages}`, 'project:page:current');
    if (page < totalPages) {
      kb.text('Next →', `project:page:${page + 1}`);
    }
  }

  for (const row of opts.extraButtons ?? []) {
    kb.row(...row);
  }

  return { text: lines.join('\n'), reply_markup: kb };
}
