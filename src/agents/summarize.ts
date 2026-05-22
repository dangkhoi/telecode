/**
 * Phase D — Agentic compression.
 *
 * "Killer feature" of v1.1: instead of rule-based truncate of long tool output
 * / final-result text, REUSE the running session's agent to summarize. The
 * agent already has full context (project layout, recent commands, file
 * conventions) — its 2-line summary is dramatically more useful than a
 * `slice(0, 240)` rule-based preview.
 *
 * D2 decision (chốt với user): reuse session = ăn cost của session. No
 * separate API key, no separate provider — the summary inherits the session's
 * authentication + token budget. Cost transparency comes from per-call logger
 * entries (see {@link logger.info} calls below).
 *
 * Mechanism:
 *
 *   1. Acquire the per-session SUMMARIZE mutex (separate from
 *      {@link SessionManager}'s per-session BUSY mutex — see Race Protection
 *      below).
 *   2. Dispatch a fresh prompt through {@link SessionManager.dispatch} with
 *      `instruction + "\n\n" + content`. This goes through the same adapter
 *      that's running the user's session (Claude / Codex / Cursor / Kiro),
 *      with the same `resumeId` so the agent has full prior context.
 *   3. Collect the agent's text response across the dispatch. On `done`,
 *      return the joined text (trimmed). On `error` or timeout, return
 *      {@link SUMMARIZE_TIMEOUT} / {@link SUMMARIZE_ERROR}-shaped result so
 *      callers can render the failure path.
 *
 * Race Protection:
 *
 *   - The SessionManager's busy mutex (per-session) serializes USER dispatches
 *     and any other code that calls `manager.dispatch` for the same session.
 *     A summarize call running while the user's prompt is in flight queues
 *     up behind it — the user's task finishes, THEN summarize runs. Acceptable
 *     trade-off vs the complexity of bypassing the mutex (that would risk
 *     server-side session forking on the agent provider's side).
 *   - This module ALSO maintains its own per-session mutex (the
 *     {@link summarizeMutexes} Map below). It prevents TWO summarize requests
 *     for the SAME session from racing — e.g. user taps [💬 AI summary] on
 *     two tool_result messages in quick succession. Without this guard the
 *     second call would queue behind the first on the manager's busy mutex,
 *     but it would still consume a second roundtrip. Coalescing here keeps
 *     the cost story honest.
 *
 * Timeout & Fallback:
 *
 *   - Default 30s. If the agent doesn't reply within the budget (slow LLM,
 *     network blip), the call rejects internally and returns `null`. Callers
 *     must handle `null` by showing the original content — never crash.
 *   - The timeout is best-effort: it doesn't actually abort the underlying
 *     dispatch (that would interrupt the user's session). It only stops
 *     waiting for the answer; the dispatch eventually finishes and the
 *     summary text is dropped on the floor.
 *
 * NOT in scope:
 *
 *   - Persisting summaries (transient — summary lives only as the rendered
 *     Telegram message; no DB write).
 *   - Cost capping (Phase D scope; budget feature deferred to v1.2 per
 *     plan §13).
 *   - Multi-language (instruction is supplied by the caller; default Vietnamese
 *     wording is set in `commands/index.ts`).
 *
 * Pure module — no Telegram imports. Consumed by:
 *
 *   - `src/bot/commands/index.ts` for auto-summarize tool_result (D.2) +
 *     auto done-summary (D.4)
 *   - `src/bot/router.ts` for on-demand AI summary callback (D.3)
 */
import { Mutex } from 'async-mutex';
import type { SessionManager } from '../session/manager.js';
import type { SessionStore } from '../session/store.js';
import type { AgentEvent } from './types.js';
import { logger } from '../util/logger.js';

/** Default timeout (ms) for a single summarize call. 30s mirrors the user's spec. */
export const DEFAULT_SUMMARIZE_TIMEOUT_MS = 30_000;

