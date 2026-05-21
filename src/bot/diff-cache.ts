/**
 * Per-session diff cache (Phase C.3 — bonus "[📜 Show diff]" button).
 *
 * When the user is in `thinking` or `verbose` mode, the Edit tool's
 * one-liner (`📝 Edit · foo.ts (-3 +7)`) gains a follow-up inline button
 * that reveals the actual `old_string` / `new_string` payload as a
 * MarkdownV2 ```diff fence. The payload arrives with the tool_use event;
 * the button callback fires later, possibly after the dispatch turn has
 * already closed. We need somewhere to park the diff text in between.
 *
 * Storage requirements per plan §C.3:
 *  - Keyed by `(sessionId, callId)` so concurrent edits within one turn
 *    don't collide.
 *  - TTL 15 minutes — after that the cache entry is evicted (the button
 *    becomes a no-op with a friendly message).
 *  - Per-session LRU cap of 50 entries — bounds memory on long-running
 *    sessions that produce many edits.
 *  - Per-session clear on session close (called by the session-close
 *    handler in router.ts; safe to call on unknown sessionId).
 *
 * Pure in-memory — no persistence. A daemon restart loses the cache and
 * the buttons silently degrade to the "stale" path. Acceptable trade-off:
 * persisting diffs in SQLite would 10× the DB footprint with low usage
 * value.
 *
 * Pure utility module — no Telegram imports. Consumed by the dispatcher
 * (write side, Phase C.3 wiring) and by the callback router (read side).
 */

/**
 * Entry shape stored per (sessionId, callId). `tsMs` is the insertion
 * timestamp used for TTL eviction; updated on read so the LRU
 * approximation tracks recency-of-use.
 */
interface DiffEntry {
  /** Verbatim `old_string` from the tool_use input. May be empty (pure insert). */
  old: string;
  /** Verbatim `new_string` from the tool_use input. May be empty (pure delete). */
  new: string;
  /** File path the edit applies to (for the rendered diff header). */
  filePath: string;
  /** ms-since-epoch of last touch — used for TTL + LRU eviction. */
  tsMs: number;
}

/** Default TTL: 15 minutes — long enough to span a reasonable user think time. */
export const DEFAULT_TTL_MS = 15 * 60_000;
/** Default LRU cap per session — prevents unbounded growth. */
export const DEFAULT_MAX_PER_SESSION = 50;

/**
 * In-memory cache keyed by `(sessionId, callId)`. The outer map is per-session
 * so `clearSession()` can drop a whole shard in O(1) without iterating
 * unrelated entries.
 */
export class DiffCache {
  private readonly bySession = new Map<string, Map<string, DiffEntry>>();
  private readonly ttlMs: number;
  private readonly maxPerSession: number;

  constructor(opts?: { ttlMs?: number; maxPerSession?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPerSession = opts?.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  }

  /**
   * Store a diff entry. If the per-session cap is reached, evicts the
   * OLDEST entry (smallest `tsMs`) before inserting — keeps the working
   * set bounded without a per-event sweep.
   *
   * Idempotent on duplicate `callId`: overwrites the previous entry and
   * refreshes the timestamp. Adapters may legitimately re-emit the same
   * tool_use after a retry, and we want the latest payload.
   */
  set(sessionId: string, callId: string, old: string, fresh: string, filePath: string): void {
    let shard = this.bySession.get(sessionId);
    if (!shard) {
      shard = new Map<string, DiffEntry>();
      this.bySession.set(sessionId, shard);
    }
    // Evict TTL-expired entries opportunistically — cheap O(N) over the
    // shard (N ≤ maxPerSession = 50), runs only on writes. Avoids a
    // global setInterval.
    this.sweepExpired(shard);
    if (!shard.has(callId) && shard.size >= this.maxPerSession) {
      // LRU eviction: drop entry with the smallest tsMs.
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, v] of shard) {
        if (v.tsMs < oldestTs) {
          oldestTs = v.tsMs;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) shard.delete(oldestKey);
    }
    shard.set(callId, {
      old,
      new: fresh,
      filePath,
      tsMs: Date.now(),
    });
  }

  /**
   * Retrieve a diff entry. Returns `null` when not found OR when the
   * entry exists but has expired (the entry is also deleted in that case
   * so subsequent gets return null instantly).
   *
   * On a hit, refreshes `tsMs` to keep frequently-viewed diffs from
   * being LRU-evicted under cache pressure.
   */
  get(sessionId: string, callId: string): { old: string; new: string; filePath: string } | null {
    const shard = this.bySession.get(sessionId);
    if (!shard) return null;
    const entry = shard.get(callId);
    if (!entry) return null;
    if (Date.now() - entry.tsMs > this.ttlMs) {
      shard.delete(callId);
      return null;
    }
    entry.tsMs = Date.now();
    return { old: entry.old, new: entry.new, filePath: entry.filePath };
  }

  /**
   * Drop all entries for a session. Called by the session-close handler
   * so a long-running daemon doesn't accumulate diffs for sessions the
   * user has dismissed. Safe to call with an unknown sessionId.
   */
  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /**
   * Total entry count across all sessions — diagnostic helper for tests
   * and the (future) `/dashboard` cache row. Not on the hot path.
   */
  size(): number {
    let total = 0;
    for (const shard of this.bySession.values()) total += shard.size;
    return total;
  }

  private sweepExpired(shard: Map<string, DiffEntry>): void {
    const now = Date.now();
    for (const [k, v] of shard) {
      if (now - v.tsMs > this.ttlMs) shard.delete(k);
    }
  }
}

/**
 * Module-level singleton used by the dispatcher + callback router. Tests
 * can construct their own {@link DiffCache} instead of touching this.
 */
export const diffCache = new DiffCache();

/**
 * Render a stored diff as a MarkdownV2 ```diff fenced block, suitable for
 * passing to `notifier.sendPlain(..., { parse_mode: 'MarkdownV2' })`.
 *
 * Format mimics `git diff` unified output (no hunk header — we don't have
 * line-number context for snippets that aren't full-file edits):
 *
 *   ```diff
 *   --- a/foo.ts
 *   +++ b/foo.ts
 *   -old line
 *   -old line 2
 *   +new line
 *   ```
 *
 * `old` / `new` are emitted verbatim from the LLM's tool input — they may
 * contain backticks, which are escaped per MarkdownV2 spec by
 * {@link ./markdown.ts#codeBlock}.
 */
export function renderDiffBlock(filePath: string, old: string, fresh: string): string {
  const lines: string[] = [];
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  if (old.length === 0 && fresh.length === 0) {
    // No-op edit. Caller normally shouldn't reach this code path but
    // keep the rendering defensive.
    lines.push('(no change)');
  } else {
    for (const line of old.split('\n')) lines.push('-' + line);
    for (const line of fresh.split('\n')) lines.push('+' + line);
  }
  return lines.join('\n');
}
