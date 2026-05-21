/**
 * Phase A.2 + A.5 — tool_result dispatch + suggestion deferral.
 *
 * Verifies the new dispatch branch added to bot/commands/index.ts:
 *  - `tool_result` for ACTIVE session edits the original tool_use message in
 *    place (one combined block instead of two separate messages) AND attaches
 *    the previously-deferred suggestion keyboard.
 *  - `tool_result` arriving with no matching pending tool_use sends a fresh
 *    plain message (the v1.0 silent-drop bug is gone).
 *  - Background sessions buffer the tool_result line for catch-up.
 *  - Initial `tool_use` no longer emits a reply_markup — suggestion is
 *    DEFERRED.
 *
 * Reuses the harness scaffolding from session-gating.test.ts (kept inline so
 * the test file is self-contained — small enough to duplicate without
 * extracting a shared helper).
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

const CHAT_ID = 9001;

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
  let nextId = 100;
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
  manager: SessionManager;
  sendPlain: ReturnType<typeof vi.fn>;
  editPlain: ReturnType<typeof vi.fn>;
  editReplyMarkup: ReturnType<typeof vi.fn>;
  a: SessionRow;
  cleanup: () => void;
  ready: Awaited<ReturnType<typeof adapterWithCaptured>['ready']>;
}

async function setup(): Promise<Harness> {
  const d = mkdtempSync(join(tmpdir(), 'telecode-toolres-'));
  const store = new SessionStore(join(d, 's.db'));
  const { adapter, ready } = adapterWithCaptured();
  const manager = new SessionManager(store, new FakeRegistry(adapter) as never, {
    bufferCapBytes: 5000,
  });
  const { notifier, sendPlain, editPlain, editReplyMarkup } = makeNotifier();
  const { bot, getHandler } = makeBotSpy();

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
  // Phase B (v1.1) — default mode 'summary' suppresses tool_use/tool_result
  // events. These tests cover the dispatch + merge logic specifically, not
  // the verbosity filter, so we opt into 'verbose' so every event reaches
  // the notifier surface and assertions stay valid.
  store.setChatDefaultMode(CHAT_ID, 'verbose');

  const handler = getHandler();
  void handler({
    message: { text: 'go' },
    chat: { id: CHAT_ID },
    reply: vi.fn(async () => ({ message_id: 1 })),
  });
  const readyResolved = await ready;

  // Drain initial "dispatching…" reply that didn't go through notifier.
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
      readyResolved.finish();
      rmSync(d, { recursive: true, force: true });
    },
    ready: readyResolved,
  };
}

// Helper — flush pending microtasks + timers.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Phase A.2/A.5 — tool_result dispatch + suggestion deferral', () => {
  it('tool_use without immediate result: NO reply_markup attached, pending entry queued', async () => {
    const h = await setup();
    try {
      h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } });
      await flush();

      expect(h.sendPlain).toHaveBeenCalledTimes(1);
      const [, opts] = h.sendPlain.mock.calls[0]!;
      // v1.1: keyboard deferred — initial tool_use has NO reply_markup.
      expect((opts as Record<string, unknown>).reply_markup).toBeUndefined();
      expect((opts as Record<string, unknown>).silent).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('tool_use → tool_result merges into one message via editPlain WITH suggestion row', async () => {
    const h = await setup();
    try {
      h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } });
      await flush();
      h.ready.emit({ type: 'tool_result', tool: 'Bash', ok: true, preview: 'a\nb\n' });
      await flush();

      // Original tool_use message edited in place — no SECOND sendPlain.
      expect(h.sendPlain).toHaveBeenCalledTimes(1);
      expect(h.editPlain).toHaveBeenCalledTimes(1);
      const [msgId, text, extra] = h.editPlain.mock.calls[0]!;
      expect(msgId).toBe(100); // first sendPlain returns 100
      expect(text).toContain('🔧 Bash · ls');
      expect(text).toContain('✅ Bash ok');
      expect(text).toContain('a\nb'); // preview included
      // Suggestion keyboard attached — Bash success row = [Tiếp tục] [Run again].
      expect((extra as Record<string, unknown>).reply_markup).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  it('tool_result with ok=false renders failed marker', async () => {
    const h = await setup();
    try {
      h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'false' } });
      await flush();
      h.ready.emit({ type: 'tool_result', tool: 'Bash', ok: false });
      await flush();

      expect(h.editPlain).toHaveBeenCalledTimes(1);
      const [, text] = h.editPlain.mock.calls[0]!;
      expect(text).toContain('❌ Bash failed');
    } finally {
      h.cleanup();
    }
  });

  it('orphan tool_result (no matching pending tool_use) sends fresh sendPlain', async () => {
    const h = await setup();
    try {
      h.ready.emit({ type: 'tool_result', tool: 'Read', ok: true, preview: 'data' });
      await flush();

      expect(h.editPlain).not.toHaveBeenCalled();
      expect(h.sendPlain).toHaveBeenCalledTimes(1);
      const [text] = h.sendPlain.mock.calls[0]!;
      expect(text).toMatch(/^\[A\] ✅ Read ok/);
    } finally {
      h.cleanup();
    }
  });

  it('tool_use without matching tool_result: 2s defer fallback retrofits keyboard', async () => {
    vi.useFakeTimers();
    try {
      const h = await setup();
      try {
        h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'sleep 999' } });
        await flush();
        expect(h.sendPlain).toHaveBeenCalledTimes(1);
        expect(h.editReplyMarkup).not.toHaveBeenCalled();

        // Advance past the 2-second defer window.
        await vi.advanceTimersByTimeAsync(2_001);
        await flush();
        expect(h.editReplyMarkup).toHaveBeenCalledTimes(1);
        const [msgId, kb] = h.editReplyMarkup.mock.calls[0]!;
        expect(msgId).toBe(100);
        expect(kb).toBeDefined();
      } finally {
        h.cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('tool_result for BACKGROUND session is buffered, notifier untouched', async () => {
    const h = await setup();
    try {
      // Create a second session and switch active to it; A is now background.
      const b = h.manager.createSession({ chatId: CHAT_ID, agent: 'claude', label: 'B', projectId: null });
      h.store.setActiveSession(CHAT_ID, b.id);

      h.ready.emit({ type: 'tool_result', tool: 'Read', ok: true, preview: 'bg-data' });
      await flush();

      expect(h.sendPlain).not.toHaveBeenCalled();
      expect(h.editPlain).not.toHaveBeenCalled();
      expect(h.manager.hasBuffered(h.a.id)).toBe(true);
      const drained = h.manager.drainBuffer(h.a.id);
      expect(drained[0]!.data).toContain('✅ Read ok');
    } finally {
      h.cleanup();
    }
  });

  // Senior-review (Opus 4.7) [P1] — race coverage.
  it('race: tool_result arriving BEFORE sendPlain resolves still merges', async () => {
    const h = await setup();
    try {
      // Make sendPlain artificially slow so tool_result races ahead.
      let resolveSend: (v: number | null) => void = () => {};
      const slow = new Promise<number | null>((r) => {
        resolveSend = r;
      });
      (h.sendPlain as unknown as { mockImplementationOnce: (fn: () => Promise<unknown>) => unknown }).mockImplementationOnce(
        () => slow,
      );
      h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } });
      await flush();
      // tool_result lands before sendPlain has resolved.
      h.ready.emit({ type: 'tool_result', tool: 'Bash', ok: true, preview: 'merged' });
      await flush();
      // No fresh orphan sendPlain should have fired for the result.
      expect(h.sendPlain).toHaveBeenCalledTimes(1); // only the tool_use one
      // Now resolve the slow send; the deferred editPlain should fire.
      resolveSend(100);
      await flush();
      await flush();
      expect(h.editPlain).toHaveBeenCalledTimes(1);
      const [, text] = h.editPlain.mock.calls[0]!;
      expect(text).toContain('🔧 Bash · ls');
      expect(text).toContain('✅ Bash ok');
      expect(text).toContain('merged');
    } finally {
      h.cleanup();
    }
  });

  // Senior-review (Opus 4.7) [P1] — friendly tool label consistency.
  it('codex.exec tool_result renders friendly "Bash" label (not raw adapter id)', async () => {
    const h = await setup();
    try {
      h.ready.emit({ type: 'tool_use', tool: 'codex.exec', input: { command: 'ls -la' } });
      await flush();
      h.ready.emit({ type: 'tool_result', tool: 'codex.exec', ok: true, preview: 'a\nb' });
      await flush();
      expect(h.editPlain).toHaveBeenCalledTimes(1);
      const [, text] = h.editPlain.mock.calls[0]!;
      expect(text).toContain('🔧 Bash · ls -la');
      expect(text).toContain('✅ Bash ok'); // NOT "✅ codex.exec ok"
    } finally {
      h.cleanup();
    }
  });

  // Senior-review (Opus 4.7) [P2] — error path tears down pending tracker.
  it('error event clears pending tracker (no defer fires after error)', async () => {
    vi.useFakeTimers();
    try {
      const h = await setup();
      try {
        h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'sleep 999' } });
        await flush();
        h.ready.emit({ type: 'error', error: 'boom' });
        await flush();
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();
        expect(h.editReplyMarkup).not.toHaveBeenCalled();
      } finally {
        h.cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('done event clears pending tracker (no orphan defer fires after done)', async () => {
    vi.useFakeTimers();
    try {
      const h = await setup();
      try {
        h.ready.emit({ type: 'tool_use', tool: 'Bash', input: { command: 'x' } });
        await flush();
        h.ready.emit({ type: 'done' });
        await flush();

        // Advance well past the 2s defer — onTimeout should NOT fire because
        // done cleared the tracker.
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();
        expect(h.editReplyMarkup).not.toHaveBeenCalled();
      } finally {
        h.cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // Senior-review (Opus 4.7) [P1] — collapse-burst tool_result merge.
  it('collapse-burst: every tool_result merges into the collapsed message (no orphans)', async () => {
    const h = await setup();
    try {
      // Three Read tool_use events within the collapse window → 1 sendPlain
      // (collapse-send), 2 editPlain (collapse-edit).
      h.ready.emit({ type: 'tool_use', tool: 'Read', input: { file_path: 'a.ts' } });
      await flush();
      h.ready.emit({ type: 'tool_use', tool: 'Read', input: { file_path: 'b.ts' } });
      await flush();
      h.ready.emit({ type: 'tool_use', tool: 'Read', input: { file_path: 'c.ts' } });
      await flush();

      const sendCountAfterBursts = h.sendPlain.mock.calls.length;
      const editCountAfterBursts = h.editPlain.mock.calls.length;
      // One send + 2 collapse-edits.
      expect(sendCountAfterBursts).toBe(1);
      expect(editCountAfterBursts).toBe(2);

      // Three tool_result events — each must edit the SAME collapsed message
      // (no orphan sendPlain calls).
      h.ready.emit({ type: 'tool_result', tool: 'Read', ok: true, preview: 'r1' });
      await flush();
      h.ready.emit({ type: 'tool_result', tool: 'Read', ok: true, preview: 'r2' });
      await flush();
      h.ready.emit({ type: 'tool_result', tool: 'Read', ok: true, preview: 'r3' });
      await flush();

      // No extra sendPlain — all three resolved via pending → editPlain.
      expect(h.sendPlain.mock.calls.length).toBe(sendCountAfterBursts);
      // editPlain fired 3 more times (one per result merge).
      expect(h.editPlain.mock.calls.length).toBe(editCountAfterBursts + 3);

      // The merge texts must include the LATEST collapsed line ("×3 · a, b,
      // c") so the LAST tool_result rendering doesn't regress to the FIRST
      // burst's smaller line ("· a").
      const lastMergeCall =
        h.editPlain.mock.calls[h.editPlain.mock.calls.length - 1]!;
      const lastMergedText = lastMergeCall[1] as string;
      expect(lastMergedText).toContain('×3');
      expect(lastMergedText).toContain('a.ts');
      expect(lastMergedText).toContain('b.ts');
      expect(lastMergedText).toContain('c.ts');
      expect(lastMergedText).toContain('✅ Read ok');
    } finally {
      h.cleanup();
    }
  });
});
