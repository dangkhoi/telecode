/**
 * Phase D.2 — auto-summarize tool_result.
 *
 * Verifies the new dispatch behaviour that fires when a `tool_result.preview`
 * exceeds the configurable threshold AND the session mode is not `verbose`:
 *
 *   1. The initial merged message shows a "⏳ Summarizing N output…" placeholder
 *      (NOT the truncated preview) so the user knows a summary is coming.
 *   2. summarizeWithSession() runs in the background; on success the message
 *      is re-edited with the summary body + [📜 Full output] / [💬 Re-summarize]
 *      buttons.
 *   3. On summarize failure (timeout / error / null), the placeholder is
 *      replaced with the original truncated preview body so the user is never
 *      stranded with a stuck "⏳ Summarizing…" message.
 *   4. Short previews (< threshold) skip auto-summarize entirely — render the
 *      regular merged "🔧 Bash · ls\n✅ Bash ok\n{preview}" body immediately.
 *   5. Mode `verbose` skips auto-summarize even on long previews — preserves
 *      v1.0 firehose behaviour for power users.
 *   6. Sessions without sdk_session_id (never ran a turn) skip auto-summarize
 *      regardless of length (no resume context → summary would hallucinate).
 *
 * The summarize call itself goes through SessionManager.dispatch which means
 * it queues behind the dispatch mutex. Our adapter harness has a
 * `secondaryRun` slot so the same FakeAdapter can respond to BOTH the user's
 * prompt and the subsequent summarize prompt.
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
import { _resetSummaryCache, summaryCache } from '../src/bot/summary-cache.js';

const CHAT_ID = 9201;
const RESUME_ID = 'sdk-resume-d2';

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
  editReplyMarkup: ReturnType<typeof vi.fn>;
} {
  let nextId = 1000;
  const sendPlain = vi.fn(async () => nextId++);
  const editPlain = vi.fn(async () => {});
  const editReplyMarkup = vi.fn(async () => {});
  const notifier = {
    appendStream: vi.fn(),
    sendPlain,
    closeStream: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    send: sendPlain,
    answerCallback: vi.fn(async () => {}),
    editPlain,
    editReplyMarkup,
    sendMarkdownV2: sendPlain,
  } as unknown as Notifier;
  return { notifier, sendPlain, editPlain, editReplyMarkup };
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

/**
 * Adapter that responds to MULTIPLE consecutive `run` calls. First call is
 * the user's prompt — gets a "primary" handle. Second call (summarize) gets
 * an auto-respond behaviour configurable per test.
 */
function multiTurnAdapter(opts: {
  /** Summarize response text. Null = error path (emit error then done). */
  summaryText: string | null;
}): {
  adapter: AgentAdapter;
  primary: Promise<{ emit: (e: AgentEvent) => void; finish: () => void }>;
  summaryStarted: () => boolean;
  summaryFinished: () => boolean;
} {
  let primaryResolve!: (v: { emit: (e: AgentEvent) => void; finish: () => void }) => void;
  const primary = new Promise<{ emit: (e: AgentEvent) => void; finish: () => void }>(
    (r) => (primaryResolve = r),
  );
  let runCount = 0;
  let summaryStarted = false;
  let summaryFinished = false;
  const adapter: AgentAdapter = {
    kind: 'claude',
    async run(o: AgentStartOpts) {
      runCount++;
      if (runCount === 1) {
        // User dispatch — wait until test calls finish().
        let resolveDone!: () => void;
        const done = new Promise<void>((r) => (resolveDone = r));
        primaryResolve({
          emit: (e) => o.onEvent(e),
          finish: () => resolveDone(),
        });
        await done;
        return;
      }
      // Subsequent runs = summarize calls. Auto-respond per opts.
      summaryStarted = true;
      if (opts.summaryText === null) {
        o.onEvent({ type: 'error', error: 'summarize failed' });
        o.onEvent({ type: 'done' });
      } else {
        o.onEvent({ type: 'text', text: opts.summaryText });
        o.onEvent({ type: 'done' });
      }
      summaryFinished = true;
    },
  };
  return {
    adapter,
    primary,
    summaryStarted: () => summaryStarted,
    summaryFinished: () => summaryFinished,
  };
}