/**
 * Per-session SUMMARIZE mutex. NOT the same as the SessionManager's
 * per-session busy mutex — that one serializes user dispatches; this one
 * serializes summarize calls for the SAME session so two button-taps don't
 * both fire summarize back-to-back.
 *
 * Exported only for tests that need to reset state.
 */
export const summarizeMutexes = new Map<string, Mutex>();

function mutexFor(sessionId: string): Mutex {
  let m = summarizeMutexes.get(sessionId);
  if (!m) {
    m = new Mutex();
    summarizeMutexes.set(sessionId, m);
  }
  return m;
}

/**
 * Drop the summarize mutex for a session (called on session close so a
 * long-running daemon doesn't leak entries for closed sessions).
 *
 * Safe to call with an unknown sessionId.
 */
export function discardSummarizeMutex(sessionId: string): void {
  summarizeMutexes.delete(sessionId);
}

/** Kinds of summarize call — used in logger entries for cost auditing. */
export type SummarizeKind = 'auto-tool-result' | 'on-demand' | 'auto-done';

export interface SummarizeOpts {
  /** SessionManager used to dispatch the hidden prompt. */
  manager: SessionManager;
  /** Session row store — needed to resolve cwd + agent + resumeId. */
  store: SessionStore;
  /** Session whose adapter + resumeId we'll reuse for the summary call. */
  sessionId: string;
  /** Raw content to summarize (tool output, transcript tail, etc.). */
  content: string;
  /** Instruction prefix the agent sees ("Tóm tắt output trong 2 dòng …"). */
  instruction: string;
  /** Soft timeout (ms). Default {@link DEFAULT_SUMMARIZE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Tag for the logger entry — purely diagnostic. */
  kind: SummarizeKind;
}

/**
 * Run a summarize call through the session's adapter. Returns the agent's
 * trimmed text response on success, or `null` on timeout / error / busy.
 *
 * Caller MUST handle `null` by falling back to the original content — never
 * crash, never block the user.
 *
 * Calls are serialized per-session via {@link summarizeMutexes}.
 */
