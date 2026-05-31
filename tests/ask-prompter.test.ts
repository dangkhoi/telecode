import { describe, it, expect, beforeEach } from 'vitest';
import {
  TelegramAskPrompter,
  type AskNotifier,
  renderSingleQuestion,
} from '../src/bot/ask-prompter.js';
import {
  AskQuestionBroker,
  type AskQuestion,
  type AskRequest,
} from '../src/approval/ask-broker.js';

const CHAT_ID = 1234;

const QSingle: AskQuestion = {
  question: 'Which DB do we use?',
  header: 'Database',
  multiSelect: false,
  options: [
    { label: 'PostgreSQL', description: 'battle-tested' },
    { label: 'MySQL' },
    { label: 'SQLite' },
  ],
};

const QMulti: AskQuestion = {
  question: 'Which features to enable?',
  multiSelect: true,
  options: [{ label: 'OAuth' }, { label: 'SSO' }, { label: '2FA' }],
};

interface SendCall {
  text: string;
  extra: Record<string, unknown> | undefined;
}

interface EditCall {
  messageId: number;
  text: string;
  extra: Record<string, unknown> | undefined;
}

interface EditMarkupCall {
  messageId: number;
  replyMarkup: unknown;
}

function makeNotifier(): AskNotifier & {
  sendCalls: SendCall[];
  editCalls: EditCall[];
  editMarkupCalls: EditMarkupCall[];
  /** Counter so each sendPlain returns a distinct id. */
  next: number;
} {
  const sendCalls: SendCall[] = [];
  const editCalls: EditCall[] = [];
  const editMarkupCalls: EditMarkupCall[] = [];
  return {
    sendCalls,
    editCalls,
    editMarkupCalls,
    next: 100,
    async sendPlain(text, extra) {
      sendCalls.push({ text, extra: extra as Record<string, unknown> | undefined });
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this as { next: number };
      self.next += 1;
      return self.next;
    },
    async editPlain(messageId, text, extra) {
      editCalls.push({ messageId, text, extra });
    },
    async editReplyMarkup(messageId, replyMarkup) {
      editMarkupCalls.push({ messageId, replyMarkup });
    },
  };
}

