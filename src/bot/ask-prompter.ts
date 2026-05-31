import type { InlineKeyboardButton } from 'grammy/types';
import type {
  AskQuestionBroker,
  AskPrompter,
  AskRequest,
  AskQuestion,
} from '../approval/ask-broker.js';
import { logger } from '../util/logger.js';
import { runAutoSwitchForChat, type AutoSwitchDeps } from './auto-switch.js';

/**
 * Subset of Notifier used by the AskPrompter. Declared structurally so
 * tests can pass a mock.
 */
export interface AskNotifier {
  sendPlain(
    text: string,
    extra?: Record<string, unknown> & { silent?: boolean },
  ): Promise<number | null>;
  editPlain(
    messageId: number,
    text: string,
    extra?: { reply_markup?: unknown },
  ): Promise<void>;
  editReplyMarkup(messageId: number, replyMarkup?: unknown): Promise<void>;
}

export interface AskPrompterDeps {
  notifierFor: (chatId: number) => AskNotifier;
  /** Wire to AskQuestionBroker so callbacks can submit answers / cancel. */
  broker: AskQuestionBroker;
  /** Deps for `runAutoSwitchForChat` — reused from the approval prompter. */
  autoSwitch: Omit<AutoSwitchDeps, 'hasOtherPendingFor'>;
}

interface PromptUiState {
  /** Telegram message id of the LATEST rendered question. Edited on advance. */
  messageId: number | null;
  /** Question index currently displayed (mirrors broker.currentQuestionIdx). */
  qIdx: number;
  /** Multi-select toggle state for the current question (label → on?). */
  multiSelect: Set<string>;
  /** Pending free-text reply lookup: replyToMessageId → qIdx. */
  freeTextWaiting: Map<number, number>;
  /** Chat id (for editing messages on cancel/timeout). */
  chatId: number;
  /** Session label (for header / cancel toast). */
  sessionLabel: string;
  /** Captured request reference so callbacks have all metadata. */
  req: AskRequest;
}

/**
 * Pre-compose label + description for an option. Keeps the rendered button
 * short (Telegram caps button text at ~64 chars displayed) — descriptions go
 * into the body text, not the button.
 */
function optionButtonLabel(opt: { label: string; description?: string }): string {
  // Cap at 60 chars so multi-byte emoji prefixes don't blow the cap.
  const raw = opt.label;
  return raw.length > 60 ? raw.slice(0, 59) + '…' : raw;
}

/**
 * Render the BODY text of a single question (header + question + options +
 * descriptions). Used as the message text below which the keyboard sits.
 *
 * Pure helper so callers can compose with header "Câu N/Total" without
 * coupling to grammY.
 */
export function renderSingleQuestion(
  q: AskQuestion,
  idx: number,
  total: number,
): string {
  const headerPart = q.header ? `[${q.header}] ` : '';
  const counter = total > 1 ? `Câu ${idx + 1}/${total}\n` : '';
  const lines: string[] = [];
  lines.push(`${counter}${headerPart}${q.question}`);
  if (q.options.length > 0) {
    lines.push('');
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i]!;
      const desc = opt.description ? ` — ${opt.description}` : '';
      lines.push(`${i + 1}. ${opt.label}${desc}`);
    }
  }
  if (q.multiSelect) {
    lines.push('');
    lines.push('Tap nhiều option để toggle. Bấm ✅ Done khi xong.');
  }
  return lines.join('\n');
}

function buildKeyboard(
  q: AskQuestion,
  toolUseID: string,
  qIdx: number,
  selected: Set<string>,
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let oIdx = 0; oIdx < q.options.length; oIdx++) {
    const opt = q.options[oIdx]!;
    const label = optionButtonLabel(opt);
    const prefix = q.multiSelect
      ? selected.has(opt.label)
        ? '☑ '
        : '☐ '
      : '';
    rows.push([
      {
        text: `${prefix}${label}`,
        callback_data: `ask:pick:${toolUseID}:${qIdx}:${oIdx}`,
      },
    ]);
  }
  // Multi-select needs an explicit Done button.
  if (q.multiSelect) {
    rows.push([
      {
        text: '✅ Done',
        callback_data: `ask:done:${toolUseID}:${qIdx}`,
      },
    ]);
  }
  // Common trailing row: Other + Cancel.
  rows.push([
    {
      text: '✏️ Other',
      callback_data: `ask:other:${toolUseID}:${qIdx}`,
    },
    {
      text: '✖ Cancel',
      callback_data: `ask:cancel:${toolUseID}`,
    },
  ]);
  return rows;
}

