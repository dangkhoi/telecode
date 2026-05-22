/**
 * Phase D.4 — Auto done-summary.
 *
 * Verifies the behaviour of the `done` branch of the dispatcher:
 *
 *   - ALL four modes (summary/normal/thinking/verbose): emit
 *     `✅ Done · {duration}s · ${cost}` first, then run summarizeWithSession on
 *     the captured full turn text, then EDIT the done message to append the
 *     agent's summary. (v1.3 spec done-summary-all-modes §D1/R1 — was
 *     summary|normal only.)
 *   - summarize timeout / null: keep the enhanced tail; AND when streaming was
 *     suppressed this turn (summary mode) send the raw captured turn text so
 *     content is never lost (§D4/R3 guaranteed content). When text was streamed
 *     live (normal/thinking/verbose) no raw dump — the user already saw it.
 *   - summarize success in summary mode: summary is the only surface — the raw
 *     turn text is NOT also sent (no double-send).
 *   - session.status = waiting_approval (defensive): skip summarize.
 *   - session without sdk_session_id: skip summarize, but still surface raw
 *     turn text if streaming was suppressed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import { SessionStore, type SessionRow } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import { registerCommands, type CommandDeps } from '../src/bot/commands/index.js';
import type { TelecodeConfig } from '../src/config.js';
import type { ApprovalBroker } from '../src/approval/broker.js';
import type { PolicyEngine } from '../src/approval/policy.js';
import type { AgentAdapter, AgentStartOpts, AgentEvent } from '../src/agents/types.js';
import type { AgentKind } from '../src/session/store.js';
import type { Notifier } from '../src/bot/notifier.js';
import { summarizeMutexes } from '../src/agents/summarize.js';
import { _resetSummaryCache } from '../src/bot/summary-cache.js';

const CHAT_ID = 9401;
const RESUME_ID = 'sdk-resume-d4';

type MessageTextHandler = (ctx: unknown) => Promise<unknown> | unknown;

function makeBotSpy(): { bot: Bot; getHandler: () => MessageTextHandler } {
  let captured: MessageTextHandler | null = null;
  const bot = {
    command: vi.fn(),
    on: vi.fn((event: string, h: MessageTextHandler) => {
      if (event === 'message:text') captured = h;
      return bot;
    }),
  } as unknown as Bot;
  return {
    bot,
    getHandler: () => {
      if (!captured) throw new Error('message:text handler missing');
      return captured;
    },
  };
}

function makeNotifier(): {
  notifier: Notifier;
  sendPlain: ReturnType<typeof vi.fn>;
  editPlain: ReturnType<typeof vi.fn>;
} {
  let nextId = 2000;
  const sendPlain = vi.fn(async () => nextId++);
  const editPlain = vi.fn(async () => {});
  // editPlainChunked mirrors editPlain in tests (no chunking needed) — the
  // chunked variant simply edits in place when input fits, and the test
  // payloads never exceed the per-message limit.
  const editPlainChunked = vi.fn(async (msgId: number, text: string) => {
    await editPlain(msgId, text);
    return [];
  });
  const sendChunked = vi.fn(async (text: string) => {
    const id = await sendPlain(text);
    return [id];
  });
  const notifier = {
    appendStream: vi.fn(),
    sendPlain,
    closeStream: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    send: sendPlain,
    answerCallback: vi.fn(async () => {}),
    editPlain,
    editPlainChunked,
    sendChunked,
    editReplyMarkup: vi.fn(async () => {}),
    sendMarkdownV2: sendPlain,
  } as unknown as Notifier;
  return { notifier, sendPlain, editPlain };
}

class FakeRegistry {
  constructor(private adapter: AgentAdapter) {}
  get(_k: AgentKind): AgentAdapter {
    return this.adapter;
  }
  require(_k: AgentKind): AgentAdapter {
    return this.adapter;
  }
  has(_k: AgentKind): boolean {
    return true;
  }
  kinds(): string[] {
    return [this.adapter.kind];
  }
  list(): { kind: string; displayName: string; badge: string }[] {
    return [{ kind: this.adapter.kind, displayName: this.adapter.kind, badge: '·' }];
  }
}

function multiTurnAdapter(opts: { summaryText: string | null }): {
  adapter: AgentAdapter;
  primary: Promise<{ emit: (e: AgentEvent) => void; finish: () => void }>;
  summaryStarted: () => boolean;
} {
  let primaryResolve!: (v: { emit: (e: AgentEvent) => void; finish: () => void }) => void;
  const primary = new Promise<{ emit: (e: AgentEvent) => void; finish: () => void }>(
    (r) => (primaryResolve = r),
  );
  let runCount = 0;
  let summaryStarted = false;
  const adapter: AgentAdapter = {
    kind: 'claude',
    async run(o: AgentStartOpts) {
      runCount++;
      if (runCount === 1) {
        let resolveDone!: () => void;
        const done = new Promise<void>((r) => (resolveDone = r));
        primaryResolve({ emit: (e) => o.onEvent(e), finish: resolveDone });
        await done;
        return;
      }
      summaryStarted = true;
      if (opts.summaryText === null) {
        o.onEvent({ type: 'error', error: 'summarize failed' });
        o.onEvent({ type: 'done' });
      } else {
        o.onEvent({ type: 'text', text: opts.summaryText });
        o.onEvent({ type: 'done' });
      }
    },
  };
  return { adapter, primary, summaryStarted: () => summaryStarted };
}

interface Harness {
  store: SessionStore;
  manager: SessionManager;
  sendPlain: ReturnType<typeof vi.fn>;
  editPlain: ReturnType<typeof vi.fn>;
  a: SessionRow;
  cleanup: () => void;
  primary: Awaited<ReturnType<typeof multiTurnAdapter>['primary']>;
  summaryStarted: () => boolean;
}

async function setup(opts: {
  mode?: 'summary' | 'normal' | 'thinking' | 'verbose';
  withResume?: boolean;
  status?: 'idle' | 'waiting_approval';
  transcript?: string;
  summaryText: string | null;
}): Promise<Harness> {
  const d = mkdtempSync(join(tmpdir(), 'telecode-d4-'));
  const store = new SessionStore(join(d, 's.db'));
  const m = multiTurnAdapter({ summaryText: opts.summaryText });
  const manager = new SessionManager(store, new FakeRegistry(m.adapter) as never, {
    bufferCapBytes: 5000,
  });
  const { notifier, sendPlain, editPlain } = makeNotifier();
  const { bot, getHandler } = makeBotSpy();

  const deps: CommandDeps = {
    config: {
      defaults: { agent: 'claude' },
      session_switch_preview_lines: 3,
    } as unknown as TelecodeConfig,
    store,
    manager,
    broker: {} as ApprovalBroker,
    policy: {} as PolicyEngine,
    registry: new FakeRegistry(m.adapter) as never,
    notifierFor: () => notifier,
  };
  registerCommands(bot, deps);

  const a = manager.createSession({
    chatId: CHAT_ID,
    agent: 'claude',
    label: 'A',
    projectId: null,
  });
  if (opts.withResume !== false) {
    store.updateSession(a.id, { sdk_session_id: RESUME_ID });
  }
  store.setActiveSession(CHAT_ID, a.id);
  store.setChatDefaultMode(CHAT_ID, opts.mode ?? 'normal');
  if (opts.transcript !== undefined) {
    store.appendTranscript(a.id, opts.transcript);
  }

  const handler = getHandler();
  void handler({
    message: { text: 'go' },
    chat: { id: CHAT_ID },
    reply: vi.fn(async () => ({ message_id: 1 })),
  });
  const primary = await m.primary;

  // Defensively flip status — set after dispatch started.
  if (opts.status === 'waiting_approval') {
    store.updateSession(a.id, { status: 'waiting_approval' });
  }

  sendPlain.mockClear();
  editPlain.mockClear();

  return {
    store,
    manager,
    sendPlain,
    editPlain,
    a,
    cleanup: () => {
      primary.finish();
      rmSync(d, { recursive: true, force: true });
    },
    primary,
    summaryStarted: m.summaryStarted,
  };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  summarizeMutexes.clear();
  _resetSummaryCache();
});
afterEach(() => {
  summarizeMutexes.clear();
  _resetSummaryCache();
});

describe('Phase D.4 — auto done-summary', () => {
  it('normal mode: emits enhanced "✅ Done · Xs · $cost" tail + summary edit', async () => {
    const h = await setup({
      mode: 'normal',
      transcript: 'tested 3 files',
      summaryText: 'Đã chạy npm test, 432 pass.',
    });
    try {
      // Emit done with realistic cost+duration.
      h.primary.emit({
        type: 'done',
        durationMs: 47_000,
        totalCostUsd: 0.0231,
        result: 'success',
      });
      h.primary.finish();
      await flush(50);

      // The done tail must be the enhanced "✅ Done · 47s · $0.0231".
      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      const doneSend = sendTexts.find((t) => t.includes('✅ Done · 47s · $0.0231'));
      expect(doneSend).toBeDefined();
      // After summarize lands, editPlain should fire with the summary
      // appended.
      const editTexts = h.editPlain.mock.calls.map((c) => c[1]) as string[];
      const editWithSummary = editTexts.find((t) =>
        t.includes('Đã chạy npm test, 432 pass.'),
      );
      expect(editWithSummary).toBeDefined();
      expect(editWithSummary).toContain('✅ Done · 47s · $0.0231');
      // Original transcript content was passed to the adapter — summary was
      // actually fired.
      expect(h.summaryStarted()).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('verbose mode: v1.3 NOW fires done-summary too (R1 — every mode summarizes)', async () => {
    const h = await setup({
      mode: 'verbose',
      transcript: 'whatever',
      summaryText: 'Tóm tắt verbose recap.',
    });
    try {
      h.primary.emit({
        type: 'done',
        durationMs: 12_000,
        totalCostUsd: 0.005,
        result: 'success',
      });
      h.primary.finish();
      await flush(30);

      // v1.3: enhanced tail (not v1.0 lowercase) + summary fires + edit appends.
      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      expect(sendTexts.some((t) => /✅ Done · 12s · \$0\.0050/.test(t))).toBe(true);
      expect(h.summaryStarted()).toBe(true);
      const editTexts = h.editPlain.mock.calls.map((c) => c[1]) as string[];
      expect(editTexts.find((t) => t.includes('Tóm tắt verbose recap.'))).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  it('thinking mode: also fires done-summary (R1)', async () => {
    const h = await setup({
      mode: 'thinking',
      transcript: 'ctx',
      summaryText: 'Tóm thinking.',
    });
    try {
      h.primary.emit({ type: 'done', durationMs: 4_000, totalCostUsd: 0.002, result: 'ok' });
      h.primary.finish();
      await flush(30);
      expect(h.summaryStarted()).toBe(true);
      const editTexts = h.editPlain.mock.calls.map((c) => c[1]) as string[];
      expect(editTexts.find((t) => t.includes('Tóm thinking.'))).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  it('summary mode + summarizer FAILS: full turn text is sent (R3/D4 — guaranteed content)', async () => {
    const h = await setup({
      mode: 'summary',
      transcript: 'tail',
      summaryText: null, // summarizer errors → null
    });
    try {
      // Stream real answer text BEFORE done. In summary mode this is suppressed
      // from streaming but accumulated into turnText for the fallback.
      h.primary.emit({ type: 'text', text: 'ANSWER-BODY-12345 full content here.' });
      h.primary.emit({ type: 'done', durationMs: 6_000, totalCostUsd: 0.001, result: 'success' });
      h.primary.finish();
      await flush(40);

      // Summarizer was attempted but failed; the raw captured turn text must
      // reach the user (via sendChunked → sendPlain in the test notifier).
      expect(h.summaryStarted()).toBe(true);
      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      expect(sendTexts.some((t) => t.includes('ANSWER-BODY-12345 full content here.'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('normal mode + summarizer FAILS: NO raw dump (user already saw the stream)', async () => {
    const h = await setup({
      mode: 'normal',
      transcript: 'tail',
      summaryText: null,
    });
    try {
      h.primary.emit({ type: 'text', text: 'STREAMED-ALREADY-SEEN' });
      h.primary.emit({ type: 'done', durationMs: 6_000, totalCostUsd: 0.001, result: 'success' });
      h.primary.finish();
      await flush(40);

      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      // In normal mode text was streamed live → no duplicate raw dump on failure.
      expect(sendTexts.some((t) => t.includes('STREAMED-ALREADY-SEEN'))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('summary mode + summarizer SUCCEEDS: raw turn text is NOT also sent (no double-send, R3)', async () => {
    const h = await setup({
      mode: 'summary',
      transcript: 'tail',
      summaryText: 'Tóm tắt gọn.',
    });
    try {
      // Stream content in summary mode (suppressed live, accumulated for fallback).
      h.primary.emit({ type: 'text', text: 'RAW-BODY-SHOULD-NOT-LEAK-ON-SUCCESS' });
      h.primary.emit({ type: 'done', durationMs: 5_000, totalCostUsd: 0.001, result: 'success' });
      h.primary.finish();
      await flush(40);

      // Summary succeeded → it is the ONLY content surface; the raw turn text
      // must NOT be sent as a separate message (would duplicate / defeat
      // summary mode). Summary appears via the edit path.
      expect(h.summaryStarted()).toBe(true);
      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      expect(sendTexts.some((t) => t.includes('RAW-BODY-SHOULD-NOT-LEAK-ON-SUCCESS'))).toBe(false);
      const editTexts = h.editPlain.mock.calls.map((c) => c[1]) as string[];
      expect(editTexts.find((t) => t.includes('Tóm tắt gọn.'))).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  it('summary mode + NO resume id + streamed text: raw turn text still surfaces (R3/D4 no-resume branch)', async () => {
    const h = await setup({
      mode: 'summary',
      withResume: false,
      transcript: 'tail',
      summaryText: 'should not fire',
    });
    try {
      h.primary.emit({ type: 'text', text: 'NO-RESUME-SUMMARY-BODY-XYZ' });
      h.primary.emit({ type: 'done', durationMs: 4_000, totalCostUsd: 0.001, result: 'success' });
      h.primary.finish();
      await flush(40);

      // Can't summarize (no resume id) AND text was suppressed live → the
      // guaranteed-content fallback in the !enableAutoDoneSummary branch must
      // surface the raw turn text so the user isn't left blank.
      expect(h.summaryStarted()).toBe(false);
      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      expect(sendTexts.some((t) => t.includes('NO-RESUME-SUMMARY-BODY-XYZ'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('summary mode: triggers auto-summary same as normal', async () => {
    const h = await setup({
      mode: 'summary',
      transcript: 'data',
      summaryText: 'Tóm: ok.',
    });
    try {
      h.primary.emit({
        type: 'done',
        durationMs: 5_000,
        totalCostUsd: 0.001,
        result: 'success',
      });
      h.primary.finish();
      await flush(30);

      expect(h.summaryStarted()).toBe(true);
      const editTexts = h.editPlain.mock.calls.map((c) => c[1]) as string[];
      expect(editTexts.find((t) => t.includes('Tóm: ok.'))).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  it('session without sdk_session_id: skips summarize (no resume context)', async () => {
    const h = await setup({
      mode: 'normal',
      withResume: false,
      transcript: 'data',
      summaryText: 'should not fire',
    });
    try {
      h.primary.emit({
        type: 'done',
        durationMs: 8_000,
        totalCostUsd: 0.002,
        result: 'success',
      });
      h.primary.finish();
      await flush(20);

      expect(h.summaryStarted()).toBe(false);
      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      // Without resume id, the auto-done-summary block bails BEFORE issuing
      // the enhanced tail (we only post v1.0 baseline tail).
      const doneSend = sendTexts.find((t) => /✅ done/.test(t));
      expect(doneSend).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  it('summarize failure (timeout/null): enhanced tail sent but no edit', async () => {
    const h = await setup({
      mode: 'normal',
      transcript: 'data',
      summaryText: null, // null = adapter emits error
    });
    try {
      h.primary.emit({
        type: 'done',
        durationMs: 9_000,
        totalCostUsd: 0.003,
        result: 'success',
      });
      h.primary.finish();
      await flush(30);

      // Enhanced tail still gets posted.
      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      expect(sendTexts.some((t) => t.includes('✅ Done · 9s · $0.0030'))).toBe(true);
      // But no successful edit appended.
      expect(h.editPlain).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  it('done with no result text still posts an enhanced tail (without $cost when absent)', async () => {
    const h = await setup({
      mode: 'normal',
      transcript: 'data',
      summaryText: 'summary text',
    });
    try {
      h.primary.emit({
        type: 'done',
        durationMs: 1_000,
        // no totalCostUsd
        result: 'success',
      });
      h.primary.finish();
      await flush(20);

      // Enhanced tail without $ part.
      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      const tail = sendTexts.find((t) => /✅ Done · 1s/.test(t));
      expect(tail).toBeDefined();
      expect(tail).not.toContain('$'); // no cost segment
    } finally {
      h.cleanup();
    }
  });

  it('approval-pending guard: status=waiting_approval skips summarize', async () => {
    const h = await setup({
      mode: 'normal',
      transcript: 'data',
      status: 'waiting_approval',
      summaryText: 'should not fire',
    });
    try {
      h.primary.emit({
        type: 'done',
        durationMs: 3_000,
        totalCostUsd: 0.002,
        result: 'success',
      });
      h.primary.finish();
      await flush(20);

      // The guard kicks in BEFORE the enhanced tail is composed, so we fall
      // back to the v1.0 baseline tail.
      const sendTexts = h.sendPlain.mock.calls.map((c) => c[0]) as string[];
      expect(sendTexts.some((t) => /✅ done · \$0\.0020/.test(t))).toBe(true);
      expect(h.summaryStarted()).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
