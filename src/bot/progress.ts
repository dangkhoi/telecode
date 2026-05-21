/**
 * Phase E — Activity indicators (plan §8).
 *
 * v1.1 final UX piece. The v1.0 firehose surfaced status events ("kiro
 * spawning…", "codex turn started…") as individual messages. After Phase B
 * suppresses those in summary/normal/thinking modes, the user goes silent for
 * long stretches if the agent does heavy filesystem / network work — the
 * notifications-suppressed-by-mode state is indistinguishable from a hung
 * daemon. Phase D's done-summary helps after the fact, but not DURING the
 * turn.
 *
 * The fix: maintain a SINGLE rolling progress message per session. It is
 * sent once on the first event of a turn, edited in place as the work
 * progresses ("⏳ Reading 3 files…", "⏳ Running tests… (12s)"), and
 * deleted/finalized when the turn closes. Edits are throttled to 1500ms to
 * stay safely below Telegram's 20-edits/min/group rate limit (per-session
 * accounting → 40/min worst case for a SINGLE chat with one session; multiple
 * chats unaffected).
 *
 * Idle ping: if no events arrive for 30s/60s/.../5m, the ping timer edits
 * the message to "⏳ Working… (30s)" so the user knows the daemon is alive
 * even when the adapter is silent (long bash, network IO, model thinking).
 * Caps at 5 minutes — past that the user should /stop themselves.
 *
 * Cross-platform: only Telegram API + setTimeout/clearTimeout. No filesystem,
 * no native deps.
 *
 * Mode awareness: progress runs ONLY for `summary` / `normal` / `thinking`.
 * `verbose` keeps the raw firehose UX (status events are emitted directly).
 *
 * Race safety: each session has its own async-mutex. `start()` / `update()` /
 * `finalize()` are serialized per session so a fast-arriving event burst
 * can't interleave a `start` mid-edit (which would orphan the old message).
 *
 * NOT a singleton — instantiated in `commands/index.ts` with the bot.api
 * dependency. Tests construct directly with a stub api.
 */
import { Mutex } from 'async-mutex';
import type { AgentEvent } from '../agents/types.js';
import type { VerbosityMode } from '../session/verbosity.js';
import { logger } from '../util/logger.js';

/**
 * Status-event subtype helper. The {@link AgentEvent} union has a single
 * `status` variant whose payload is just `{ status: string }`. Cursor's
 * adapter currently extends that via free-form keys (plan_summary), so we
 * accept an open record and pluck what we know how to render.
 */
export type AgentEventStatus = Extract<AgentEvent, { type: 'status' }> & {
  /**
   * Optional adapter-specific payload. Cursor sets `plan_summary` on its
   * `cursor_plan_update` status event. We read defensively — missing keys
   * fall back to the default `⏳ <status>` form.
   */
  payload?: Record<string, unknown>;
};

/**
 * Minimal subset of grammY's `bot.api` we touch. Typed as a structural
 * interface so tests can pass a stub without pulling in grammY. The real
 * signature uses `number | string` for chat_id; we narrow to `number` since
 * our daemon only ever talks to numeric chat ids.
 */
