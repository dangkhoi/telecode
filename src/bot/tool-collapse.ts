/**
 * Collapse repeated tool calls (Phase C.4).
 *
 * Agents in tight loops often emit a burst of identical tool invocations
 * within milliseconds (`Read foo.ts; Read types.ts; Read util.ts` while
 * the planner reads context). v1.0 / Phase A rendered one Telegram
 * message per tool_use → 6 messages of vertical chat noise for one
 * conceptual operation.
 *
 * Phase C.4 detects the burst and folds it into a single editable
 * message:
 *
 *   first event:        🔧 Read · foo.ts
 *   second within 5s:   🔧 Read ×2 · foo.ts, types.ts            (edit)
 *   third within 5s:    🔧 Read ×3 · foo.ts, types.ts, util.ts   (edit)
 *   tool switch / 5s+:  finalize the entry; next event = fresh message
 *
 * State machine per (sessionId, toolName):
 *   - { msgId, count, items, firstSeenAt, lastSeenAt }
 *   - opened on first emit of toolName, closed on:
 *       a) different toolName arrives for the same session, OR
 *       b) 5s elapsed since last emit (lazy: checked on next emit or by
 *          periodic sweep — see below).
 *
 * Race protection: the collapse logic runs entirely synchronous on the
 * dispatcher's event loop tick — concurrent tool_use events for the
 * same session are impossible because dispatch.onEvent serialises adapter
 * output. We do NOT need a mutex.
 *
 * Cleanup: dispatcher calls {@link ToolCollapseManager.clearSession} on
 * session close. A periodic sweep (60s interval, configurable) drops
 * stale entries to keep memory bounded under long-lived daemons.
 *
 * Pure utility module — no Telegram imports. Returns a discriminated
 * union describing what the caller should do (send a new message vs
 * edit an existing one); the caller (dispatcher) owns the actual API
 * calls and message-id bookkeeping.
 */

/** Default debounce window: 5 seconds (plan §C.4). */
export const DEFAULT_WINDOW_MS = 5_000;
/** Default max items rendered in the inline list before truncating with "…". */
export const DEFAULT_MAX_ITEMS_DISPLAY_CHARS = 80;
/** Default sweep interval — runs in the background to evict stale entries. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

interface CollapseEntry {
  toolName: string;
  msgId: number | null;
  count: number;
  items: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}

/**
 * Result of {@link ToolCollapseManager.handle}. The dispatcher uses this
 * to decide between `sendPlain` (new message) and `editPlain` (update
 * the running collapse message).
 *
 *   action='send'  → caller sends a NEW message. After send completes,
 *                    caller calls {@link recordSent} with the message id
 *                    so subsequent calls within the window can edit it.
 *   action='edit'  → caller edits `msgId` with `formattedText`. No new
 *                    message id to record.
 */
export type CollapseAction =
  | { action: 'send'; formattedText: string; key: string }
  | { action: 'edit'; msgId: number; formattedText: string; key: string };

/**
 * Per-session burst collapser. Hold one instance per Notifier (per chat
 * scope is fine — keys include sessionId so cross-session leakage is
 * impossible). Tests can pass a fake clock via {@link now} to make the
 * 5s window deterministic.
 */
export class ToolCollapseManager {
  private readonly entries = new Map<string, CollapseEntry>();
  private readonly windowMs: number;
  private readonly maxDisplayChars: number;
  private readonly now: () => number;
  private sweepHandle: NodeJS.Timeout | null = null;

  constructor(opts?: {
    windowMs?: number;
    maxDisplayChars?: number;
    now?: () => number;
    sweepIntervalMs?: number;
    /** Suppress the background sweep timer (tests). */
    disableSweep?: boolean;
  }) {
    this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxDisplayChars = opts?.maxDisplayChars ?? DEFAULT_MAX_ITEMS_DISPLAY_CHARS;
    this.now = opts?.now ?? Date.now;
    if (!opts?.disableSweep) {
      // unref so the sweep timer doesn't pin the process alive — telecode
      // runs as a long-lived daemon but we shouldn't keep Node booted just
      // for stale-entry cleanup.
      this.sweepHandle = setInterval(
        () => this.sweep(),
        opts?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
      );
      this.sweepHandle.unref?.();
    }
  }

