import { randomUUID } from 'node:crypto';
import { logger } from '../util/logger.js';

/**
 * Generic question/option shape used by {@link AskQuestionBroker}.
 *
 * Intentionally NOT imported from `@anthropic-ai/claude-agent-sdk` so the
 * broker stays adapter-agnostic (R11 in spec). Any future adapter that needs
 * an option-picker UI can produce values matching this interface and reuse
 * the broker + prompter.
 *
 * Shape mirrors `AskUserQuestionInput.questions[*]` from
 * `@anthropic-ai/claude-agent-sdk@0.3.145` (`sdk-tools.d.ts:2137-2139`):
 *   - `question`     — full text shown to the user (required).
 *   - `header`       — short label (optional, e.g. "Database").
 *   - `options[*]`   — list of pickable options. `description` is optional.
 *   - `multiSelect`  — true → user can toggle multiple options; false →
 *                       single-select (first tap resolves).
 */
export interface AskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

/**
 * Inbound request to {@link AskQuestionBroker.askQuestion}.
 *
 * `toolUseID` is the SDK-provided correlation key. Two parallel sessions can
 * both raise an ask; using `toolUseID` as the pending-map key keeps them
 * disjoint (R10).
 */
export interface AskRequest {
  id: string;
  toolUseID: string;
  sessionId: string;
  chatId: number;
  sessionLabel: string;
  questions: AskQuestion[];
}

/**
 * Final result returned to the caller (Claude adapter) after the user has
 * answered every question OR cancelled / timed out.
 *
 * Shape mirrors `PermissionResult` from the Claude SDK so the adapter can
 * forward this verbatim with no further mapping:
 *   `{ behavior: 'allow', updatedInput: { questions, answers } }` on success
 *   `{ behavior: 'deny', message }` on cancel / timeout.
 */
export interface AskResult {
  behavior: 'allow' | 'deny';
  /**
   * Record of `question.question → answer`. For multi-select questions the
   * answer is a comma-separated string (consistent with the SDK convention
   * documented in `AskUserQuestionInput.answers`).
   */
  answers?: Record<string, string>;
  /** Human-readable reason on deny (e.g. "user cancelled"). */
  message?: string;
}

/**
 * UI driver that {@link AskQuestionBroker} delegates to. The broker holds
 * canonical state (pending map, timers, partial answers); the prompter holds
 * UI-only state (Telegram message ids, in-progress multi-select toggles).
 *
 * Pure interface — no Telegram / grammY imports here so the broker can be
 * unit-tested with a fake prompter.
 */
export interface AskPrompter {
  /** Render the FIRST question of `req` (subsequent advances are driven by
   * the prompter's own UI handlers after {@link AskQuestionBroker.submitAnswer}). */
  prompt(req: AskRequest): Promise<void>;
  /** Optional: surfaced when the broker times out a pending request. */
  notifyTimeout?(req: AskRequest): Promise<void>;
}

interface Pending {
  request: AskRequest;
  resolve: (r: AskResult) => void;
  timer: NodeJS.Timeout;
  /** Index of the question the user is currently answering. Starts at 0. */
  currentQuestionIdx: number;
  /** Accumulated answers keyed by question text. */
  answers: Record<string, string>;
}

export interface SubmitAnswerOk {
  ok: true;
  /** `null` when all questions answered (broker has resolved); else next idx. */
  nextQuestionIdx: number | null;
}

export interface SubmitAnswerErr {
  ok: false;
  error: string;
}

export type SubmitAnswerResult = SubmitAnswerOk | SubmitAnswerErr;

/**
 * Suspend-and-resume coordinator for the AskUserQuestion flow.
 *
 * Lifecycle:
 *   1. Caller (e.g. `claude.ts canUseTool`) builds an {@link AskRequest} from
 *      the SDK tool input and calls {@link askQuestion}. The broker assigns a
 *      UUID `id`, stores the pending entry, starts a timeout, and asks the
 *      attached {@link AskPrompter} to render question 0.
 *   2. The prompter renders an inline keyboard. When the user picks an option
 *      (single-select), confirms a multi-select, or replies with free-text,
 *      the callback handler calls {@link submitAnswer} with the answer.
 *   3. {@link submitAnswer} appends the answer to the pending entry. If more
 *      questions remain, it returns `{ ok: true, nextQuestionIdx }` so the
 *      prompter can advance UI. If this was the last question, the broker
 *      resolves the suspended promise with `{ behavior: 'allow', answers }`.
 *   4. The caller's `await` returns; it maps the result to `PermissionResult`.
 *
 * Errors:
 *   - {@link cancel} → resolves with `{ behavior: 'deny', message: 'user cancelled' }`.
 *   - Timeout → resolves with `{ behavior: 'deny', message: 'user did not answer within timeout' }`
 *     and invokes `prompter.notifyTimeout?` if registered.
 *   - Missing prompter → resolves with `{ behavior: 'deny', message: 'no prompter attached' }`.
 *   - Prompter throws → resolves with `{ behavior: 'deny', message: 'prompter failed' }`.
 *
 * Pure logic — no grammY / Telegram imports. State map keyed by `toolUseID`.
 * Safe for concurrent calls across sessions (R10): the SDK guarantees unique
 * `toolUseID` per call.
 */