/**
 * AskPrompter implementation backed by Notifier (grammY).
 *
 * Responsibilities:
 *   - Auto-switch active session before showing the first question (R9).
 *   - Render each question as a Telegram message with an inline keyboard.
 *   - Track multi-select toggle state (UI-only; broker holds final answer).
 *   - On advance, edit the previous question into a "✓ <q> → <answer>" line
 *     and send the next question as a NEW message.
 *   - On timeout, edit the active question into a "⌛ Timeout" line and clear
 *     the keyboard.
 *   - Bridge free-text "Other" replies via `consumeFreeTextReply`.
 */
export class TelegramAskPrompter implements AskPrompter {
  /** UI state keyed by toolUseID. */
  private readonly state = new Map<string, PromptUiState>();
  /**
   * Reverse lookup for free-text replies: (chatId, replyToMessageId) → toolUseID.
   * Free-text waits live in PromptUiState too, but a flat reverse map lets the
   * text-message handler do an O(1) lookup without iterating every pending ask.
   */
  private readonly freeTextIndex = new Map<string, string>();

  constructor(private readonly deps: AskPrompterDeps) {}

  async prompt(req: AskRequest): Promise<void> {
    // Seed UI state FIRST so any callback that arrives during auto-switch /
    // render can find the entry (returns a benign "no message yet" race
    // window instead of "expired"). The renderQuestion path populates
    // `messageId` after sendPlain.
    const ui: PromptUiState = {
      messageId: null,
      qIdx: 0,
      multiSelect: new Set<string>(),
      freeTextWaiting: new Map<number, number>(),
      chatId: req.chatId,
      sessionLabel: req.sessionLabel,
      req,
    };
    this.state.set(req.toolUseID, ui);

    // 1) Auto-switch active session if needed. AskUserQuestion is by nature a
    // foreground event — the user needs to see the question to answer it.
    try {
      await runAutoSwitchForChat({
        chatId: req.chatId,
        sessionId: req.sessionId,
        sessionLabel: req.sessionLabel,
        deps: this.deps.autoSwitch,
      });
    } catch (err) {
      // Auto-switch failure is non-fatal — surface the question anyway.
      logger.warn(
        { err: String(err), toolUseID: req.toolUseID },
        'ask auto-switch failed (continuing)',
      );
    }

    // 2) Render question 0.
    await this.renderQuestion(req, 0);
  }

  async notifyTimeout(req: AskRequest): Promise<void> {
    const ui = this.state.get(req.toolUseID);
    if (!ui || ui.messageId == null) {
      this.cleanupState(req.toolUseID);
      return;
    }
    const n = this.deps.notifierFor(ui.chatId);
    const q = req.questions[ui.qIdx];
    const qText = q?.question ?? '';
    try {
      // Pass an empty `inline_keyboard` so Telegram clears the buttons —
      // omitting `reply_markup` on `editMessageText` leaves the original
      // keyboard intact (Bot API behavior; see grammY docs §editMessageText).
      await n.editPlain(
        ui.messageId,
        `[${ui.sessionLabel}] ⌛ Timeout — Claude sẽ tiếp tục mà không có câu trả lời\n${qText}`,
        { reply_markup: { inline_keyboard: [] } },
      );
    } catch (err) {
      logger.warn({ err: String(err), toolUseID: req.toolUseID }, 'ask timeout edit failed');
    }
    this.cleanupState(req.toolUseID);
  }

  /**
   * Render the question at `qIdx` for `req`. Creates a NEW message; the
   * previous message (if any) is finalized via {@link finalizePreviousQuestion}
   * by the caller BEFORE calling this.
   */
  private async renderQuestion(req: AskRequest, qIdx: number): Promise<void> {
    const ui = this.state.get(req.toolUseID);
    if (!ui) return;
    const q = req.questions[qIdx];
    if (!q) return;
    const n = this.deps.notifierFor(req.chatId);
    const body = `[${req.sessionLabel}] ❓ ${renderSingleQuestion(q, qIdx, req.questions.length)}`;
    const keyboard = buildKeyboard(q, req.toolUseID, qIdx, ui.multiSelect);
    try {
      const msgId = await n.sendPlain(body, {
        reply_markup: { inline_keyboard: keyboard },
      });
      ui.messageId = msgId;
      ui.qIdx = qIdx;
      ui.multiSelect = new Set<string>(); // reset multi-select per question
    } catch (err) {
      logger.error(
        { err: String(err), toolUseID: req.toolUseID, qIdx },
        'ask renderQuestion failed',
      );
    }
  }