  /**
   * Process a tool_use event. The dispatcher calls this BEFORE
   * `notifier.sendPlain` and acts on the returned `action`.
   *
   * @param sessionId  Session the event belongs to. Used as part of the
   *                   collapse key + for `clearSession`.
   * @param toolName   Canonical friendly tool name (e.g. "Read", "Bash"
   *                   — already mapped via {@link friendlyToolLabel}).
   *                   Aliasing happens upstream so `Read` and `fs_read`
   *                   collapse into one entry.
   * @param item       Short label for the tool's target (collapsed path,
   *                   truncated command, etc.) — appended to the items
   *                   list for the collapsed render.
   * @param prefix     Prepended to the formatted text (e.g. `[label] `).
   *                   Set once per session; we don't re-stamp it on each
   *                   edit — the first call wins.
   */
  handle(
    sessionId: string,
    toolName: string,
    item: string,
    prefix: string,
  ): CollapseAction {
    const key = this.keyFor(sessionId, toolName);
    const now = this.now();

    // Finalize any OTHER tool's entry for this session — once the agent
    // switches tools, the previous burst is conceptually closed. We don't
    // need to render anything for the close; the existing edit message
    // stays in place at its last state.
    this.finalizeOtherToolsForSession(sessionId, toolName);

    const existing = this.entries.get(key);
    if (existing && now - existing.lastSeenAt <= this.windowMs && existing.msgId != null) {
      // Within window + we know the message id → edit.
      existing.count += 1;
      existing.items.push(item);
      existing.lastSeenAt = now;
      const text = this.format(toolName, existing, prefix);
      return { action: 'edit', msgId: existing.msgId, formattedText: text, key };
    }

    // Either no entry, or stale, or send was still pending (msgId null
    // means a previous handle returned 'send' but recordSent never
    // arrived — fall back to a fresh send to avoid stuck state).
    if (existing) this.entries.delete(key);
    const entry: CollapseEntry = {
      toolName,
      msgId: null,
      count: 1,
      items: [item],
      firstSeenAt: now,
      lastSeenAt: now,
    };
    this.entries.set(key, entry);
    const text = this.format(toolName, entry, prefix);
    return { action: 'send', formattedText: text, key };
  }

  /**
   * Record the message id of a freshly-sent collapse message so the
   * NEXT handle call can edit it. Dispatcher calls this after
   * `notifier.sendPlain` resolves (whether msgId is null or a number —
   * passing null gracefully tears down the entry).
   */
  recordSent(key: string, msgId: number | null): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (msgId == null) {
      // Send failed — drop the entry so we don't try to edit a phantom
      // message later.
      this.entries.delete(key);
      return;
    }
    entry.msgId = msgId;
  }

  /**
   * Drop all entries for `sessionId`. Called by session-close handler.
   */
  clearSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const k of Array.from(this.entries.keys())) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  /** Total entry count — diagnostic helper for tests. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Stop the background sweep timer. Call on shutdown so the process
   * can exit cleanly; idempotent.
   */
  stop(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  /* ────────────────────────── internals ────────────────────────── */

  private keyFor(sessionId: string, toolName: string): string {
    return `${sessionId}::${toolName}`;
  }

  /**
   * Drop any other-tool entries for the same session whose window has
   * NOT yet expired. They're conceptually finalized once a different
   * tool comes along; we just want to forget the in-memory state so a
   * future Read after a Bash doesn't try to edit the (now stale) Bash
   * message.
   *
   * We leave the rendered message intact at its last state — no edit
   * needed; the count + items list already reflects everything we saw.
   */
  private finalizeOtherToolsForSession(sessionId: string, keepTool: string): void {
    const prefix = `${sessionId}::`;
    for (const k of Array.from(this.entries.keys())) {
      if (!k.startsWith(prefix)) continue;
      const tool = k.slice(prefix.length);
      if (tool !== keepTool) this.entries.delete(k);
    }
  }

  private format(toolName: string, entry: CollapseEntry, prefix: string): string {
    const head = entry.count === 1 ? `🔧 ${toolName}` : `🔧 ${toolName} ×${entry.count}`;
    // Truncate the items list at maxDisplayChars so a 50-item Read burst
    // doesn't blow up the message. We render in chronological order so
    // truncation hides the OLDEST items — the user sees the freshest
    // file names which is usually what they care about (debugging the
    // current step).
    const itemsText = this.truncateItems(entry.items);
    if (itemsText.length === 0) return `${prefix}${head}`;
    return `${prefix}${head} · ${itemsText}`;
  }

  private truncateItems(items: string[]): string {
    // Concat in reverse: prepend newest, drop oldest beyond budget.
    const reversed = [...items].reverse();
    const kept: string[] = [];
    let totalLen = 0;
    for (const it of reversed) {
      const add = (kept.length === 0 ? 0 : 2) + it.length; // ", "
      if (totalLen + add > this.maxDisplayChars && kept.length > 0) {
        kept.push('…');
        break;
      }
      kept.push(it);
      totalLen += add;
    }
    // Restore chronological order (oldest → newest) with truncation
    // sentinel at the start if present.
    return kept.reverse().join(', ');
  }

  /**
   * Drop entries whose window has elapsed. Cheap O(N) — N is small
   * because clearSession + finalizeOtherToolsForSession keep the map
   * lean during normal traffic. Runs on a timer so a quiet daemon
   * eventually frees idle-session memory.
   */
  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.entries) {
      if (now - v.lastSeenAt > this.windowMs) this.entries.delete(k);
    }
  }
}
