import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import { SessionStore, type SessionRow } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import { registerCommands, flushBufferedAsCatchUp, type CommandDeps } from '../src/bot/commands/index.js';
import type { TelecodeConfig } from '../src/config.js';
import type { ApprovalBroker } from '../src/approval/broker.js';
import type { PolicyEngine } from '../src/approval/policy.js';
import type { AgentAdapter, AgentStartOpts, AgentEvent } from '../src/agents/types.js';
import type { AgentKind } from '../src/session/store.js';
import type { Notifier } from '../src/bot/notifier.js';

// ---------------------------------------------------------------------------
// Phase B2 — Per-session onEvent gating (plan §2 behavior matrix)
//
// Verifies the inline `onEvent` callback installed inside
// `bot.on('message:text', ...)` correctly:
//   - streams ACTIVE-session text/tool_use live (silent + prefix);
//   - buffers BACKGROUND-session text/tool_use into the SessionManager;
//   - on done/error from a background session, drains the buffer as a
//     catch-up message THEN sends the critical message (NOT silent so the
//     user receives a push notification);
//   - re-reads activeId on every event so a mid-dispatch switch flips the
//     behavior immediately (no caching of `cur === active` at startup).
// ---------------------------------------------------------------------------

const CHAT_ID = 8123;

// -----------------------------------------------------------------------------
// Mock plumbing — minimal grammY + Notifier surface
// -----------------------------------------------------------------------------

type MessageTextHandler = (ctx: unknown) => Promise<unknown> | unknown;

interface BotSpy {
  bot: Bot;
  messageTextHandler: () => MessageTextHandler;
}

function makeBotSpy(): BotSpy {
  let captured: MessageTextHandler | null = null;
  const bot = {
    command: vi.fn(),
    on: vi.fn((event: string, handler: MessageTextHandler) => {
      if (event === 'message:text') captured = handler;
      return bot;
    }),
  } as unknown as Bot;
  return {
    bot,
    messageTextHandler: () => {
      if (!captured) throw new Error('message:text handler never registered');
      return captured;
    },
  };
}

function makeNotifier(): {
  notifier: Notifier;
  appendStream: ReturnType<typeof vi.fn>;
  sendPlain: ReturnType<typeof vi.fn>;
  closeStream: ReturnType<typeof vi.fn>;
} {
  const appendStream = vi.fn();
  const sendPlain = vi.fn(async () => 1);
  const closeStream = vi.fn(async () => {});
  const notifier = {
    appendStream,
    sendPlain,
    closeStream,
    flush: vi.fn(async () => {}),
    send: sendPlain,
    answerCallback: vi.fn(async () => {}),
  } as unknown as Notifier;
  return { notifier, appendStream, sendPlain, closeStream };
}

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-gating-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

function fakeConfig(): TelecodeConfig {
  return {
    defaults: { agent: 'claude' },
    session_switch_preview_lines: 3,
  } as unknown as TelecodeConfig;
}

class FakeRegistry {
  constructor(private adapter: AgentAdapter) {}
  get(_k: AgentKind): AgentAdapter {
    return this.adapter;
  }
}

/**
 * AgentAdapter that surfaces its `onEvent` callback through a Promise so the
 * test can synchronously fire arbitrary AgentEvents at it. The adapter keeps
 * `run` open until the test resolves it via `finish()`.
 */
function adapterWithCapturedEvents(): {
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
  manager: SessionManager;
  notifier: Notifier;
  appendStream: ReturnType<typeof vi.fn>;
  sendPlain: ReturnType<typeof vi.fn>;
  closeStream: ReturnType<typeof vi.fn>;
  handler: MessageTextHandler;
  a: SessionRow;
  b: SessionRow;
  cleanup: () => void;
}

