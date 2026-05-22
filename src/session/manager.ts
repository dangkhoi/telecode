import { randomUUID } from 'node:crypto';
import { Mutex } from 'async-mutex';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentEvent, AgentKind } from '../agents/types.js';
import type { SessionStore, SessionRow } from './store.js';
import { OutputBuffer, type BufferedEvent } from './output-buffer.js';
import { logger } from '../util/logger.js';

export interface SessionRuntime {
  mutex: Mutex;
  abort: AbortController | null;
  /**
   * v1.4 (perf-pass §C1) — who currently holds the busy mutex. `'summarize'`
   * is a low-priority background holder (auto-done / auto-tool-result / on-demand
   * summary) that a real `'user'` dispatch is allowed to PREEMPT (abort) instead
   * of being rejected with "session busy". `null` when idle.
   */
  holder: 'user' | 'summarize' | null;
}

export interface DispatchOpts {
  sessionId: string;
  prompt: string;
  onEvent: (e: AgentEvent) => void;
}

/** v1.4 (perf-pass §C1) — dispatch priority. Defaults to `'user'`. */
export type DispatchKind = 'user' | 'summarize';

/** Optional knobs the daemon supplies from config. */
export interface SessionManagerOpts {
  /** Per-session output buffer cap in bytes (default 50_000). */
  bufferCapBytes?: number;
}

