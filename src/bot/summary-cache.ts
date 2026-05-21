/**
 * Phase D — Summary cache (shared by D.2 / D.3 / D.5).
 *
 * Maps Telegram `messageId` → full text content that was summarized (auto
 * via D.2, or about-to-be summarized via D.3) so the on-demand buttons can:
 *
 *   - [💬 AI summary]    — D.3 — read full content, re-inject summarize.
 *   - [📜 Full output]   — D.5 — read full content, send as code-fenced.
 *   - [💬 Re-summarize]  — also D.3 — same code path; cache key is the
 *     message id of the auto-summarize result message.
 *
 * Storage:
 *
 *   - In-memory only (transient — daemon restart loses cache, buttons
 *     gracefully degrade with a "Diff hết cache" style hint).
 *   - LRU per-process cap of 100 entries (configurable for tests). Older
 *     entries get evicted on insert when the cap is reached.
 *   - TTL 1 hour — entries past TTL return null on `get` and are deleted
 *     opportunistically.
 *   - Session ownership tracked per-entry so the router callback can
 *     verify chat ownership without doing a DB lookup (mirrors diff-cache
 *     security pattern from Phase C senior review [P1]).
 *
 * No global timer. TTL sweep runs opportunistically on writes.
 *
 * Pure utility module — no Telegram imports.
 */

/** Default TTL: 1 hour — long enough to span a casual user session. */
export const DEFAULT_SUMMARY_TTL_MS = 60 * 60 * 1_000;
/** Default LRU cap — bounds memory use on a long-running daemon. */
export const DEFAULT_SUMMARY_MAX = 100;

interface SummaryEntry {
  /**
   * Full raw text that was (or will be) summarized. For D.2 this is the
   * un-truncated `tool_result.preview` (capped by the adapter at 240 chars
   * for the EVENT, but D.2 caches BEFORE the trim path — so this carries
   * the full preview text). For D.5 this is the same value.
   */
  fullText: string;
  /**
   * Tool name (Read / Bash / Edit / …) — used to render the "Bash · npm test"
   * style header on the [📜 Full output] reply. Pre-collapsed via
   * `friendlyToolLabel` at insert time so the cache stores the user-facing
   * label, not the raw adapter id.
   */
  toolLabel: string;
  /** Session that owns this message. Used for chat-ownership check. */
  sessionId: string;
  /** ms-since-epoch of last touch — TTL + LRU eviction key. */
  tsMs: number;
}

export class SummaryCache {
  private readonly entries = new Map<number, SummaryEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_SUMMARY_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_SUMMARY_MAX;
  }

  /**
   * Store a (messageId → fullText, toolLabel, sessionId) mapping. Idempotent
   * on duplicate `messageId` — overwrites + refreshes timestamp. Evicts the
   * oldest entry on capacity overflow.
   */
  set(
    messageId: number,
    fullText: string,
    toolLabel: string,
    sessionId: string,
  ): void {
    // Sweep expired entries opportunistically. Cheap O(N) over the cache,
    // runs only on writes (no global timer pinning the process alive).
    this.sweepExpired();
    if (!this.entries.has(messageId) && this.entries.size >= this.maxEntries) {
      // LRU eviction: drop the entry with the smallest tsMs.
      let oldestKey: number | null = null;
      let oldestTs = Infinity;
      for (const [k, v] of this.entries) {
        if (v.tsMs < oldestTs) {
          oldestTs = v.tsMs;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) this.entries.delete(oldestKey);
    }
    this.entries.set(messageId, {
      fullText,
      toolLabel,
      sessionId,
      tsMs: Date.now(),
    });
  }

  /**
   * Retrieve a cached entry. Returns `null` when not found OR when the entry
   * has expired (the entry is also deleted in that case). Refreshes `tsMs`
   * on hit so frequently-tapped messages survive LRU pressure.
   */
  get(messageId: number): SummaryEntry | null {
    const e = this.entries.get(messageId);
    if (!e) return null;
    if (Date.now() - e.tsMs > this.ttlMs) {
      this.entries.delete(messageId);
      return null;
    }
    e.tsMs = Date.now();
    return e;
  }

  /**
   * Drop all entries for a session. Called by the session-close handler so a
   * long-running daemon doesn't accumulate entries for closed sessions.
   * Safe to call with an unknown sessionId.
   */
  clearSession(sessionId: string): void {
    for (const [k, v] of this.entries) {
      if (v.sessionId === sessionId) this.entries.delete(k);
    }
  }

  /** Total entry count — diagnostic helper for tests. */
  size(): number {
    return this.entries.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (now - v.tsMs > this.ttlMs) this.entries.delete(k);
    }
  }
}

/**
 * Process-wide singleton. Tests can instantiate their own {@link SummaryCache}
 * or call {@link _resetSummaryCache} between cases.
 */
export let summaryCache: SummaryCache = new SummaryCache();

/** Reset the singleton for tests. Production code does NOT call this. */
export function _resetSummaryCache(opts?: { ttlMs?: number; maxEntries?: number }): void {
  summaryCache = new SummaryCache(opts);
}
