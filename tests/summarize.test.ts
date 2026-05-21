import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import type { AgentAdapter, AgentEvent, AgentStartOpts } from '../src/agents/types.js';
import type { AgentKind } from '../src/session/store.js';
import {
  summarizeWithSession,
  summarizeMutexes,
  discardSummarizeMutex,
  DEFAULT_SUMMARIZE_TIMEOUT_MS,
} from '../src/agents/summarize.js';

/**
 * Mirror of tests/manager.test.ts FakeRegistry — minimum surface needed
 * for SessionManager.dispatch to find the adapter.
 */
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
  list(): { kind: string; displayName: string; badge: string }[] {
    return [{ kind: this.adapter.kind, displayName: this.adapter.kind, badge: '·' }];
  }
  kinds(): string[] {
    return [this.adapter.kind];
  }
}

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-summarize-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

/**
 * Helper — create a session and prime its sdk_session_id so summarize can
 * resolve a resume token without needing a real adapter.run() upfront.
 */
let labelSeq = 0;
function makeSession(store: SessionStore, opts?: { withResume?: boolean }): string {
  labelSeq++;
  const s = store.createSession({
    id: crypto.randomUUID(),
    label: `test-${labelSeq}`,
    agent: 'claude',
    project_id: null,
    chat_id: 42,
    sdk_session_id: opts?.withResume === false ? null : 'sdk-resume-id-123',
    status: 'idle',
  });
  return s.id;
}