interface Harness {
  store: SessionStore;
  manager: SessionManager;
  sendPlain: ReturnType<typeof vi.fn>;
  editPlain: ReturnType<typeof vi.fn>;
  editReplyMarkup: ReturnType<typeof vi.fn>;
  a: SessionRow;
  cleanup: () => void;
  primary: Awaited<ReturnType<typeof multiTurnAdapter>['primary']>;
  summaryStarted: () => boolean;
  summaryFinished: () => boolean;
}

async function setup(opts: {
  /** Chat default verbosity. Default 'normal' so tool_result is shown. */
  mode?: 'summary' | 'normal' | 'thinking' | 'verbose';
  /** Set sdk_session_id on the session row (default true). */
  withResume?: boolean;
  /** Summarize stub response. */
  summaryText: string | null;
}): Promise<Harness> {
  const d = mkdtempSync(join(tmpdir(), 'telecode-d2-'));
  const store = new SessionStore(join(d, 's.db'));
  const m = multiTurnAdapter({ summaryText: opts.summaryText });
  const manager = new SessionManager(store, new FakeRegistry(m.adapter) as never, {
    bufferCapBytes: 5000,
  });
  const { notifier, sendPlain, editPlain, editReplyMarkup } = makeNotifier();
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

  const handler = getHandler();
  void handler({
    message: { text: 'go' },
    chat: { id: CHAT_ID },
    reply: vi.fn(async () => ({ message_id: 1 })),
  });
  const primary = await m.primary;

  // Drain initial "dispatching…" reply.
  sendPlain.mockClear();
  editPlain.mockClear();
  editReplyMarkup.mockClear();

  return {
    store,
    manager,
    sendPlain,
    editPlain,
    editReplyMarkup,
    a,
    cleanup: () => {
      primary.finish();
      rmSync(d, { recursive: true, force: true });
    },
    primary,
    summaryStarted: m.summaryStarted,
    summaryFinished: m.summaryFinished,
  };
}

