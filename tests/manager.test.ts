import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import type { AgentAdapter, AgentStartOpts } from '../src/agents/types.js';
import type { AgentKind } from '../src/session/store.js';

class FakeRegistry {
  constructor(private adapter: AgentAdapter) {}
  get(_k: AgentKind): AgentAdapter {
    return this.adapter;
  }
  // Plan P1.1: SessionManager.dispatch uses `require` (strict get with a
  // helpful error). FakeRegistry mirrors that to keep tests green.
  require(_k: AgentKind): AgentAdapter {
    return this.adapter;
  }
  has(_k: AgentKind): boolean {
    return true;
  }
  list(): { kind: string; displayName: string; badge: string }[] {
    return [{ kind: this.adapter.kind, displayName: this.adapter.kind, badge: '·' }];
  }
  kinds(): string[] {
    return [this.adapter.kind];
  }
}

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-mgr-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

describe('SessionManager', () => {
  it('per-session mutex serializes prompts in same session', async () => {
    const { store, cleanup } = makeStore();
    try {
      const events: string[] = [];
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run(opts: AgentStartOpts) {
          events.push(`start:${opts.initialPrompt}`);
          await new Promise((r) => setTimeout(r, 80));
          events.push(`end:${opts.initialPrompt}`);
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const s = mgr.createSession({ chatId: 1, agent: 'claude', label: 'a', projectId: null });

      const p1 = mgr.dispatch({
        sessionId: s.id, sessionLabel: 'a', chatId: 1, cwd: '/tmp',
        agent: 'claude', resumeId: null, prompt: 'one', onEvent: () => {},
      });
      // Second call while first is locked should report busy
      let busyReported = false;
      const p2 = mgr.dispatch({
        sessionId: s.id, sessionLabel: 'a', chatId: 1, cwd: '/tmp',
        agent: 'claude', resumeId: null, prompt: 'two',
        onEvent: (e) => { if (e.type === 'error' && /busy/.test(e.error)) busyReported = true; },
      });
      await Promise.all([p1, p2]);
      expect(busyReported).toBe(true);
      expect(events).toEqual(['start:one', 'end:one']);
    } finally {
      cleanup();
    }
  });

  it('v1.4 §C1: a user dispatch PREEMPTS an in-flight summarize (no "session busy")', async () => {
    const { store, cleanup } = makeStore();
    try {
      const events: string[] = [];
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run(opts: AgentStartOpts) {
          if (opts.initialPrompt === 'SUMMARIZE') {
            events.push('start:summarize');
            // Hold the mutex until preempted (abort) — mimics a slow summarize.
            await new Promise<void>((resolve) => {
              if (opts.abortSignal.aborted) return resolve();
              opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
            });
            events.push('aborted:summarize');
            return;
          }
          events.push('start:user');
          await new Promise((r) => setTimeout(r, 20));
          events.push('end:user');
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const s = mgr.createSession({ chatId: 1, agent: 'claude', label: 'a', projectId: null });

      // Low-priority summarize acquires the mutex first.
      const pSummarize = mgr.dispatch({
        sessionId: s.id, sessionLabel: 'a', chatId: 1, cwd: '/tmp',
        agent: 'claude', resumeId: null, prompt: 'SUMMARIZE', kind: 'summarize',
        onEvent: () => {},
      });
      await new Promise((r) => setTimeout(r, 10)); // let summarize lock the mutex

      let busyReported = false;
      const pUser = mgr.dispatch({
        sessionId: s.id, sessionLabel: 'a', chatId: 1, cwd: '/tmp',
        agent: 'claude', resumeId: null, prompt: 'USER', kind: 'user',
        onEvent: (e) => { if (e.type === 'error' && /busy/.test(e.error)) busyReported = true; },
      });
      await Promise.all([pSummarize, pUser]);

      // User was NOT bounced; summarize was aborted; user ran after.
      expect(busyReported).toBe(false);
      expect(events).toEqual(['start:summarize', 'aborted:summarize', 'start:user', 'end:user']);
    } finally {
      cleanup();
    }
  });

  it('v1.4 §C1: two concurrent USER dispatches still report busy (no preemption)', async () => {
    const { store, cleanup } = makeStore();
    try {
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run() { await new Promise((r) => setTimeout(r, 40)); },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const s = mgr.createSession({ chatId: 1, agent: 'claude', label: 'a', projectId: null });
      const p1 = mgr.dispatch({
        sessionId: s.id, sessionLabel: 'a', chatId: 1, cwd: '/tmp',
        agent: 'claude', resumeId: null, prompt: 'one', kind: 'user', onEvent: () => {},
      });
      await new Promise((r) => setTimeout(r, 10));
      let busy = false;
      const p2 = mgr.dispatch({
        sessionId: s.id, sessionLabel: 'a', chatId: 1, cwd: '/tmp',
        agent: 'claude', resumeId: null, prompt: 'two', kind: 'user',
        onEvent: (e) => { if (e.type === 'error' && /busy/.test(e.error)) busy = true; },
      });
      await Promise.all([p1, p2]);
      expect(busy).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('different sessions run in parallel', async () => {
    const { store, cleanup } = makeStore();
    try {
      const order: string[] = [];
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run(opts) {
          order.push(`s:${opts.sessionLabel}`);
          await new Promise((r) => setTimeout(r, 60));
          order.push(`e:${opts.sessionLabel}`);
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const a = mgr.createSession({ chatId: 1, agent: 'claude', label: 'A', projectId: null });
      const b = mgr.createSession({ chatId: 1, agent: 'claude', label: 'B', projectId: null });
      await Promise.all([
        mgr.dispatch({ sessionId: a.id, sessionLabel: 'A', chatId: 1, cwd: '/tmp', agent: 'claude', resumeId: null, prompt: '', onEvent: () => {} }),
        mgr.dispatch({ sessionId: b.id, sessionLabel: 'B', chatId: 1, cwd: '/tmp', agent: 'claude', resumeId: null, prompt: '', onEvent: () => {} }),
      ]);
      // Interleaved starts before either end.
      const firstEnd = order.findIndex((x) => x.startsWith('e:'));
      expect(order.slice(0, firstEnd).every((x) => x.startsWith('s:'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