export interface ProgressApi {
  sendMessage(
    chatId: number,
    text: string,
    extra?: { disable_notification?: boolean },
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
}

/** Mode resolver callback — supplied by the daemon so progress can skip the
 * verbose firehose case without re-implementing the lookup. */
export type ModeResolver = (sessionId: string, chatId: number) => VerbosityMode;

interface ProgressState {
  msgId: number;
  chatId: number;
  lastText: string;
  lastUpdateAt: number;
  turnStartedAt: number;
  /** Idle ping timer — null when paused (e.g. after the 5m cap). */
  idleTimer: NodeJS.Timeout | null;
  /** Index into {@link IDLE_PING_LADDER} — drives next ping text + delay. */
  idleStep: number;
}

/** Throttle window — edits closer than this are dropped silently. */
const EDIT_THROTTLE_MS = 1500;

/**
 * Idle-ping schedule. Each entry = how long after the LAST event to fire the
 * next ping, paired with the text to render. Past the final entry, no more
 * pings (user should /stop themselves at that point).
 */
interface IdlePingStep {
  delayMs: number;
  text: string;
}
const IDLE_PING_LADDER: readonly IdlePingStep[] = Object.freeze([
  { delayMs: 30_000, text: '⏳ Working… (30s)' },
  { delayMs: 30_000, text: '⏳ Working… (60s)' },
  { delayMs: 60_000, text: '⏳ Working… (2m)' },
  { delayMs: 60_000, text: '⏳ Working… (3m)' },
  { delayMs: 60_000, text: '⏳ Working… (4m)' },
  { delayMs: 60_000, text: '⏳ Working… (5m+)' },
]);

/** Telegram errors that mean "message gone — drop state silently." */
function isMessageGoneError(err: unknown): boolean {
  const e = err as { description?: string; error_code?: number };
  if (!e || typeof e.description !== 'string') return false;
  if (e.error_code !== 400) return false;
  return /message to edit not found|message_id_invalid|message to delete not found|MESSAGE_ID_INVALID/i.test(
    e.description,
  );
}

/**
 * Pure renderer for {@link AgentEventStatus} events. Tables of known status
 * strings → friendly progress text; everything else falls back to a generic
 * `⏳ <status>` form so future adapter additions render reasonably even
 * before we hand-tune them.
 *
 * Exported separately from {@link ProgressManager} so dispatch can call it
 * before deciding whether to update progress at all (e.g. verbose mode skips
 * the manager entirely but might still want to log the friendly form).
 */
export function renderStatusEvent(event: AgentEventStatus): string {
  const status = event.status ?? '';
  switch (status) {
    case 'kiro_spawning':
      return '⏳ Starting Kiro…';
    case 'codex_turn_started':
      return '⏳ Codex thinking…';
    case 'codex_turn_exited':
      return '✓ Codex turn complete';
    case 'cursor_spawning':
      return '⏳ Starting Cursor…';
    case 'cursor_plan_update': {
      const summary =
        event.payload && typeof event.payload.plan_summary === 'string'
          ? (event.payload.plan_summary as string).trim()
          : '';
      return '⏳ ' + (summary || 'Planning…');
    }
    default:
      // Empty status → graceful "working" placeholder. We never emit a bare
      // "⏳ " because that's a worse UX than the v1.0 silence.
      if (status === '') return '⏳ Working…';
      return '⏳ ' + status;
  }
}

/**
 * Class — see file-level comment for the design rationale. Construct one
 * instance per daemon; share via `commands/index.ts`.
 */
export class ProgressManager {
  private readonly states = new Map<string, ProgressState>();
  private readonly mutexes = new Map<string, Mutex>();
  private readonly api: ProgressApi;
  private readonly modeResolver: ModeResolver;
  /** Injected clock — overridable by tests. Defaults to `Date.now`. */
  private readonly now: () => number;