/** Yield enough microtask ticks for chained promise resolutions. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  summarizeMutexes.clear();
  _resetSummaryCache();
  delete process.env.TELECODE_AUTO_SUMMARIZE_THRESHOLD;
});
afterEach(() => {
  summarizeMutexes.clear();
  _resetSummaryCache();
  delete process.env.TELECODE_AUTO_SUMMARIZE_THRESHOLD;
});

describe('Phase D.2 — auto-summarize long tool_result', () => {
  it('short preview (< threshold): NO placeholder — renders truncated preview directly', async () => {
    const h = await setup({ summaryText: 'should not be called' });
    try {
      h.primary.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } });
      await flush();
      h.primary.emit({
        type: 'tool_result',
        tool: 'Bash',
        ok: true,
        preview: 'short output\n',
      });
      // Let the dispatch turn finish so summarize would have a chance to fire.
      h.primary.finish();
      await flush(20);

      // Initial edit shows the merged body with truncated preview — NO
      // "⏳ Summarizing" placeholder.
      const editTexts = h.editPlain.mock.calls.map((c) => c[1]) as string[];
      expect(editTexts.length).toBeGreaterThan(0);
      const firstEdit = editTexts[0]!;
      expect(firstEdit).toContain('✅ Bash ok');
      expect(firstEdit).toContain('short output');
      expect(firstEdit).not.toContain('⏳ Summarizing');
      // No summarize call should have fired.
      expect(h.summaryStarted()).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('long preview + normal mode: placeholder appears, then summary replaces it', async () => {
    const longPreview = 'x'.repeat(600); // > 500 default threshold
    const h = await setup({ summaryText: 'Tóm tắt: 432 tests pass.' });
    try {
      h.primary.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'npm test' } });
      await flush();
      h.primary.emit({
        type: 'tool_result',
        tool: 'Bash',
        ok: true,
        preview: longPreview,
      });
      await flush();
      // Initial edit MUST be the placeholder.
      const firstEdit = h.editPlain.mock.calls[0]![1] as string;
      expect(firstEdit).toContain('⏳ Summarizing');
      expect(firstEdit).toContain('✅ Bash ok');

      // Now let the primary dispatch finish so summarize can take the mutex.
      h.primary.finish();
      await flush(50);

      // A second edit must have landed with the summary text.
      const editTexts = h.editPlain.mock.calls.map((c) => c[1]) as string[];
      const summaryEdit = editTexts.find((t) => t.includes('Tóm tắt: 432 tests pass.'));
      expect(summaryEdit).toBeDefined();
      expect(summaryEdit).not.toContain('⏳ Summarizing');
    } finally {
      h.cleanup();
    }
  });

  it('verbose mode: skips auto-summarize even for long previews', async () => {
    const longPreview = 'y'.repeat(800);
    const h = await setup({ mode: 'verbose', summaryText: 'should not fire' });
    try {
      h.primary.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'npm test' } });
      await flush();
      h.primary.emit({
        type: 'tool_result',
        tool: 'Bash',
        ok: true,
        preview: longPreview,
      });
      h.primary.finish();
      await flush(20);

      const firstEdit = h.editPlain.mock.calls[0]![1] as string;
      // Verbose path skips D.2 — no placeholder, original (truncated) preview shown.
      expect(firstEdit).not.toContain('⏳ Summarizing');
      expect(h.summaryStarted()).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('session without sdk_session_id: skips auto-summarize (no resume context)', async () => {
    const longPreview = 'z'.repeat(800);
    const h = await setup({ withResume: false, summaryText: 'should not fire' });
    try {
      h.primary.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'npm test' } });
      await flush();
      h.primary.emit({
        type: 'tool_result',
        tool: 'Bash',
        ok: true,
        preview: longPreview,
      });
      h.primary.finish();
      await flush(20);

      const firstEdit = h.editPlain.mock.calls[0]![1] as string;
      expect(firstEdit).not.toContain('⏳ Summarizing');
      expect(h.summaryStarted()).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('summarize failure: placeholder replaced with truncated preview + [AI summary] retry button', async () => {
    const longPreview = 'w'.repeat(700);
    const h = await setup({ summaryText: null }); // error path
    try {
      h.primary.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'npm test' } });
      await flush();
      h.primary.emit({
        type: 'tool_result',
        tool: 'Bash',
        ok: true,
        preview: longPreview,
      });
      await flush();
      h.primary.finish();
      await flush(50);

      // Last edit should be the fallback — has the original truncated preview
      // and an [💬 AI summary] retry button.
      const editTexts = h.editPlain.mock.calls.map((c) => c[1]) as string[];
      const lastText = editTexts[editTexts.length - 1]!;
      // Fallback body shows the truncated preview (no "⏳ Summarizing").
      expect(lastText).not.toContain('⏳ Summarizing');
      expect(lastText).toContain('✅ Bash ok');
      // The reply_markup on the LAST edit must include a "💬 AI summary" button.
      const lastExtra = h.editPlain.mock.calls[h.editPlain.mock.calls.length - 1]![2] as
        | { reply_markup?: unknown }
        | undefined;
      const kbStr = JSON.stringify(lastExtra?.reply_markup ?? {});
      expect(kbStr).toContain('AI summary');
    } finally {
      h.cleanup();
    }
  });

  it('TELECODE_AUTO_SUMMARIZE_THRESHOLD env var overrides default 500', async () => {
    process.env.TELECODE_AUTO_SUMMARIZE_THRESHOLD = '50';
    const preview = 'a'.repeat(80); // < 500 default but > 50 override
    const h = await setup({ summaryText: 'short summary' });
    try {
      h.primary.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } });
      await flush();
      h.primary.emit({ type: 'tool_result', tool: 'Bash', ok: true, preview });
      await flush();

      const firstEdit = h.editPlain.mock.calls[0]![1] as string;
      // With threshold=50, the 80-char preview triggers auto-summarize.
      expect(firstEdit).toContain('⏳ Summarizing');

      h.primary.finish();
      await flush(30);
    } finally {
      h.cleanup();
    }
  });

  it('full preview cached after summarize fires (for D.5 button)', async () => {
    const longPreview = 'cached-content-' + 'q'.repeat(600);
    const h = await setup({ summaryText: 'compact' });
    try {
      h.primary.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } });
      await flush();
      h.primary.emit({
        type: 'tool_result',
        tool: 'Bash',
        ok: true,
        preview: longPreview,
      });
      await flush();
      // After the first edit, the summary cache must contain the full preview
      // keyed by the merged message id (1000 — first sendPlain ID).
      const cached = summaryCache.get(1000);
      expect(cached).not.toBeNull();
      expect(cached!.fullText).toBe(longPreview);
      expect(cached!.sessionId).toBe(h.a.id);

      h.primary.finish();
      await flush(30);
    } finally {
      h.cleanup();
    }
  });
});