  /**
   * Edit the current question's message into a finalized "✓ q → answer" line
   * (no keyboard). Called BEFORE rendering the next question OR before
   * resolving.
   */
  private async finalizeCurrentMessage(
    toolUseID: string,
    finalAnswer: string,
  ): Promise<void> {
    const ui = this.state.get(toolUseID);
    if (!ui || ui.messageId == null) return;
    const q = ui.req.questions[ui.qIdx];
    if (!q) return;
    const n = this.deps.notifierFor(ui.chatId);
    try {
      // Empty `inline_keyboard` to clear buttons — see note in notifyTimeout.
      await n.editPlain(
        ui.messageId,
        `[${ui.sessionLabel}] ✓ ${q.question} → ${finalAnswer}`,
        { reply_markup: { inline_keyboard: [] } },
      );
    } catch (err) {
      logger.warn(
        { err: String(err), toolUseID, qIdx: ui.qIdx },
        'ask finalize edit failed',
      );
    }
  }

  /**
   * Public callback API — invoked by the router's `ask:pick` handler.
   *
   * Returns a status string suitable for `answerCallbackQuery({ text })`.
   */
  async handlePick(
    toolUseID: string,
    qIdx: number,
    oIdx: number,
  ): Promise<{ ok: true; toast: string } | { ok: false; toast: string }> {
    const ui = this.state.get(toolUseID);
    if (!ui) return { ok: false, toast: 'expired' };
    if (qIdx !== ui.qIdx) return { ok: false, toast: 'stale tap' };
    const q = ui.req.questions[qIdx];
    if (!q) return { ok: false, toast: 'no question' };
    const opt = q.options[oIdx];
    if (!opt) return { ok: false, toast: 'no option' };

    if (q.multiSelect) {
      // Toggle and re-render keyboard in place.
      if (ui.multiSelect.has(opt.label)) {
        ui.multiSelect.delete(opt.label);
      } else {
        ui.multiSelect.add(opt.label);
      }
      if (ui.messageId != null) {
        const n = this.deps.notifierFor(ui.chatId);
        const keyboard = buildKeyboard(q, toolUseID, qIdx, ui.multiSelect);
        await n.editReplyMarkup(ui.messageId, { inline_keyboard: keyboard });
      }
      return { ok: true, toast: ui.multiSelect.has(opt.label) ? `+ ${opt.label}` : `- ${opt.label}` };
    }

    // Single-select: finalize immediately.
    return this.submitAndAdvance(toolUseID, q.question, opt.label);
  }

  async handleDone(
    toolUseID: string,
    qIdx: number,
  ): Promise<{ ok: true; toast: string } | { ok: false; toast: string }> {
    const ui = this.state.get(toolUseID);
    if (!ui) return { ok: false, toast: 'expired' };
    if (qIdx !== ui.qIdx) return { ok: false, toast: 'stale tap' };
    const q = ui.req.questions[qIdx];
    if (!q || !q.multiSelect) return { ok: false, toast: 'not multi-select' };
    if (ui.multiSelect.size === 0) {
      // Q2 — reject empty selection with toast.
      return { ok: false, toast: 'Chọn ít nhất 1 option' };
    }
    const selected = Array.from(ui.multiSelect);
    return this.submitAndAdvance(toolUseID, q.question, selected);
  }

  /**
   * Set up a free-text waiting entry. Returns the body of the prompt the
   * caller should send (with `force_reply: true`). The caller is responsible
   * for sending that message + registering the resulting message_id via
   * {@link registerFreeTextWaiting}.
   */
  buildFreeTextPrompt(
    toolUseID: string,
    qIdx: number,
  ): { ok: true; text: string } | { ok: false; toast: string } {
    const ui = this.state.get(toolUseID);
    if (!ui) return { ok: false, toast: 'expired' };
    if (qIdx !== ui.qIdx) return { ok: false, toast: 'stale tap' };
    const q = ui.req.questions[qIdx];
    if (!q) return { ok: false, toast: 'no question' };
    return {
      ok: true,
      text: `[${ui.sessionLabel}] ✏️ Trả lời tự do cho câu: "${q.question}" (reply tin này)`,
    };
  }