async function setup(): Promise<Harness & { ready: Awaited<ReturnType<typeof adapterWithCapturedEvents>['ready']> }> {
  const { store, cleanup } = makeStore();
  const { adapter, ready } = adapterWithCapturedEvents();
  const manager = new SessionManager(store, new FakeRegistry(adapter) as never, {
    bufferCapBytes: 5000,
  });
  const { notifier, appendStream, sendPlain, closeStream } = makeNotifier();
  const { bot, messageTextHandler } = makeBotSpy();

  const deps: CommandDeps = {
    config: fakeConfig(),
    store,
    manager,
    broker: {} as ApprovalBroker,
    policy: {} as PolicyEngine,
    notifierFor: () => notifier,
  };
  registerCommands(bot, deps);

  // Seed two sessions A + B for the same chat.
  const a = manager.createSession({ chatId: CHAT_ID, agent: 'claude', label: 'A', projectId: null });
  const b = manager.createSession({ chatId: CHAT_ID, agent: 'claude', label: 'B', projectId: null });
  store.setActiveSession(CHAT_ID, a.id);

  const handler = messageTextHandler();

  // Build a minimal ctx the handler reads from. `ctx.reply` short-circuits the
  // dispatching ack; we discard it. The handler then calls
  // manager.dispatch(...), which awaits adapter.run → captures onEvent.
  const ctx = {
    message: { text: 'go' },
    chat: { id: CHAT_ID },
    reply: vi.fn(async () => ({ message_id: 1 })),
  };
  // Fire-and-forget — handler awaits ctx.reply but the dispatch itself is
  // void'd inside (fire-and-forget). We rely on `ready` to know onEvent is
  // captured.
  void handler(ctx);

  const readyResolved = await ready;
  // Reset notifier mocks AFTER the "dispatching…" ctx.reply (which doesn't use
  // notifier) — defensive in case future code dispatches a notifier call.
  appendStream.mockClear();
  sendPlain.mockClear();
  closeStream.mockClear();

  return {
    store,
    manager,
    notifier,
    appendStream,
    sendPlain,
    closeStream,
    handler,
    a,
    b,
    cleanup: () => {
      readyResolved.finish();
      cleanup();
    },
    ready: readyResolved,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('B2 onEvent gating — active session', () => {
  it('text event for ACTIVE session calls appendStream with prefix + silent', async () => {
    const h = await setup();
    try {
      h.ready.emit({ type: 'text', text: 'hello' });
      expect(h.appendStream).toHaveBeenCalledTimes(1);
      const [key, chunk, opts] = h.appendStream.mock.calls[0]!;
      expect(key).toBe(`s:${h.a.id}`);
      expect(chunk).toBe('hello');
      expect(opts).toEqual({ prefix: '[A] ', silent: true });
      expect(h.manager.hasBuffered(h.a.id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('tool_use for ACTIVE session sends silent plain with prefix', async () => {
    const h = await setup();
    try {
      h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { cmd: 'ls' } });
      // sendPlain is async via void — wait a microtask.
      await Promise.resolve();
      expect(h.sendPlain).toHaveBeenCalledTimes(1);
      const [text, opts] = h.sendPlain.mock.calls[0]!;
      expect(text).toMatch(/^\[A\] 🔧 Bash — /);
      expect(opts).toEqual({ silent: true });
    } finally {
      h.cleanup();
    }
  });
});

describe('B2 onEvent gating — background session', () => {
  it('text event for BACKGROUND session is buffered, notifier untouched', async () => {
    const h = await setup();
    try {
      // Switch active to B → A is now background.
      h.store.setActiveSession(CHAT_ID, h.b.id);
      h.ready.emit({ type: 'text', text: 'while-bg' });

      expect(h.appendStream).not.toHaveBeenCalled();
      expect(h.sendPlain).not.toHaveBeenCalled();
      expect(h.manager.hasBuffered(h.a.id)).toBe(true);

      const drained = h.manager.drainBuffer(h.a.id);
      expect(drained).toHaveLength(1);
      expect(drained[0]).toMatchObject({ type: 'text', data: 'while-bg' });
    } finally {
      h.cleanup();
    }
  });

  it('tool_use for BACKGROUND session is buffered, notifier untouched', async () => {
    const h = await setup();
    try {
      h.store.setActiveSession(CHAT_ID, h.b.id);
      h.ready.emit({ type: 'tool_use', tool: 'Read', input: { path: '/etc/x' } });

      await Promise.resolve();
      expect(h.sendPlain).not.toHaveBeenCalled();
      expect(h.appendStream).not.toHaveBeenCalled();
      expect(h.manager.hasBuffered(h.a.id)).toBe(true);
      const drained = h.manager.drainBuffer(h.a.id);
      expect(drained[0]).toMatchObject({ type: 'tool_use' });
      expect(drained[0]!.data).toMatch(/^🔧 Read — /);
    } finally {
      h.cleanup();
    }
  });

  it('done while background: catch-up drained first (silent), then [A] ✅ done (NOT silent)', async () => {
    const h = await setup();
    try {
      h.store.setActiveSession(CHAT_ID, h.b.id);
      // Pre-load buffer with some content.
      h.ready.emit({ type: 'text', text: 'pre-1' });
      h.ready.emit({ type: 'text', text: 'pre-2' });
      expect(h.manager.hasBuffered(h.a.id)).toBe(true);

      h.ready.emit({ type: 'done', result: 'ok', totalCostUsd: 0.0123 });

      // The done branch is an async IIFE; await several microtasks.
      await new Promise((r) => setTimeout(r, 10));

      // closeStream was called once.
      expect(h.closeStream).toHaveBeenCalledTimes(1);
      // Two sendPlain calls: catch-up (silent), then done (NOT silent).
      expect(h.sendPlain).toHaveBeenCalledTimes(2);

      const [catchText, catchOpts] = h.sendPlain.mock.calls[0]!;
      expect(catchText).toContain('[A] 📥 catch-up (2 events from background)');
      expect(catchText).toContain('pre-1');
      expect(catchText).toContain('pre-2');
      expect(catchOpts).toEqual({ silent: true });

      const [doneText, doneOpts] = h.sendPlain.mock.calls[1]!;
      expect(doneText).toMatch(/^\[A\] ✅ done · \$0\.0123$/);
      // Critical event → notify (no opts/silent flag).
      expect(doneOpts).toBeUndefined();

      // Buffer drained.
      expect(h.manager.hasBuffered(h.a.id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('error while background: catch-up drained first, then [A] ❌ msg (NOT silent)', async () => {
    const h = await setup();
    try {
      h.store.setActiveSession(CHAT_ID, h.b.id);
      h.ready.emit({ type: 'text', text: 'partial' });
      h.ready.emit({ type: 'error', error: 'boom' });

      await new Promise((r) => setTimeout(r, 10));

      expect(h.sendPlain).toHaveBeenCalledTimes(2);
      const [catchText, catchOpts] = h.sendPlain.mock.calls[0]!;
      expect(catchText).toContain('[A] 📥 catch-up (1 events from background)');
      expect(catchText).toContain('partial');
      expect(catchOpts).toEqual({ silent: true });

      const [errText, errOpts] = h.sendPlain.mock.calls[1]!;
      expect(errText).toBe('[A] ❌ boom');
      expect(errOpts).toBeUndefined();

      expect(h.manager.hasBuffered(h.a.id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('done while background with EMPTY buffer: no catch-up message, just [A] ✅', async () => {
    const h = await setup();
    try {
      h.store.setActiveSession(CHAT_ID, h.b.id);
      // No prior text/tool events — buffer stays empty.
      h.ready.emit({ type: 'done' });
      await new Promise((r) => setTimeout(r, 10));

      // Only the done message — no catch-up.
      expect(h.sendPlain).toHaveBeenCalledTimes(1);
      const [doneText, doneOpts] = h.sendPlain.mock.calls[0]!;
      expect(doneText).toBe('[A] ✅ done');
      expect(doneOpts).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe('B2 onEvent gating — mid-dispatch active flip', () => {
  it('re-reads activeId per event: same dispatch streams while active, buffers after switch', async () => {
    const h = await setup();
    try {
      // First event while A is active → streams.
      h.ready.emit({ type: 'text', text: 'live' });
      expect(h.appendStream).toHaveBeenCalledTimes(1);

      // Flip active → B. The closure's `cur` still points at A.
      h.store.setActiveSession(CHAT_ID, h.b.id);

      // Next event for A must NOT stream — must buffer.
      h.ready.emit({ type: 'text', text: 'bg-now' });
      expect(h.appendStream).toHaveBeenCalledTimes(1); // unchanged
      expect(h.manager.hasBuffered(h.a.id)).toBe(true);
      const drained = h.manager.drainBuffer(h.a.id);
      expect(drained.map((e) => e.data)).toEqual(['bg-now']);
    } finally {
      h.cleanup();
    }
  });
});

describe('B2 flushBufferedAsCatchUp helper', () => {
  it('is a no-op when the buffer is empty', async () => {
    const h = await setup();
    try {
      await flushBufferedAsCatchUp(h.a, h.manager, h.notifier);
      expect(h.sendPlain).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  it('drains and sends a header + joined data with silent:true', async () => {
    const h = await setup();
    try {
      h.manager.appendBuffer(h.a.id, { type: 'text', data: 'line-1', createdAt: 1 });
      h.manager.appendBuffer(h.a.id, { type: 'text', data: 'line-2', createdAt: 2 });
      await flushBufferedAsCatchUp(h.a, h.manager, h.notifier);

      expect(h.sendPlain).toHaveBeenCalledTimes(1);
      const [text, opts] = h.sendPlain.mock.calls[0]!;
      expect(text).toBe('[A] 📥 catch-up (2 events from background):\nline-1\nline-2');
      expect(opts).toEqual({ silent: true });
      expect(h.manager.hasBuffered(h.a.id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