export class AskQuestionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private prompter: AskPrompter | null = null;

  constructor(opts: { timeoutMs: number }) {
    this.timeoutMs = opts.timeoutMs;
  }

  attach(p: AskPrompter): void {
    this.prompter = p;
  }

  /**
   * Suspend the caller until the user answers all questions, cancels, or
   * times out. See class doc for full lifecycle.
   */
  askQuestion(req: Omit<AskRequest, 'id'>): Promise<AskResult> {
    const id = randomUUID();
    const full: AskRequest = { ...req, id };
    return new Promise<AskResult>((resolve) => {
      // Guard against the broker being used without a prompter wired in.
      // We still resolve (not reject) so the caller's await never blows up.
      if (!this.prompter) {
        logger.error(
          { toolUseID: req.toolUseID, sessionId: req.sessionId },
          'no ask prompter attached — auto-deny',
        );
        resolve({ behavior: 'deny', message: 'no prompter attached' });
        return;
      }
      const timer = setTimeout(() => {
        const p = this.pending.get(req.toolUseID);
        if (!p) return;
        this.pending.delete(req.toolUseID);
        logger.warn(
          { toolUseID: req.toolUseID, sessionId: req.sessionId },
          'ask question timeout',
        );
        this.prompter?.notifyTimeout?.(full).catch((err: unknown) => {
          logger.error({ err: String(err), toolUseID: req.toolUseID }, 'notifyTimeout failed');
        });
        resolve({
          behavior: 'deny',
          message: 'user did not answer within timeout',
        });
      }, this.timeoutMs);
      this.pending.set(req.toolUseID, {
        request: full,
        resolve,
        timer,
        currentQuestionIdx: 0,
        answers: {},
      });
      this.prompter.prompt(full).catch((err: unknown) => {
        logger.error({ err: String(err), toolUseID: req.toolUseID }, 'ask prompter failed');
        const p = this.pending.get(req.toolUseID);
        if (p) {
          this.pending.delete(req.toolUseID);
          clearTimeout(p.timer);
          resolve({ behavior: 'deny', message: 'prompter failed' });
        }
      });
    });
  }

  /**
   * Record an answer for the current question of a pending request.
   *
   * `answer` may be a `string` (single-select / free-text) or a `string[]`
   * (multi-select, joined with `, ` per SDK convention). Empty multi-select
   * arrays are rejected — per Q2 the user must pick ≥1 option or cancel.
   *
   * Returns:
   *   - `{ ok: true, nextQuestionIdx: N }` — more questions remain; prompter
   *     should render question N next.
   *   - `{ ok: true, nextQuestionIdx: null }` — last question answered;
   *     broker has resolved the pending promise.
   *   - `{ ok: false, error }` — unknown toolUseID, broker idle, bad input.
   */
  submitAnswer(
    toolUseID: string,
    questionText: string,
    answer: string | string[],
  ): SubmitAnswerResult {
    const p = this.pending.get(toolUseID);
    if (!p) return { ok: false, error: 'no pending request' };
    const expected = p.request.questions[p.currentQuestionIdx];
    if (!expected) {
      // Shouldn't happen — currentQuestionIdx is bounded by questions.length.
      // Defensive: clean up and deny.
      this.pending.delete(toolUseID);
      clearTimeout(p.timer);
      p.resolve({ behavior: 'deny', message: 'broker state corrupt' });
      return { ok: false, error: 'no question at currentQuestionIdx' };
    }
    // Reject mismatched question text — callers should pass the same string
    // we surfaced; mismatch means stale callback or a bug worth surfacing.
    if (expected.question !== questionText) {
      return { ok: false, error: 'question text mismatch' };
    }
    let answerStr: string;
    if (Array.isArray(answer)) {
      // Multi-select: ≥1 required (Q2). Empty arrays should never reach here
      // because the prompter rejects them on Done with a toast, but defend
      // anyway.
      if (answer.length === 0) return { ok: false, error: 'multi-select empty' };
      answerStr = answer.join(', ');
    } else {
      // Single-select / free-text: must be non-empty.
      if (answer.length === 0) return { ok: false, error: 'empty answer' };
      answerStr = answer;
    }
    p.answers[questionText] = answerStr;
    p.currentQuestionIdx += 1;
    if (p.currentQuestionIdx >= p.request.questions.length) {
      // All questions answered — resolve.
      this.pending.delete(toolUseID);
      clearTimeout(p.timer);
      p.resolve({ behavior: 'allow', answers: p.answers });
      return { ok: true, nextQuestionIdx: null };
    }
    return { ok: true, nextQuestionIdx: p.currentQuestionIdx };
  }

  /**
   * Cancel a pending request. Resolves the suspended promise with deny.
   * Returns true if a pending request was found and cancelled.
   */
  cancel(toolUseID: string): boolean {
    const p = this.pending.get(toolUseID);
    if (!p) return false;
    this.pending.delete(toolUseID);
    clearTimeout(p.timer);
    p.resolve({ behavior: 'deny', message: 'user cancelled' });
    return true;
  }

  /** Lookup helper for callback handlers / tests. */
  getPending(toolUseID: string): AskRequest | undefined {
    return this.pending.get(toolUseID)?.request;
  }

  /** Current question index for a pending request — used by callback handlers
   * to validate the qIdx in incoming `ask:pick:<id>:<qIdx>:<oIdx>` payloads. */
  getCurrentQuestionIdx(toolUseID: string): number | undefined {
    return this.pending.get(toolUseID)?.currentQuestionIdx;
  }
}