  /**
   * Register the message id of the force_reply prompt so that text replies
   * pointing at it can be routed back here.
   */
  registerFreeTextWaiting(
    toolUseID: string,
    qIdx: number,
    promptMessageId: number,
  ): void {
    const ui = this.state.get(toolUseID);
    if (!ui) return;
    ui.freeTextWaiting.set(promptMessageId, qIdx);
    this.freeTextIndex.set(`${ui.chatId}:${promptMessageId}`, toolUseID);
  }

  /**
   * Called by the text-message handler in `commands/index.ts` BEFORE
   * dispatching the prompt to the active session.
   *
   * Returns true if the text was consumed as a free-text answer.
   */
  async consumeFreeTextReply(
    chatId: number,
    replyToMessageId: number,
    text: string,
  ): Promise<boolean> {
    const key = `${chatId}:${replyToMessageId}`;
    const toolUseID = this.freeTextIndex.get(key);
    if (!toolUseID) return false;
    const ui = this.state.get(toolUseID);
    if (!ui) {
      this.freeTextIndex.delete(key);
      return false;
    }
    const qIdx = ui.freeTextWaiting.get(replyToMessageId);
    if (qIdx == null) return false;
    if (qIdx !== ui.qIdx) {
      // Stale free-text — user took too long and we advanced past it.
      ui.freeTextWaiting.delete(replyToMessageId);
      this.freeTextIndex.delete(key);
      return false;
    }
    const q = ui.req.questions[qIdx];
    if (!q) return false;
    // Drop the waiting entry whether we succeed or not — one shot.
    ui.freeTextWaiting.delete(replyToMessageId);
    this.freeTextIndex.delete(key);
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    await this.submitAndAdvance(toolUseID, q.question, trimmed);
    return true;
  }

  async handleCancel(toolUseID: string): Promise<{ ok: true; toast: string }> {
    const ui = this.state.get(toolUseID);
    if (ui && ui.messageId != null) {
      const n = this.deps.notifierFor(ui.chatId);
      try {
        const q = ui.req.questions[ui.qIdx];
        // Empty `inline_keyboard` to clear buttons — see note in notifyTimeout.
        await n.editPlain(
          ui.messageId,
          `[${ui.sessionLabel}] ✖ Cancelled — ${q?.question ?? ''}`,
          { reply_markup: { inline_keyboard: [] } },
        );
      } catch (err) {
        logger.warn({ err: String(err), toolUseID }, 'ask cancel edit failed');
      }
    }
    this.deps.broker.cancel(toolUseID);
    this.cleanupState(toolUseID);
    return { ok: true, toast: '✖ cancelled' };
  }

  /**
   * Submit an answer to the broker, finalize the current message, and
   * either render the next question or (if last) leave the finalized
   * message as the final state.
   */
  private async submitAndAdvance(
    toolUseID: string,
    questionText: string,
    answer: string | string[],
  ): Promise<{ ok: true; toast: string } | { ok: false; toast: string }> {
    const ui = this.state.get(toolUseID);
    if (!ui) return { ok: false, toast: 'expired' };
    const result = this.deps.broker.submitAnswer(toolUseID, questionText, answer);
    if (!result.ok) {
      return { ok: false, toast: result.error };
    }
    const finalAnswer = Array.isArray(answer) ? answer.join(', ') : answer;
    await this.finalizeCurrentMessage(toolUseID, finalAnswer);
    if (result.nextQuestionIdx == null) {
      // Done — cleanup UI state. Broker has already resolved the promise.
      this.cleanupState(toolUseID);
      return { ok: true, toast: '✓ done' };
    }
    await this.renderQuestion(ui.req, result.nextQuestionIdx);
    return { ok: true, toast: '✓' };
  }

  private cleanupState(toolUseID: string): void {
    const ui = this.state.get(toolUseID);
    if (ui) {
      for (const msgId of ui.freeTextWaiting.keys()) {
        this.freeTextIndex.delete(`${ui.chatId}:${msgId}`);
      }
    }
    this.state.delete(toolUseID);
  }
}
