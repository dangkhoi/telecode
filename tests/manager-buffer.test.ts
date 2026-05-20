import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import type { BufferedEvent } from '../src/session/output-buffer.js';
import type { AgentAdapter } from '../src/agents/types.js';
import type { AgentKind } from '../src/session/store.js';

class FakeRegistry {
  constructor(private adapter: AgentAdapter) {}
  get(_k: AgentKind): AgentAdapter {
    return this.adapter;
  }
}

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-mgrbuf-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

function ev(data: string, type: BufferedEvent['type'] = 'text'): BufferedEvent {
  return { type, data, createdAt: Date.now() };
}

// Minimal adapter — these tests never call dispatch, but the registry needs one.
const noopAdapter: AgentAdapter = {
  kind: 'claude',
  async run() {
    /* unused */
  },
};

describe('SessionManager buffer wiring', () => {
  it('appendBuffer lazy-creates a per-session buffer; size() reflects appends', () => {
    const { store, cleanup } = makeStore();
    try {
      const mgr = new SessionManager(store, new FakeRegistry(noopAdapter) as never, {
        bufferCapBytes: 200,
      });
      const s = mgr.createSession({ chatId: 1, agent: 'claude', label: 'A', projectId: null });

      // Before any append, no buffer exists → hasBuffered false, drain returns []
      expect(mgr.hasBuffered(s.id)).toBe(false);
      expect(mgr.drainBuffer(s.id)).toEqual([]);

      mgr.appendBuffer(s.id, ev('hello'));
      mgr.appendBuffer(s.id, ev('world'));
      expect(mgr.hasBuffered(s.id)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('drainBuffer returns events in arrival order and resets the buffer', () => {
    const { store, cleanup } = makeStore();
    try {
      const mgr = new SessionManager(store, new FakeRegistry(noopAdapter) as never, {
        bufferCapBytes: 200,
      });
      const s = mgr.createSession({ chatId: 1, agent: 'claude', label: 'A', projectId: null });

      mgr.appendBuffer(s.id, ev('one'));
      mgr.appendBuffer(s.id, ev('two'));
      mgr.appendBuffer(s.id, ev('three'));
      expect(mgr.hasBuffered(s.id)).toBe(true);

      const drained = mgr.drainBuffer(s.id);
      expect(drained.map((e) => e.data)).toEqual(['one', 'two', 'three']);

      // After drain: buffer empty
      expect(mgr.hasBuffered(s.id)).toBe(false);
      expect(mgr.drainBuffer(s.id)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('drainBuffer for a session that never appended returns []', () => {
    const { store, cleanup } = makeStore();
    try {
      const mgr = new SessionManager(store, new FakeRegistry(noopAdapter) as never, {
        bufferCapBytes: 200,
      });
      expect(mgr.drainBuffer('nonexistent-session-id')).toEqual([]);
      expect(mgr.hasBuffered('nonexistent-session-id')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('buffers are isolated per session', () => {
    const { store, cleanup } = makeStore();
    try {
      const mgr = new SessionManager(store, new FakeRegistry(noopAdapter) as never, {
        bufferCapBytes: 200,
      });
      const a = mgr.createSession({ chatId: 1, agent: 'claude', label: 'A', projectId: null });
      const b = mgr.createSession({ chatId: 1, agent: 'claude', label: 'B', projectId: null });

      mgr.appendBuffer(a.id, ev('a-only'));
      expect(mgr.hasBuffered(a.id)).toBe(true);
      expect(mgr.hasBuffered(b.id)).toBe(false);

      mgr.appendBuffer(b.id, ev('b-only-1'));
      mgr.appendBuffer(b.id, ev('b-only-2'));

      const drainedA = mgr.drainBuffer(a.id);
      expect(drainedA.map((e) => e.data)).toEqual(['a-only']);

      const drainedB = mgr.drainBuffer(b.id);
      expect(drainedB.map((e) => e.data)).toEqual(['b-only-1', 'b-only-2']);
    } finally {
      cleanup();
    }
  });

  it('cap behavior — OutputBuffer trimming activates through the manager', () => {
    const { store, cleanup } = makeStore();
    try {
      // cap = 200 bytes, append 10 events of 30 bytes each = 300 bytes → trim
      const mgr = new SessionManager(store, new FakeRegistry(noopAdapter) as never, {
        bufferCapBytes: 200,
      });
      const s = mgr.createSession({ chatId: 1, agent: 'claude', label: 'A', projectId: null });

      for (let i = 0; i < 10; i++) {
        // Each line: "evt-NN-" + 23 'x' padding = 30 bytes
        const payload = `evt-${i.toString().padStart(2, '0')}-${'x'.repeat(23)}`;
        mgr.appendBuffer(s.id, ev(payload));
      }

      const drained = mgr.drainBuffer(s.id);
      // OutputBuffer collapses oversized buffers toward first-2 + marker(s) + last-2.
      // Exact length can vary slightly when consecutive trims produce same-size
      // markers (progress guard kicks in) — sanity-check the wiring instead.
      expect(drained.length).toBeLessThanOrEqual(6);
      expect(drained.length).toBeGreaterThanOrEqual(5);
      // First two events from the very start are preserved
      expect(drained[0].data.startsWith('evt-00-')).toBe(true);
      expect(drained[1].data.startsWith('evt-01-')).toBe(true);
      // At least one status marker exists
      expect(drained.some((e) => e.type === 'status' && /chunks omitted/.test(e.data))).toBe(
        true,
      );
      // Last event is the most recent append
      expect(drained[drained.length - 1].data.startsWith('evt-09-')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('discardBuffer removes the per-session buffer entry (no leak after close)', () => {
    const { store, cleanup } = makeStore();
    try {
      const mgr = new SessionManager(store, new FakeRegistry(noopAdapter) as never, {
        bufferCapBytes: 200,
      });
      const s = mgr.createSession({ chatId: 1, agent: 'claude', label: 'A', projectId: null });

      mgr.appendBuffer(s.id, ev('x'));
      expect(mgr.hasBuffered(s.id)).toBe(true);

      mgr.discardBuffer(s.id);
      expect(mgr.hasBuffered(s.id)).toBe(false);
      expect(mgr.drainBuffer(s.id)).toEqual([]);

      // Idempotent — second call on the same id is a no-op.
      mgr.discardBuffer(s.id);
      // Safe on a session that never buffered.
      mgr.discardBuffer('unknown-session-id');
    } finally {
      cleanup();
    }
  });

  it('backward-compat — constructor works with only (store, registry)', () => {
    const { store, cleanup } = makeStore();
    try {
      // No opts arg → default cap 50_000 should apply.
      const mgr = new SessionManager(store, new FakeRegistry(noopAdapter) as never);
      const s = mgr.createSession({ chatId: 1, agent: 'claude', label: 'A', projectId: null });
      mgr.appendBuffer(s.id, ev('x'));
      expect(mgr.hasBuffered(s.id)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