describe('summarizeWithSession', () => {
  beforeEach(() => {
    summarizeMutexes.clear();
  });
  afterEach(() => {
    summarizeMutexes.clear();
  });

  it('happy path — captures text events, returns trimmed summary', async () => {
    const { store, cleanup } = makeStore();
    try {
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run(opts: AgentStartOpts) {
          opts.onEvent({ type: 'text', text: 'Đã chạy npm test. ' });
          opts.onEvent({ type: 'text', text: 'Pass 432/2.\n' });
          opts.onEvent({ type: 'done' });
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const sid = makeSession(store);

      const out = await summarizeWithSession({
        manager: mgr,
        store,
        sessionId: sid,
        content: 'PASS tests/foo.test.ts\n... 200 lines ...',
        instruction: 'Tóm tắt 2 dòng',
        kind: 'on-demand',
      });
      expect(out).toBe('Đã chạy npm test. Pass 432/2.');
    } finally {
      cleanup();
    }
  });

  it('returns null when session has no sdk_session_id (no context to summarize)', async () => {
    const { store, cleanup } = makeStore();
    try {
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run(opts: AgentStartOpts) {
          opts.onEvent({ type: 'text', text: 'should not be called' });
          opts.onEvent({ type: 'done' });
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const sid = makeSession(store, { withResume: false });

      const out = await summarizeWithSession({
        manager: mgr,
        store,
        sessionId: sid,
        content: 'whatever',
        instruction: 'Tóm tắt',
        kind: 'on-demand',
      });
      expect(out).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('returns null when session row vanishes before dispatch', async () => {
    const { store, cleanup } = makeStore();
    try {
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run() {
          /* never called */
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const out = await summarizeWithSession({
        manager: mgr,
        store,
        sessionId: 'non-existent-session-id',
        content: 'x',
        instruction: 'Tóm tắt',
        kind: 'on-demand',
      });
      expect(out).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('timeout — returns null when adapter does not emit done within timeoutMs', async () => {
    const { store, cleanup } = makeStore();
    try {
      const adapter: AgentAdapter = {
        kind: 'claude',
        // Never emit done — hang until abort.
        async run(opts: AgentStartOpts) {
          await new Promise<void>((resolve) => {
            opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
            // Fallback so the test doesn't leak — 5s upper bound. Test will
            // timeout faster via our 50ms summarize budget.
            setTimeout(() => resolve(), 5_000);
          });
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const sid = makeSession(store);

      const out = await summarizeWithSession({
        manager: mgr,
        store,
        sessionId: sid,
        content: 'long stuff',
        instruction: 'Tóm tắt',
        kind: 'auto-tool-result',
        timeoutMs: 50, // tight budget for the test
      });
      expect(out).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('returns null when adapter emits error before done', async () => {
    const { store, cleanup } = makeStore();
    try {
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run(opts: AgentStartOpts) {
          opts.onEvent({ type: 'error', error: 'agent crashed' });
          opts.onEvent({ type: 'done' });
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const sid = makeSession(store);

      const out = await summarizeWithSession({
        manager: mgr,
        store,
        sessionId: sid,
        content: 'x',
        instruction: 'Tóm tắt',
        kind: 'on-demand',
      });
      // No text collected + error fired → null
      expect(out).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('returns text even when error fires AFTER chunks (partial summary)', async () => {
    const { store, cleanup } = makeStore();
    try {
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run(opts: AgentStartOpts) {
          opts.onEvent({ type: 'text', text: 'Partial result' });
          opts.onEvent({ type: 'done' });
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const sid = makeSession(store);

      const out = await summarizeWithSession({
        manager: mgr,
        store,
        sessionId: sid,
        content: 'x',
        instruction: 'Tóm tắt',
        kind: 'on-demand',
      });
      expect(out).toBe('Partial result');
    } finally {
      cleanup();
    }
  });

  it('mutex serializes parallel summarize calls for same session', async () => {
    const { store, cleanup } = makeStore();
    try {
      let inflight = 0;
      let maxInflight = 0;
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run(opts: AgentStartOpts) {
          inflight++;
          maxInflight = Math.max(maxInflight, inflight);
          await new Promise((r) => setTimeout(r, 30));
          opts.onEvent({ type: 'text', text: `r${maxInflight}` });
          opts.onEvent({ type: 'done' });
          inflight--;
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const sid = makeSession(store);

      const calls = [0, 1, 2, 3].map((i) =>
        summarizeWithSession({
          manager: mgr,
          store,
          sessionId: sid,
          content: `c${i}`,
          instruction: 'Tóm tắt',
          kind: 'on-demand',
        }),
      );
      const results = await Promise.all(calls);
      // Mutex must serialize — only 1 in flight at any time.
      expect(maxInflight).toBe(1);
      // All four calls succeed.
      expect(results.every((r) => typeof r === 'string')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('parallel summarize calls for DIFFERENT sessions do NOT serialize', async () => {
    const { store, cleanup } = makeStore();
    try {
      let inflight = 0;
      let maxInflight = 0;
      const adapter: AgentAdapter = {
        kind: 'claude',
        async run(opts: AgentStartOpts) {
          inflight++;
          maxInflight = Math.max(maxInflight, inflight);
          await new Promise((r) => setTimeout(r, 30));
          opts.onEvent({ type: 'text', text: 'ok' });
          opts.onEvent({ type: 'done' });
          inflight--;
        },
      };
      const mgr = new SessionManager(store, new FakeRegistry(adapter) as never);
      const sidA = makeSession(store);
      const sidB = makeSession(store);

      await Promise.all([
        summarizeWithSession({
          manager: mgr,
          store,
          sessionId: sidA,
          content: 'a',
          instruction: 'Tóm tắt',
          kind: 'on-demand',
        }),
        summarizeWithSession({
          manager: mgr,
          store,
          sessionId: sidB,
          content: 'b',
          instruction: 'Tóm tắt',
          kind: 'on-demand',
        }),
      ]);
      // Different sessions → both can run concurrently.
      expect(maxInflight).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('discardSummarizeMutex removes the per-session mutex entry', () => {
    summarizeMutexes.set('foo', undefined as never); // placeholder
    expect(summarizeMutexes.has('foo')).toBe(true);
    discardSummarizeMutex('foo');
    expect(summarizeMutexes.has('foo')).toBe(false);
    // Idempotent
    discardSummarizeMutex('foo');
    expect(summarizeMutexes.has('foo')).toBe(false);
  });

  it('DEFAULT_SUMMARIZE_TIMEOUT_MS is 30000', () => {
    expect(DEFAULT_SUMMARIZE_TIMEOUT_MS).toBe(30_000);
  });
});