  constructor(opts: {
    api: ProgressApi;
    modeResolver: ModeResolver;
    now?: () => number;
  }) {
    this.api = opts.api;
    this.modeResolver = opts.modeResolver;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Convenience: does this session currently have a tracked progress
   * message? Cheap synchronous lookup — used by dispatch to decide whether
   * to call {@link start} on the first event of a turn.
   */
  has(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  /** Skip-progress check — exported so the dispatch can short-circuit. */
  private shouldSkip(sessionId: string, chatId: number): boolean {
    const mode = this.modeResolver(sessionId, chatId);
    return mode === 'verbose';
  }

  private mutex(sessionId: string): Mutex {
    let m = this.mutexes.get(sessionId);
    if (!m) {
      m = new Mutex();
      this.mutexes.set(sessionId, m);
    }
    return m;
  }

  /**
   * Send the initial progress message and start the idle ping timer. If a
   * progress message already exists for this session (turn-in-turn race —
   * shouldn't happen in normal flow, but defensive), finalize the old one
   * first so it doesn't dangle.
   *
   * Mode-aware: no-op in verbose. Safe to call unconditionally from dispatch.
   */
  async start(sessionId: string, chatId: number, initialText: string): Promise<void> {
    if (this.shouldSkip(sessionId, chatId)) return;
    await this.mutex(sessionId).runExclusive(async () => {
      const existing = this.states.get(sessionId);
      if (existing) {
        // Finalize the dangling message in place — best-effort, swallow
        // errors. We can't await `finalize()` here because that would
        // re-acquire the same mutex and deadlock.
        await this.finalizeUnlocked(sessionId, undefined);
      }
      try {
        const sent = await this.api.sendMessage(chatId, initialText, {
          disable_notification: true,
        });
        const now = this.now();
        const state: ProgressState = {
          msgId: sent.message_id,
          chatId,
          lastText: initialText,
          lastUpdateAt: now,
          turnStartedAt: now,
          idleTimer: null,
          idleStep: 0,
        };
        this.states.set(sessionId, state);
        this.scheduleIdlePing(sessionId);
      } catch (err) {
        logger.warn({ err: String(err), sessionId }, 'progress.start send failed');
      }
    });
  }

  /**
   * Edit the progress message in place. Skips silently when:
   *   - mode is verbose;
   *   - no state exists (caller forgot to `start()` — likely a race);
   *   - text is identical to the last rendered text;
   *   - last edit was less than {@link EDIT_THROTTLE_MS} ago.
   *
   * Throttle is a HARD gate — we don't queue dropped edits. The next event
   * to arrive past the gate will reflect the latest state, which is the
   * desired UX for a rolling status indicator (we don't care about every
   * intermediate transition, just the most recent steady state).
   *
   * On edit failure with a "message gone" error we drop state and return —
   * the next event triggers a fresh `start()` in the dispatch wiring.
   */
  async update(sessionId: string, text: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    if (this.shouldSkip(sessionId, state.chatId)) return;
    await this.mutex(sessionId).runExclusive(async () => {
      // Re-read inside the lock — another caller may have just cleared us.
      const s = this.states.get(sessionId);
      if (!s) return;
      if (s.lastText === text) return;
      const now = this.now();
      if (now - s.lastUpdateAt < EDIT_THROTTLE_MS) return;
      try {
        await this.api.editMessageText(s.chatId, s.msgId, text);
        s.lastText = text;
        s.lastUpdateAt = now;
        // Activity → reset idle ladder so the next ping reflects "30s since
        // we last heard from the adapter," not 30s since turn start.
        s.idleStep = 0;
        this.scheduleIdlePing(sessionId);
      } catch (err) {
        if (isMessageGoneError(err)) {
          // User deleted the message OR Telegram lost the id — drop state
          // and let dispatch re-bootstrap on the next event.
          this.clearTimer(s);
          this.states.delete(sessionId);
          return;
        }
        // Other errors (429, network) — log + retain state so a later
        // update can recover. Telegram's auto-retry plugin is NOT wired
        // for this path because progress is best-effort.
        const e = err as { description?: string };
        if (e?.description && /message is not modified/i.test(e.description)) {
          // Harmless — same text race. Don't bump lastUpdateAt so the next
          // genuine edit isn't throttled extra.
          return;
        }
        logger.warn({ err: String(err), sessionId }, 'progress.update edit failed');
      }
    });
  }

  /**
   * Close out the progress message. Two flavours:
   *   - `finalText` provided → edit the message to `finalText` and clear
   *     state (used by the error path to leave a "❌ <msg>" tombstone).
   *   - `finalText` omitted → delete the message entirely (used by the done
   *     path; Phase D's done-summary card supersedes the progress message).
   *
   * Idempotent: calling on a session with no state is a no-op. Safe across
   * concurrent invocations (mutex-protected).
   */
  async finalize(sessionId: string, finalText?: string): Promise<void> {
    await this.mutex(sessionId).runExclusive(async () => {
      await this.finalizeUnlocked(sessionId, finalText);
    });
  }

  /**
   * Mutex-free variant — caller MUST hold the lock. Used by `start()` to
   * tear down a dangling state without recursive locking.
   */
  private async finalizeUnlocked(sessionId: string, finalText?: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.clearTimer(state);
    this.states.delete(sessionId);
    try {
      if (finalText !== undefined) {
        await this.api.editMessageText(state.chatId, state.msgId, finalText);
      } else {
        await this.api.deleteMessage(state.chatId, state.msgId);
      }
    } catch (err) {
      if (!isMessageGoneError(err)) {
        logger.warn({ err: String(err), sessionId }, 'progress.finalize failed');
      }
      // Either way state is already removed — nothing else to do.
    }
  }

  /**
   * Synchronous cleanup hook — used when a session is closed externally
   * (router `session:close:<id>`, manager teardown). Does NOT call Telegram
   * (the message stays where it is on the user's screen as a stale tombstone
   * if it wasn't already finalized). This is intentional: close paths must
   * not block on network IO.
   */
  clear(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.clearTimer(state);
    this.states.delete(sessionId);
    // Mutex map entry stays in place — cheap, and dropping it would race
    // any in-flight `await runExclusive` calls. Cleaned up by `dispose()`
    // for tests that need full GC.
  }

  /**
   * Test-only: drop ALL state + mutexes. Production code never calls this
   * (the daemon outlives all sessions). Used by integration tests to start
   * each case from a clean slate.
   */
  dispose(): void {
    for (const state of this.states.values()) {
      this.clearTimer(state);
    }
    this.states.clear();
    this.mutexes.clear();
  }

  private clearTimer(state: ProgressState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  /**
   * (Re)schedule the next idle ping. Cleared timer first so callers can
   * invoke this on every update without leaking timers.
   */
  private scheduleIdlePing(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.clearTimer(state);
    if (state.idleStep >= IDLE_PING_LADDER.length) return; // capped
    const step = IDLE_PING_LADDER[state.idleStep]!;
    state.idleTimer = setTimeout(() => {
      void this.fireIdlePing(sessionId);
    }, step.delayMs);
    // setTimeout returns a Timeout object — under node the .unref() lets the
    // process exit even if a ping is pending. Production daemon never exits
    // mid-turn, but tests using real timers benefit.
    if (state.idleTimer && typeof (state.idleTimer as { unref?: () => void }).unref === 'function') {
      (state.idleTimer as { unref: () => void }).unref();
    }
  }

  private async fireIdlePing(sessionId: string): Promise<void> {
    await this.mutex(sessionId).runExclusive(async () => {
      const s = this.states.get(sessionId);
      if (!s) return;
      if (s.idleStep >= IDLE_PING_LADDER.length) return;
      const step = IDLE_PING_LADDER[s.idleStep]!;
      // Skip the throttle for idle pings — they're scheduled events, not
      // event-driven, and the user explicitly wants them on time.
      try {
        if (s.lastText !== step.text) {
          await this.api.editMessageText(s.chatId, s.msgId, step.text);
          s.lastText = step.text;
        }
        s.lastUpdateAt = this.now();
      } catch (err) {
        if (isMessageGoneError(err)) {
          this.clearTimer(s);
          this.states.delete(sessionId);
          return;
        }
        // Soft-log other errors — we still want to advance the ladder so
        // a flapping network doesn't lock the timer forever.
        const e = err as { description?: string };
        if (!(e?.description && /message is not modified/i.test(e.description))) {
          logger.warn({ err: String(err), sessionId }, 'progress idle ping edit failed');
        }
      }
      // Advance the ladder regardless of edit success — the user-perceived
      // "how long has this been running" should keep ticking even if a
      // single edit failed.
      s.idleStep += 1;
      if (s.idleStep < IDLE_PING_LADDER.length) {
        this.scheduleIdlePing(sessionId);
      } else {
        // Cap reached — release the timer slot. Next event-driven update()
        // will reset idleStep to 0 and resume the ladder.
        this.clearTimer(s);
      }
    });
  }
}
