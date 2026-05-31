import { describe, it, expect, vi } from 'vitest';
import {
  AskQuestionBroker,
  type AskPrompter,
  type AskQuestion,
  type AskRequest,
} from '../src/approval/ask-broker.js';

const Q_DB: AskQuestion = {
  question: 'Which DB do we use?',
  header: 'Database',
  multiSelect: false,
  options: [
    { label: 'PostgreSQL', description: 'battle-tested' },
    { label: 'MySQL', description: 'familiar to team' },
    { label: 'SQLite' },
  ],
};

const Q_FEATURES: AskQuestion = {
  question: 'Which features to enable?',
  header: 'Features',
  multiSelect: true,
  options: [
    { label: 'OAuth' },
    { label: 'SSO' },
    { label: '2FA' },
  ],
};

const Q_HEADER_ONLY: AskQuestion = {
  question: 'Pick framework?',
  multiSelect: false,
  options: [{ label: 'React' }, { label: 'Vue' }],
};

interface CapturedPrompt {
  req: AskRequest;
}

function makePrompter(opts?: {
  throwOnPrompt?: boolean;
  notifyTimeout?: AskPrompter['notifyTimeout'];
}): AskPrompter & { calls: CapturedPrompt[] } {
  const calls: CapturedPrompt[] = [];
  return {
    calls,
    async prompt(req) {
      calls.push({ req });
      if (opts?.throwOnPrompt) throw new Error('boom');
    },
    notifyTimeout: opts?.notifyTimeout,
  };
}

const baseReq = {
  toolUseID: 'tu-1',
  sessionId: 's1',
  chatId: 1,
  sessionLabel: 'main',
};

