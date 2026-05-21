/**
 * Per-session pending-tool tracker (Phase A.5).
 *
 * v1.0 dispatch attached the follow-up "suggestion" inline keyboard to the
 * `tool_use` message at the moment the call STARTED — before the user could
 * possibly know whether the call succeeded. With v1.1 we surface
 * `tool_result` events too (Phase A.2), so the suggestion row now belongs on
 * the RESULT message, not the use-message.
 *
 * This module tracks tool_use messages that haven't yet been resolved by a
 * matching tool_result. Two surfaces use it:
 *
 *   1. Dispatch tool_use branch — register a pending entry, start a 2-second
 *      defer timer. If no tool_result arrives within the window (Claude's
 *      adapter for instance does not emit tool_result yet — fix deferred to
 *      a future phase), the timer fires, retrofits the suggestion row to the
 *      original message, and removes the entry. This preserves the v1.0 UX
 *      for adapters that never emit tool_result, so nothing regresses.
 *
 *   2. Dispatch tool_result branch — look up the most recent pending entry
 *      whose tool name matches, clear its timer, render the suggestion row
 *      on the result message (or edit the use-message in-place), drop the
 *      entry. Correlation is by tool-name + insertion order (LIFO) because
 *      no adapter exposes a stable call-id we could thread end-to-end.
 *
 * State is per-session; sessions are isolated. When a session closes the
 * caller should invoke {@link PendingTools.clear} so any orphan timers stop.
 */

/**
 * Single pending tool entry. The caller supplies whatever info it needs to
 * later render the suggestion row (we don't bake the row format in here so
 * the module stays UI-agnostic and easy to test).
 *
 * Senior-review (Opus 4.7) [P1] race fix: `messageId` is now `number | null`.
 * Callers that send the tool_use announcement via an async `sendPlain` use
 * {@link PendingTools.addPending} which enqueues the entry SYNCHRONOUSLY
 * (with `messageId=null`) and resolves the id once the send completes via
 * {@link messageReady}. This eliminates the window where a fast `tool_result`
 * raced ahead of the pending registration and orphaned the use-message.
 */
export interface PendingTool<T> {
  /** Tool name as emitted by the adapter (`Read`, `Bash`, `codex.exec`, …). */
  toolName: string;
  /**
   * Telegram message id of the tool_use announcement. `null` while the send
   * is still in flight (entries registered via {@link PendingTools.addPending}).
   * Resolved synchronously for entries registered via {@link PendingTools.add}.
   */
  messageId: number | null;
  /**
   * Resolves with the eventual message id (or `null` when the send failed).
   * Awaiting this lets `resolve()` consumers safely edit the message even when
   * the tool_result arrived before the send completed.
   */
  messageReady: Promise<number | null>;
  /** Caller-defined extra data (suggestion row keyboard, file path, …). */
  payload: T;
  /** Insertion timestamp (ms). Used by the test seam. */
  createdAt: number;
  /** Timeout handle for the fallback retrofit. */
  timer: NodeJS.Timeout | null;
}

export interface PendingToolsOpts<T> {
  /**
   * Defer window in milliseconds. After this many ms with no matching
   * tool_result, {@link onTimeout} fires for the entry and the entry is
   * removed. Default 2000 (plan §A.5).
   */
  deferMs?: number;
  /**
   * Invoked when the defer timer fires (no tool_result arrived in time).
   * Caller should retrofit the suggestion row on the original message.
   */
  onTimeout: (entry: PendingTool<T>) => void;
}

export class PendingTools<T = unknown> {
  private readonly entries: PendingTool<T>[] = [];
  private readonly deferMs: number;
  private readonly onTimeout: (entry: PendingTool<T>) => void;

  constructor(opts: PendingToolsOpts<T>) {
    this.deferMs = opts.deferMs ?? 2_000;
    this.onTimeout = opts.onTimeout;
  }

  /**
   * Register a tool_use as pending. Starts the defer timer immediately.
   * Returns the created entry so the caller can inspect/test it.
   */
  add(toolName: string, messageId: number, payload: T): PendingTool<T> {
    const entry: PendingTool<T> = {
      toolName,
      messageId,
      messageReady: Promise.resolve(messageId),
      payload,
      createdAt: Date.now(),
      timer: null,
    };
    entry.timer = setTimeout(() => {
      // Remove from the queue first so a racing `resolve` for the same name
      // doesn't double-handle the entry.
      this.removeEntry(entry);
      try {
        this.onTimeout(entry);
      } catch {
        /* swallow — caller-provided callback must not crash the queue */
      }
    }, this.deferMs);
    this.entries.push(entry);
    return entry;
  }