interface InlineKeyboardLike {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

function extractKeyboard(extra: Record<string, unknown> | undefined): InlineKeyboardLike | null {
  const rm = extra?.reply_markup;
  if (!rm || typeof rm !== 'object') return null;
  return rm as InlineKeyboardLike;
}

describe('renderSingleQuestion', () => {
  it('includes counter when total > 1', () => {
    const text = renderSingleQuestion(QSingle, 0, 3);
    expect(text).toContain('Câu 1/3');
    expect(text).toContain('[Database] Which DB do we use?');
    expect(text).toContain('1. PostgreSQL — battle-tested');
    expect(text).toContain('2. MySQL');
  });

  it('omits counter when total = 1', () => {
    const text = renderSingleQuestion(QSingle, 0, 1);
    expect(text).not.toContain('Câu 1/1');
    expect(text).toContain('[Database] Which DB do we use?');
  });

  it('adds multi-select hint', () => {
    const text = renderSingleQuestion(QMulti, 0, 1);
    expect(text).toContain('Tap nhiều option');
  });

  it('handles missing header', () => {
    const q: AskQuestion = {
      question: 'Hello?',
      multiSelect: false,
      options: [{ label: 'Hi' }],
    };
    const text = renderSingleQuestion(q, 0, 1);
    expect(text.startsWith('Hello?')).toBe(true);
  });
});

describe('TelegramAskPrompter', () => {
  let broker: AskQuestionBroker;
  let prompter: TelegramAskPrompter;
  let notifier: ReturnType<typeof makeNotifier>;
  let req: AskRequest;
  const baseAutoSwitch = {
    store: {
      getChatState: () => ({ active_session_id: 'sess-1' }) as never,
      setActiveSession: () => {},
    },
    manager: { hasBuffered: () => false, drainBuffer: () => [] },
    notifierFor: (_: number) => notifier,
    wizardGuard: { isActive: () => false, deferUntilWizardExits: () => {} },
  };

  beforeEach(() => {
    broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    notifier = makeNotifier();
    prompter = new TelegramAskPrompter({
      notifierFor: () => notifier,
      broker,
      autoSwitch: baseAutoSwitch as never,
    });
    broker.attach(prompter);
    req = {
      id: 'r-1',
      toolUseID: 'tu-1',
      sessionId: 'sess-1',
      chatId: CHAT_ID,
      sessionLabel: 'main',
      questions: [QSingle],
    };
  });

  it('renders single-select keyboard with one button per option + Other + Cancel', async () => {
    await prompter.prompt(req);
    expect(notifier.sendCalls).toHaveLength(1);
    const kb = extractKeyboard(notifier.sendCalls[0]!.extra);
    expect(kb).not.toBeNull();
    // 3 option rows + 1 trailing row [Other, Cancel].
    expect(kb!.inline_keyboard).toHaveLength(4);
    expect(kb!.inline_keyboard[0]).toEqual([
      { text: 'PostgreSQL', callback_data: 'ask:pick:tu-1:0:0' },
    ]);
    expect(kb!.inline_keyboard[3]!.map((b) => b.text)).toEqual([
      '✏️ Other',
      '✖ Cancel',
    ]);
  });

  it('renders multi-select keyboard with toggle prefix + Done button', async () => {
    req.questions = [QMulti];
    await prompter.prompt(req);
    const kb = extractKeyboard(notifier.sendCalls[0]!.extra)!;
    // 3 option rows + 1 Done row + 1 [Other, Cancel] row = 5.
    expect(kb.inline_keyboard).toHaveLength(5);
    expect(kb.inline_keyboard[0]![0]!.text).toBe('☐ OAuth');
    expect(kb.inline_keyboard[3]![0]!.text).toBe('✅ Done');
  });

  it('single-select pick → finalize message + resolve broker', async () => {
    const p = broker.askQuestion({
      toolUseID: req.toolUseID,
      sessionId: req.sessionId,
      chatId: req.chatId,
      sessionLabel: req.sessionLabel,
      questions: req.questions,
    });
    // Wait for prompt to run.
    await new Promise((r) => setImmediate(r));
    const result = await prompter.handlePick('tu-1', 0, 0);
    expect(result).toEqual({ ok: true, toast: '✓ done' });
    // Edit was called to finalize the first message.
    expect(notifier.editCalls.length).toBeGreaterThanOrEqual(1);
    const finalize = notifier.editCalls[notifier.editCalls.length - 1]!;
    expect(finalize.text).toContain('✓ Which DB do we use? → PostgreSQL');
    // Empty inline_keyboard clears the buttons on Telegram (omitting
    // reply_markup on editMessageText would leave the original keyboard).
    expect(finalize.extra?.reply_markup).toEqual({ inline_keyboard: [] });
    await expect(p).resolves.toEqual({
      behavior: 'allow',
      answers: { 'Which DB do we use?': 'PostgreSQL' },
    });
  });

  it('multi-select toggle then Done → comma-separated answer', async () => {
    req.questions = [QMulti];
    const p = broker.askQuestion({
      toolUseID: req.toolUseID,
      sessionId: req.sessionId,
      chatId: req.chatId,
      sessionLabel: req.sessionLabel,
      questions: req.questions,
    });
    await new Promise((r) => setImmediate(r));

    let r = await prompter.handlePick('tu-1', 0, 0); // OAuth
    expect(r.ok).toBe(true);
    r = await prompter.handlePick('tu-1', 0, 2); // 2FA
    expect(r.ok).toBe(true);
    // Two keyboard re-renders (one per toggle).
    expect(notifier.editMarkupCalls).toHaveLength(2);

    // Done with no further selection → resolve.
    r = await prompter.handleDone('tu-1', 0);
    expect(r).toEqual({ ok: true, toast: '✓ done' });

    await expect(p).resolves.toEqual({
      behavior: 'allow',
      answers: { 'Which features to enable?': 'OAuth, 2FA' },
    });
  });

  it('multi-select Done with 0 selected → rejects with toast', async () => {
    req.questions = [QMulti];
    void broker.askQuestion({
      toolUseID: req.toolUseID,
      sessionId: req.sessionId,
      chatId: req.chatId,
      sessionLabel: req.sessionLabel,
      questions: req.questions,
    });
    await new Promise((r) => setImmediate(r));
    const r = await prompter.handleDone('tu-1', 0);
    expect(r).toEqual({ ok: false, toast: 'Chọn ít nhất 1 option' });
    // Broker still pending.
    expect(broker.getPending('tu-1')).toBeDefined();
    // Clean up.
    broker.cancel('tu-1');
  });

  it('multi-question batch advances to next question', async () => {
    req.questions = [QSingle, QMulti];
    const p = broker.askQuestion({
      toolUseID: req.toolUseID,
      sessionId: req.sessionId,
      chatId: req.chatId,
      sessionLabel: req.sessionLabel,
      questions: req.questions,
    });
    await new Promise((r) => setImmediate(r));

    expect(notifier.sendCalls).toHaveLength(1);
    // Q1 — pick MySQL.
    await prompter.handlePick('tu-1', 0, 1);
    // New message sent for Q2.
    expect(notifier.sendCalls).toHaveLength(2);
    // Edit finalized Q1 message.
    expect(notifier.editCalls.length).toBeGreaterThanOrEqual(1);
    const q1Final = notifier.editCalls[0]!;
    expect(q1Final.text).toContain('✓ Which DB do we use? → MySQL');
    // Q2 has Done button.
    const kb2 = extractKeyboard(notifier.sendCalls[1]!.extra)!;
    expect(kb2.inline_keyboard.some((row) => row.some((b) => b.text === '✅ Done'))).toBe(true);

    // Q2 — pick OAuth + Done.
    await prompter.handlePick('tu-1', 1, 0);
    await prompter.handleDone('tu-1', 1);

    await expect(p).resolves.toEqual({
      behavior: 'allow',
      answers: {
        'Which DB do we use?': 'MySQL',
        'Which features to enable?': 'OAuth',
      },
    });
  });

  it('cancel callback → broker resolves as deny + UI finalized', async () => {
    const p = broker.askQuestion({
      toolUseID: req.toolUseID,
      sessionId: req.sessionId,
      chatId: req.chatId,
      sessionLabel: req.sessionLabel,
      questions: req.questions,
    });
    await new Promise((r) => setImmediate(r));
    const r = await prompter.handleCancel('tu-1');
    expect(r.ok).toBe(true);
    await expect(p).resolves.toEqual({
      behavior: 'deny',
      message: 'user cancelled',
    });
    const cancelEdit = notifier.editCalls.find((e) => e.text.includes('✖ Cancelled'));
    expect(cancelEdit).toBeDefined();
  });

  it('notifyTimeout edits the active question to ⌛ Timeout', async () => {
    void broker.askQuestion({
      toolUseID: req.toolUseID,
      sessionId: req.sessionId,
      chatId: req.chatId,
      sessionLabel: req.sessionLabel,
      questions: req.questions,
    });
    await new Promise((r) => setImmediate(r));
    await prompter.notifyTimeout(req);
    const timeoutEdit = notifier.editCalls.find((e) => e.text.includes('⌛ Timeout'));
    expect(timeoutEdit).toBeDefined();
    // Empty inline_keyboard clears buttons (see comment in finalize test).
    expect(timeoutEdit!.extra?.reply_markup).toEqual({ inline_keyboard: [] });
    // Cleanup needed so vitest doesn't hang on dangling pending entry.
    broker.cancel('tu-1');
  });

  it('free-text reply consumed → answer = trimmed text', async () => {
    const p = broker.askQuestion({
      toolUseID: req.toolUseID,
      sessionId: req.sessionId,
      chatId: req.chatId,
      sessionLabel: req.sessionLabel,
      questions: req.questions,
    });
    await new Promise((r) => setImmediate(r));
    const prompt = prompter.buildFreeTextPrompt('tu-1', 0);
    expect(prompt.ok).toBe(true);
    // Simulate sending the force_reply prompt and registering it.
    prompter.registerFreeTextWaiting('tu-1', 0, 555);

    const consumed = await prompter.consumeFreeTextReply(CHAT_ID, 555, '  Cassandra  ');
    expect(consumed).toBe(true);
    await expect(p).resolves.toEqual({
      behavior: 'allow',
      answers: { 'Which DB do we use?': 'Cassandra' },
    });
  });

  it('consumeFreeTextReply returns false for unknown reply', async () => {
    const consumed = await prompter.consumeFreeTextReply(CHAT_ID, 9999, 'hi');
    expect(consumed).toBe(false);
  });

  it('handlePick on stale qIdx is rejected', async () => {
    void broker.askQuestion({
      toolUseID: req.toolUseID,
      sessionId: req.sessionId,
      chatId: req.chatId,
      sessionLabel: req.sessionLabel,
      questions: req.questions,
    });
    await new Promise((r) => setImmediate(r));
    const r = await prompter.handlePick('tu-1', 99, 0);
    expect(r).toEqual({ ok: false, toast: 'stale tap' });
    broker.cancel('tu-1');
  });

  it('handlePick / handleCancel on unknown toolUseID → expired toast', async () => {
    const r1 = await prompter.handlePick('nope', 0, 0);
    expect(r1).toEqual({ ok: false, toast: 'expired' });
    const r2 = await prompter.handleCancel('nope');
    expect(r2).toEqual({ ok: true, toast: '✖ cancelled' });
  });
});