export class SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly buffers = new Map<string, OutputBuffer>();
  private readonly bufferCapBytes: number;

  constructor(
    private readonly store: SessionStore,
    private readonly registry: AgentRegistry,
    opts: SessionManagerOpts = {},
  ) {
    this.bufferCapBytes = opts.bufferCapBytes ?? 50_000;
  }

  private rt(id: string): SessionRuntime {
    let r = this.runtimes.get(id);
    if (!r) {
      r = { mutex: new Mutex(), abort: null, holder: null };
      this.runtimes.set(id, r);
    }
    return r;
  }

  createSession(opts: {
    chatId: number;
    agent: AgentKind;
    label: string;
    projectId: number | null;
  }): SessionRow {
    const id = randomUUID();
    return this.store.createSession({
      id,
      label: opts.label,
      agent: opts.agent,
      project_id: opts.projectId,
      chat_id: opts.chatId,
      sdk_session_id: null,
      status: 'idle',
    });
  }

  isBusy(sessionId: string): boolean {
    return this.rt(sessionId).mutex.isLocked();
  }

  /**
   * Wait until the session's busy mutex is released (or resolve immediately
   * if the session is already idle). Phase D — `summarizeWithSession` calls
   * this before dispatching the hidden summarize prompt so it queues behind
   * any in-flight user dispatch instead of getting rejected with the
   * "⏳ session busy" short-circuit.
   *
   * Does NOT acquire the mutex — callers must follow up with a real
   * `dispatch()` call which will compete with any new callers fairly.
   * Returns a Promise that resolves after the next unlock; if the session is
   * never locked, resolves on the next microtask.
   */
  async waitForIdle(sessionId: string): Promise<void> {
    const rt = this.rt(sessionId);
    if (!rt.mutex.isLocked()) return;
    await rt.mutex.waitForUnlock();
  }

  interrupt(sessionId: string): boolean {
    const r = this.runtimes.get(sessionId);
    if (!r?.abort) return false;
    r.abort.abort(new Error('user_stop'));
    return true;
  }

  /**
   * Append a formatted event to the session's background-output buffer.
   * Lazy-creates an OutputBuffer with the configured cap on first use so
   * we never allocate for sessions that never go to background.
   */
  appendBuffer(sessionId: string, event: BufferedEvent): void {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = new OutputBuffer(this.bufferCapBytes);
      this.buffers.set(sessionId, buf);
    }
    buf.append(event);
  }

  /**
   * Drain the session's buffer in arrival order. Returns [] if no buffer
   * exists (session never went to background). The buffer is reset but the
   * Map entry is left in place — future appends reuse it.
   */
  drainBuffer(sessionId: string): BufferedEvent[] {
    const buf = this.buffers.get(sessionId);
    if (!buf) return [];
    return buf.drain();
  }

  /** True iff a buffer exists for this session AND it has unflushed events. */
  hasBuffered(sessionId: string): boolean {
    const buf = this.buffers.get(sessionId);
    return buf !== undefined && !buf.isEmpty();
  }

  /**
   * Bytes currently buffered for `sessionId`. Returns 0 when no buffer
   * exists. Surface for `/dashboard` (plan P0.5) so it can show per-session
   * background buffer size without poking internals.
   */
  bufferBytesFor(sessionId: string): number {
    const buf = this.buffers.get(sessionId);
    return buf ? buf.bytesUsed() : 0;
  }

  /**
   * Permanently drop the session's buffer (if any). Called when the session
   * is closed / removed so the Map entry doesn't leak across daemon lifetime.
   * Idempotent: safe to call for a session that never buffered.
   */
  discardBuffer(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  async dispatch(
    opts: DispatchOpts & {
      cwd: string;
      agent: AgentKind;
      sessionLabel: string;
      chatId: number;
      resumeId: string | null;
      model?: string | null;
      /** v1.4 (perf-pass §C1) — priority; defaults to 'user'. */
      kind?: DispatchKind;
    },
  ): Promise<void> {
    const kind: DispatchKind = opts.kind ?? 'user';
    const rt = this.rt(opts.sessionId);
    if (rt.mutex.isLocked()) {
      // v1.4 (perf-pass §C1) — a real user dispatch PREEMPTS an in-flight
      // background summarize instead of bouncing with "session busy". We abort
      // the summarize and fall through to runExclusive, which queues fairly and
      // acquires the mutex the moment the aborted summarize releases it.
      if (kind === 'user' && rt.holder === 'summarize') {
        rt.abort?.abort(new Error('preempted_by_user'));
        // Claim the holder slot optimistically so a SECOND user dispatch
        // arriving before the summarize finishes releasing sees holder==='user'
        // and bounces with "session busy" (instead of also preempting and
        // double-queuing). The aborted summarize's `finally` will NOT clobber
        // this: runExclusive serializes, so our queued callback re-asserts
        // holder='user' after it acquires.
        rt.holder = 'user';
        // fall through
      } else {
        opts.onEvent({
          type: 'error',
          error: '⏳ session busy — /stop to interrupt or wait.',
        });
        return;
      }
    }
    await rt.mutex.runExclusive(async () => {
      rt.holder = kind;
      rt.abort = new AbortController();
      this.store.updateSession(opts.sessionId, { status: 'running' });
      const adapter = this.registry.require(opts.agent);
      // v1.4 (perf-pass §I) — per-turn latency instrumentation. The `agent`
      // field lets us slice timing per adapter (Kiro Rust cold start vs
      // Codex/Cursor server init vs Claude resume replay). dispatch→first-text
      // captures spawn + resume-replay cost; first-text→done is generation.
      const tDispatch = Date.now();
      let tFirstText: number | null = null;
      try {
        await adapter.run({
          sessionId: opts.sessionId,
          sessionLabel: opts.sessionLabel,
          chatId: opts.chatId,
          cwd: opts.cwd,
          resumeId: opts.resumeId,
          initialPrompt: opts.prompt,
          model: opts.model,
          onEvent: (e) => {
            if (e.type === 'text' && tFirstText === null) tFirstText = Date.now();
            try {
              opts.onEvent(e);
            } catch (err) {
              logger.warn({ err: String(err) }, 'onEvent throw');
            }
          },
          abortSignal: rt.abort.signal,
        });
      } finally {
        if (kind === 'user') {
          const tDone = Date.now();
          logger.info(
            {
              sessionId: opts.sessionId,
              agent: opts.agent,
              hasResume: !!opts.resumeId,
              promptChars: opts.prompt.length,
              dispatchToFirstTextMs: tFirstText !== null ? tFirstText - tDispatch : null,
              firstTextToDoneMs: tFirstText !== null ? tDone - tFirstText : null,
              totalMs: tDone - tDispatch,
            },
            'dispatch timing',
          );
        }
        rt.abort = null;
        // Only clear the holder if it's still US. A preempting user dispatch
        // sets holder='user' BEFORE we (the aborted summarize) reach this
        // finally; clobbering it back to null would reopen the double-preempt
        // window. The preemptor's queued callback re-asserts its own holder.
        if (rt.holder === kind) rt.holder = null;
        this.store.updateSession(opts.sessionId, { status: 'idle' });
      }
    });
  }
}