  /**
   * Senior-review (Opus 4.7) [P1] — race-safe pending registration.
   *
   * Like {@link add} but accepts a `sendPromise` that will eventually resolve
   * with the message id. The entry is enqueued SYNCHRONOUSLY (the resolve()
   * path can see it before the send completes), and the defer timer only
   * starts once the send resolves — so the fallback never fires for a
   * never-existed message.
   *
   * If the send fails (`sendPromise` resolves to `null` or rejects), the
   * entry is silently removed: the caller's onTimeout would have nothing to
   * retrofit anyway.
   */
  addPending(
    toolName: string,
    payload: T,
    sendPromise: Promise<number | null>,
  ): PendingTool<T> {
    const entry: PendingTool<T> = {
      toolName,
      messageId: null,
      // Normalize rejections to `null` so callers that await `messageReady`
      // never see an unhandled rejection — the caller's send wrapper already
      // surfaces send failures via its own logger.
      messageReady: sendPromise.catch(() => null),
      payload,
      createdAt: Date.now(),
      timer: null,
    };
    this.entries.push(entry);

    // Defer-timer kick-off waits until the send resolves so we never schedule
    // a fallback for a message that doesn't yet exist (a 1 s sendPlain delay
    // would otherwise leave only 1 s of the 2 s defer window before the
    // fallback fired without having a target).
    void entry.messageReady.then((id) => {
      // If the entry was already resolve()d or clear()ed while the send was
      // in flight, do nothing.
      if (!this.entries.includes(entry)) return;
      if (id == null) {
        // Send failed — entry can never be edited, drop silently.
        this.removeEntry(entry);
        return;
      }
      entry.messageId = id;
      entry.timer = setTimeout(() => {
        this.removeEntry(entry);
        try {
          this.onTimeout(entry);
        } catch {
          /* swallow — caller-provided callback must not crash the queue */
        }
      }, this.deferMs);
    });

    return entry;
  }

  /**
   * Find and remove the most recent pending entry matching `toolName`.
   * Returns the entry (with its timer already cleared) so the caller can
   * render the suggestion row inline. Returns `null` when there's no match
   * (e.g. tool_result arrived after the defer fallback already fired).
   */
  resolve(toolName: string): PendingTool<T> | null {
    // LIFO match — most recent first. Adapters that interleave multiple
    // calls of the same name (rare; usually one in-flight per kind) still
    // match the latest, which is the best we can do without call ids.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e && e.toolName === toolName) {
        this.entries.splice(i, 1);
        if (e.timer) clearTimeout(e.timer);
        e.timer = null;
        return e;
      }
    }
    return null;
  }

  /**
   * Phase C integration — mutate the `payload` of the most-recent pending
   * entry matching `toolName`. Used by the collapse-burst integration so the
   * stored use-message text stays in lockstep with the LATEST edit applied
   * to the collapse message. Without this, a result that arrives mid-burst
   * would merge with the FIRST burst entry's stored line ("🔧 Read · a")
   * instead of the current collapsed text ("🔧 Read ×3 · a, b, c").
   *
   * Returns the entry that was updated (or `null` when no pending entry
   * matches). Pure mutation — does NOT touch the defer timer or messageId.
   */
  updateLatestPayload(toolName: string, mut: (payload: T) => T): PendingTool<T> | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e && e.toolName === toolName) {
        e.payload = mut(e.payload);
        return e;
      }
    }
    return null;
  }

  /**
   * Senior-review (Opus 4.7) [P1] — like {@link updateLatestPayload} but
   * walks EVERY matching entry, not just the most recent. Used when the
   * collapse-burst integration enqueues additional pending entries (one per
   * burst event) that all share the same target messageId: any subsequent
   * burst event must refresh ALL of them, otherwise the OLDEST entry retains
   * a stale "line" that would render an earlier (smaller) collapsed text
   * when the LAST tool_result resolves it via LIFO consume.
   *
   * Returns the number of entries that were updated.
   */
  updateAllPayloads(toolName: string, mut: (payload: T) => T): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.toolName === toolName) {
        e.payload = mut(e.payload);
        n++;
      }
    }
    return n;
  }

  /** Drop and clear all pending entries (call on session close). */
  clear(): void {
    for (const e of this.entries) {
      if (e.timer) clearTimeout(e.timer);
    }
    this.entries.length = 0;
  }

  /** Exposed for tests — current pending count. */
  size(): number {
    return this.entries.length;
  }

  private removeEntry(entry: PendingTool<T>): void {
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}