describe('AskQuestionBroker', () => {
  it('resolves a single-question request', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const p = broker.askQuestion({ ...baseReq, questions: [Q_DB] });

    // The pending entry should exist.
    expect(broker.getPending('tu-1')?.toolUseID).toBe('tu-1');

    const r = broker.submitAnswer('tu-1', Q_DB.question, 'PostgreSQL');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextQuestionIdx).toBeNull();

    await expect(p).resolves.toEqual({
      behavior: 'allow',
      answers: { 'Which DB do we use?': 'PostgreSQL' },
    });
    // Pending entry cleared after resolve.
    expect(broker.getPending('tu-1')).toBeUndefined();
  });

  it('resolves sequential multi-question batch', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const p = broker.askQuestion({
      ...baseReq,
      questions: [Q_DB, Q_FEATURES, Q_HEADER_ONLY],
    });

    // Q1 — single-select
    let r = broker.submitAnswer('tu-1', Q_DB.question, 'PostgreSQL');
    expect(r).toEqual({ ok: true, nextQuestionIdx: 1 });

    // Q2 — multi-select array
    r = broker.submitAnswer('tu-1', Q_FEATURES.question, ['OAuth', '2FA']);
    expect(r).toEqual({ ok: true, nextQuestionIdx: 2 });

    // Q3 — single-select free-text
    r = broker.submitAnswer('tu-1', Q_HEADER_ONLY.question, 'React');
    expect(r).toEqual({ ok: true, nextQuestionIdx: null });

    await expect(p).resolves.toEqual({
      behavior: 'allow',
      answers: {
        'Which DB do we use?': 'PostgreSQL',
        'Which features to enable?': 'OAuth, 2FA',
        'Pick framework?': 'React',
      },
    });
  });

  it('joins multi-select answer with comma-space', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const p = broker.askQuestion({ ...baseReq, questions: [Q_FEATURES] });

    broker.submitAnswer('tu-1', Q_FEATURES.question, ['OAuth', 'SSO', '2FA']);

    await expect(p).resolves.toEqual({
      behavior: 'allow',
      answers: { 'Which features to enable?': 'OAuth, SSO, 2FA' },
    });
  });

  it('rejects empty multi-select array', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const p = broker.askQuestion({ ...baseReq, questions: [Q_FEATURES] });

    const r = broker.submitAnswer('tu-1', Q_FEATURES.question, []);
    expect(r.ok).toBe(false);
    // Then submit a valid one so the promise resolves cleanly.
    broker.submitAnswer('tu-1', Q_FEATURES.question, ['OAuth']);
    await expect(p).resolves.toEqual({
      behavior: 'allow',
      answers: { 'Which features to enable?': 'OAuth' },
    });
  });

  it('rejects empty string answer', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const p = broker.askQuestion({ ...baseReq, questions: [Q_DB] });

    const r = broker.submitAnswer('tu-1', Q_DB.question, '');
    expect(r.ok).toBe(false);
    broker.submitAnswer('tu-1', Q_DB.question, 'MySQL');
    await p;
  });

  it('rejects mismatched question text', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const p = broker.askQuestion({ ...baseReq, questions: [Q_DB] });

    const r = broker.submitAnswer('tu-1', 'wrong text', 'PostgreSQL');
    expect(r).toEqual({ ok: false, error: 'question text mismatch' });

    broker.submitAnswer('tu-1', Q_DB.question, 'PostgreSQL');
    await p;
  });

  it('cancel resolves as deny "user cancelled"', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const p = broker.askQuestion({ ...baseReq, questions: [Q_DB] });

    const ok = broker.cancel('tu-1');
    expect(ok).toBe(true);
    await expect(p).resolves.toEqual({
      behavior: 'deny',
      message: 'user cancelled',
    });
    // Second cancel is a no-op (idempotent).
    expect(broker.cancel('tu-1')).toBe(false);
  });

  it('timeout resolves as deny "user did not answer within timeout"', async () => {
    vi.useFakeTimers();
    const notifyTimeout = vi.fn(async () => undefined);
    const broker = new AskQuestionBroker({ timeoutMs: 100 });
    broker.attach(makePrompter({ notifyTimeout }));
    const p = broker.askQuestion({ ...baseReq, questions: [Q_DB] });

    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toEqual({
      behavior: 'deny',
      message: 'user did not answer within timeout',
    });
    expect(notifyTimeout).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('submitAnswer after resolve is idempotent (returns error)', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const p = broker.askQuestion({ ...baseReq, questions: [Q_DB] });
    broker.submitAnswer('tu-1', Q_DB.question, 'PostgreSQL');
    await p;
    const r = broker.submitAnswer('tu-1', Q_DB.question, 'MySQL');
    expect(r).toEqual({ ok: false, error: 'no pending request' });
  });

  it('getPending returns undefined for unknown toolUseID', () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    expect(broker.getPending('nope')).toBeUndefined();
  });

  it('returns deny when no prompter attached', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    const r = await broker.askQuestion({ ...baseReq, questions: [Q_DB] });
    expect(r).toEqual({ behavior: 'deny', message: 'no prompter attached' });
  });

  it('prompter throw → deny "prompter failed"', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter({ throwOnPrompt: true }));
    const r = await broker.askQuestion({ ...baseReq, questions: [Q_DB] });
    expect(r).toEqual({ behavior: 'deny', message: 'prompter failed' });
  });

  it('attach replaces previous prompter', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    const p1 = makePrompter();
    const p2 = makePrompter();
    broker.attach(p1);
    broker.attach(p2);
    const p = broker.askQuestion({ ...baseReq, questions: [Q_DB] });
    expect(p1.calls).toHaveLength(0);
    expect(p2.calls).toHaveLength(1);
    broker.submitAnswer('tu-1', Q_DB.question, 'PostgreSQL');
    await p;
  });

  it('two concurrent requests with different toolUseIDs are isolated', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const pA = broker.askQuestion({
      ...baseReq,
      toolUseID: 'tu-A',
      sessionId: 'sA',
      questions: [Q_DB],
    });
    const pB = broker.askQuestion({
      ...baseReq,
      toolUseID: 'tu-B',
      sessionId: 'sB',
      questions: [Q_FEATURES],
    });

    broker.submitAnswer('tu-A', Q_DB.question, 'PostgreSQL');
    broker.submitAnswer('tu-B', Q_FEATURES.question, ['OAuth']);

    await expect(pA).resolves.toEqual({
      behavior: 'allow',
      answers: { 'Which DB do we use?': 'PostgreSQL' },
    });
    await expect(pB).resolves.toEqual({
      behavior: 'allow',
      answers: { 'Which features to enable?': 'OAuth' },
    });
  });

  it('getCurrentQuestionIdx tracks progression', async () => {
    const broker = new AskQuestionBroker({ timeoutMs: 5_000 });
    broker.attach(makePrompter());
    const p = broker.askQuestion({
      ...baseReq,
      questions: [Q_DB, Q_FEATURES],
    });
    expect(broker.getCurrentQuestionIdx('tu-1')).toBe(0);
    broker.submitAnswer('tu-1', Q_DB.question, 'PostgreSQL');
    expect(broker.getCurrentQuestionIdx('tu-1')).toBe(1);
    broker.submitAnswer('tu-1', Q_FEATURES.question, ['OAuth']);
    expect(broker.getCurrentQuestionIdx('tu-1')).toBeUndefined();
    await p;
  });
});
