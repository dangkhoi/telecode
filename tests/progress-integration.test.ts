/**
 * Phase E — progress dispatch wiring integration tests.
 *
 * Verifies the wiring added to `bot/commands/index.ts` driving the
 * ProgressManager singleton through real dispatch events:
 *   - First event → `start()` is invoked with the bootstrap text.
 *   - `tool_use` → `update()` is invoked with `⏳ Running <label>…`.
 *   - `done` → `finalize()` is invoked with no text (delete path).
 *   - `error` → `finalize()` is invoked with the truncated error head.
 *   - verbose mode → progress NEVER bootstraps (no `start` call).
 *
 * Reuses the harness scaffolding from tool-result-dispatch.test.ts (kept
 * inline so the test file is self-contained).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import { SessionStore, type SessionRow } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import { registerCommands, type CommandDeps } from '../src/bot/commands/index.js';
import { initProgressManager, _resetRuntimeState } from '../src/bot/runtime-state.js';
import type { TelecodeConfig } from '../src/config.js';
import type { ApprovalBroker } from '../src/approval/broker.js';
import type { PolicyEngine } from '../src/approval/policy.js';
import type { AgentAdapter, AgentStartOpts, AgentEvent } from '../src/agents/types.js';
import type { AgentKind } from '../src/session/store.js';
import type { Notifier } from '../src/bot/notifier.js';
import type { VerbosityMode } from '../src/session/verbosity.js';

const CHAT_ID = 9101;

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

function makeNotifier(): Notifier {
  return {
    appendStream: vi.fn(),
    sendPlain: vi.fn(async () => 100),
    closeStream: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    send: vi.fn(async () => 100),
    answerCallback: vi.fn(async () => {}),
    editPlain: vi.fn(async () => {}),
    editReplyMarkup: vi.fn(async () => {}),
    sendMarkdownV2: vi.fn(async () => 100),
  } as unknown as Notifier;
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

function adapterWithCaptured(): {
  adapter: AgentAdapter;
  ready: Promise<{ emit: (e: AgentEvent) => void; finish: () => void }>;
} {
  let resolveReady: (v: { emit: (e: AgentEvent) => void; finish: () => void }) => void;
  const ready = new Promise<{ emit: (e: AgentEvent) => void; finish: () => void }>((r) => {
    resolveReady = r;
  });
  const adapter: AgentAdapter = {
    kind: 'claude',
    async run(opts: AgentStartOpts) {
      let resolveDone: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      resolveReady({
        emit: (e) => opts.onEvent(e),
        finish: () => resolveDone(),
      });
      await done;
    },
  };
  return { adapter, ready };
}

interface Harness {
  store: SessionStore;
  a: SessionRow;
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  cleanup: () => void;
  ready: Awaited<ReturnType<typeof adapterWithCaptured>['ready']>;
}

async function setup(mode: VerbosityMode = 'summary'): Promise<Harness> {
  const d = mkdtempSync(join(tmpdir(), 'telecode-progress-int-'));
  const store = new SessionStore(join(d, 's.db'));
  const { adapter, ready } = adapterWithCaptured();
  const manager = new SessionManager(store, new FakeRegistry(adapter) as never, {
    bufferCapBytes: 5000,
  });
  const notifier = makeNotifier();
  const { bot, getHandler } = makeBotSpy();

  // Init the ProgressManager singleton with mocked API.
  const sendMessage = vi.fn(async () => ({ message_id: 42 }));
  const editMessageText = vi.fn(async () => ({}));
  const deleteMessage = vi.fn(async () => ({}));
  initProgressManager({
    api: {
      sendMessage,
      editMessageText,
      deleteMessage,
    },
    modeResolver: () => mode,
  });

  const deps: CommandDeps = {
    config: { defaults: { agent: 'claude' }, session_switch_preview_lines: 3 } as unknown as TelecodeConfig,
    store,
    manager,
    broker: {} as ApprovalBroker,
    policy: {} as PolicyEngine,
    registry: new FakeRegistry(adapter) as never,
    notifierFor: () => notifier,
  };
  registerCommands(bot, deps);

  const a = manager.createSession({ chatId: CHAT_ID, agent: 'claude', label: 'A', projectId: null });
  store.setActiveSession(CHAT_ID, a.id);
  store.setChatDefaultMode(CHAT_ID, mode);

  const handler = getHandler();
  void handler({
    message: { text: 'go' },
    chat: { id: CHAT_ID },
    reply: vi.fn(async () => ({ message_id: 1 })),
  });
  const readyResolved = await ready;

  return {
    store,
    a,
    sendMessage,
    editMessageText,
    deleteMessage,
    cleanup: () => {
      readyResolved.finish();
      _resetRuntimeState();
      rmSync(d, { recursive: true, force: true });
    },
    ready: readyResolved,
  };
}

async function flush(): Promise<void> {
  // Three microtask drains — covers the chained `void start()` → `void update()`
  // pattern in the dispatch wiring (each await yields once).
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Phase E — progress dispatch wiring', () => {
  beforeEach(() => {
    _resetRuntimeState();
  });
  afterEach(() => {
    _resetRuntimeState();
  });

  it('first status event bootstraps the progress message with the rendered status text', async () => {
    const h = await setup('summary');
    try {
      // Senior-review (Opus 4.7) [P1]: the FIRST event's friendly text is
      // now used as the bootstrap message body so it isn't lost to the
      // 1500ms throttle gate. Previously the dispatch wiring sent a generic
      // "⏳ Starting…" placeholder, then synchronously called update() which
      // early-returned because state wasn't yet populated.
      h.ready.emit({ type: 'status', status: 'codex_turn_started' });
      await flush();
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sendMessage).toHaveBeenCalledWith(CHAT_ID, '⏳ Codex thinking…', {
        disable_notification: true,
      });
    } finally {
      h.cleanup();
    }
  });

  it('tool_use updates the progress message with the friendly label', async () => {
    const h = await setup('normal');
    try {
      // First event bootstraps (no edit yet — too soon for throttle).
      h.ready.emit({ type: 'status', status: 'codex_turn_started' });
      await flush();
      // Wait past the 1500ms throttle gate.
      await new Promise((r) => setTimeout(r, 1600));
      h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } });
      await flush();
      // Find the edit call carrying the "Running Bash…" text.
      const editCalls = h.editMessageText.mock.calls;
      const runningCall = editCalls.find(([, , text]) => String(text).includes('Running Bash'));
      expect(runningCall).toBeDefined();
      expect(runningCall?.[2]).toBe('⏳ Running Bash…');
    } finally {
      h.cleanup();
    }
  });

  it('done event finalizes the progress message via deleteMessage', async () => {
    const h = await setup('summary');
    try {
      h.ready.emit({ type: 'status', status: 'codex_turn_started' });
      await flush();
      h.ready.emit({ type: 'done', durationMs: 1000 });
      await flush();
      expect(h.deleteMessage).toHaveBeenCalledTimes(1);
      expect(h.deleteMessage).toHaveBeenCalledWith(CHAT_ID, 42);
    } finally {
      h.cleanup();
    }
  });

  it('error event finalizes with a tombstone edit (visible to user)', async () => {
    const h = await setup('summary');
    try {
      h.ready.emit({ type: 'status', status: 'codex_turn_started' });
      await flush();
      h.ready.emit({ type: 'error', error: 'something broke loudly' });
      await flush();
      // Tombstone edit — last editMessageText call carries the "❌ ..." text.
      const tombstone = h.editMessageText.mock.calls.find(([, , text]) =>
        String(text).startsWith('❌ '),
      );
      expect(tombstone).toBeDefined();
      expect(tombstone?.[2]).toBe('❌ something broke loudly');
      // Delete NOT called on error path.
      expect(h.deleteMessage).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  it('first event is tool_use: bootstrap message uses friendly running label (regression)', async () => {
    // Opus 4.7 review [P1] regression: previously `void start('⏳ Starting…')`
    // + sync `void update('⏳ Running Bash…')` raced — update() saw no state
    // yet and dropped the first meaningful text. Verify the friendly label
    // makes it into the bootstrap sendMessage call directly.
    const h = await setup('summary');
    try {
      h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } });
      await flush();
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sendMessage).toHaveBeenCalledWith(CHAT_ID, '⏳ Running Bash…', {
        disable_notification: true,
      });
    } finally {
      h.cleanup();
    }
  });

  it('verbose mode skips all progress API calls', async () => {
    const h = await setup('verbose');
    try {
      h.ready.emit({ type: 'status', status: 'codex_turn_started' });
      await flush();
      h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } });
      await flush();
      h.ready.emit({ type: 'done' });
      await flush();
      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.editMessageText).not.toHaveBeenCalled();
      expect(h.deleteMessage).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });
});