export async function summarizeWithSession(opts: SummarizeOpts): Promise<string | null> {
  const { manager, store, sessionId, content, instruction, kind } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS;
  const mutex = mutexFor(sessionId);

  // Acquire the summarize mutex — coalesces parallel calls for the same
  // session. If a prior summarize is in flight, we queue here. The outer
  // timeout still applies, so a queue depth > 1 + slow summarize could
  // make us fall through to null — acceptable, the caller falls back to
  // showing original content.
  return mutex.runExclusive(async () => {
    const sess = store.getSession(sessionId);
    if (!sess) {
      logger.warn({ sessionId, kind }, 'summarize: session vanished before dispatch');
      return null;
    }
    if (!sess.sdk_session_id) {
      // No resume id — session never ran a prompt. Without context the
      // summarize would just hallucinate. Fall back.
      logger.info({ sessionId, kind }, 'summarize: no sdk_session_id yet, skipping');
      return null;
    }

    // Resolve cwd same way the plain-text dispatcher does. Use the typed
    // `store.getProject` helper instead of poking `store.db.prepare` so the
    // schema change locality stays inside the store module (Opus 4.7 review
    // [P3]).
    const projRow = store.getProject(sess.project_id ?? null);
    const cwd = projRow?.path ?? process.cwd();

    const startTs = Date.now();
    const chunks: string[] = [];
    let done = false;
    let errored = false;

    const fullPrompt = `${instruction}\n\n---\n${content}`;

    // Wait for the session's busy mutex to release. Without this guard,
    // {@link SessionManager.dispatch} short-circuits with the
    // "⏳ session busy" pseudo-error event the moment we call it during an
    // in-flight user turn, and we'd never collect any text. The wait
    // counts against our overall timeout budget so a hung user dispatch
    // doesn't pin summarize forever.
    const waitDeadline = Date.now() + timeoutMs;
    // Track the outer timeout's setTimeout handle so we can clearTimeout
    // when waitForIdle resolves first — avoids leaking a 30s-default timer
    // per call on a long-running daemon (Opus 4.7 review [P2]).
    let waitTimer: NodeJS.Timeout | null = null;
    await Promise.race([
      manager.waitForIdle(sessionId).then(() => {
        if (waitTimer) {
          clearTimeout(waitTimer);
          waitTimer = null;
        }
      }),
      new Promise<void>((resolve) => {
        waitTimer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (Date.now() >= waitDeadline) {
      logger.warn(
        { sessionId, kind, timeoutMs },
        'summarize: timed out waiting for session to go idle',
      );
      return null;
    }
    // Re-check session status after the idle wait — a /session close in the
    // meantime would make a dispatch on a closed session pointless and could
    // trigger a stale agent run (Opus 4.7 review [P2]).
    const freshSess = store.getSession(sessionId);
    if (!freshSess || freshSess.status === 'closed') {
      logger.info(
        { sessionId, kind },
        'summarize: session closed/vanished during idle wait, aborting',
      );
      return null;
    }

    const dispatchPromise = manager
      .dispatch({
        sessionId,
        sessionLabel: sess.label,
        chatId: sess.chat_id,
        cwd,
        agent: sess.agent,
        resumeId: sess.sdk_session_id,
        prompt: fullPrompt,
        // v1.4 (perf-pass §C1) — low-priority: a real user prompt preempts this.
        kind: 'summarize',
        onEvent: (e: AgentEvent) => {
          // Capture ONLY text events. We deliberately ignore tool_use /
          // tool_result / status events from the summarize call — the
          // summary prompt isn't supposed to invoke tools, and if the agent
          // mis-interprets and does so, we still only care about its
          // text reply.
          if (e.type === 'text') {
            chunks.push(e.text);
          } else if (e.type === 'error') {
            errored = true;
            logger.warn({ sessionId, kind, err: e.error }, 'summarize: agent error');
          } else if (e.type === 'done') {
            done = true;
          }
        },
      })
      .catch((err: unknown) => {
        errored = true;
        logger.warn({ sessionId, kind, err: String(err) }, 'summarize: dispatch crash');
      });

    // Remaining budget after the wait phase. We hold the setTimeout handle
    // so it can be cleared when the dispatch resolves first — otherwise a
    // long-running daemon leaks one Timeout per summarize call until the
    // timer fires (Opus 4.7 review [P2]).
    const remainingMs = Math.max(0, waitDeadline - Date.now());
    let outerTimer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      outerTimer = setTimeout(() => resolve('timeout'), remainingMs);
    });

    const outcome = await Promise.race([
      dispatchPromise.then(() => 'done' as const),
      timeoutPromise,
    ]);
    if (outerTimer) {
      clearTimeout(outerTimer);
      outerTimer = null;
    }

    const elapsedMs = Date.now() - startTs;
    const summary = chunks.join('').trim();

    if (outcome === 'timeout') {
      logger.warn(
        { sessionId, kind, elapsedMs, timeoutMs, chunksCount: chunks.length },
        'summarize: timeout',
      );
      return null;
    }
    if (errored && summary.length === 0) {
      logger.warn({ sessionId, kind, elapsedMs }, 'summarize: errored without text');
      return null;
    }
    if (!done && summary.length === 0) {
      logger.warn({ sessionId, kind, elapsedMs }, 'summarize: no text collected');
      return null;
    }

    // Cost transparency — log per call so the user can audit via journalctl /
    // log file (see plan §10 R2). We don't compute exact USD cost here (would
    // require per-adapter cost telemetry, deferred to v1.2). Char counts give
    // a rough proxy.
    logger.info(
      {
        sessionId,
        kind,
        elapsedMs,
        inputChars: content.length,
        outputChars: summary.length,
        agent: sess.agent,
      },
      'summarize: ok',
    );

    return summary;
  });
}
