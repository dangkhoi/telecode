/**
 * Phase A.5 — PendingTools queue.
 *
 * Verifies the three behaviours the dispatch handler relies on:
 *  1. add() registers a pending entry and starts a defer timer.
 *  2. resolve() matches the most recent pending entry by toolName, cancels
 *     the timer, and returns the entry payload.
 *  3. When the defer timer fires before resolve(), onTimeout is invoked once
 *     with the entry; subsequent resolve() returns null.
 *  4. clear() drops all entries + cancels timers (no orphan callbacks).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PendingTools } from '../src/bot/pending-tools.js';

describe('PendingTools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds an entry and returns it', () => {
    const pq = new PendingTools<{ note: string }>({
      deferMs: 100,
      onTimeout: () => {},
    });
    const entry = pq.add('Read', 42, { note: 'a' });
    expect(entry.toolName).toBe('Read');
    expect(entry.messageId).toBe(42);
    expect(entry.payload).toEqual({ note: 'a' });
    expect(pq.size()).toBe(1);
  });

  it('resolve() matches by toolName (LIFO when duplicates) and returns entry', () => {
    const pq = new PendingTools<{ which: string }>({
      deferMs: 100,
      onTimeout: () => {},
    });
    pq.add('Read', 1, { which: 'first' });
    pq.add('Bash', 2, { which: 'bash' });
    pq.add('Read', 3, { which: 'second' });
    const got = pq.resolve('Read');
    expect(got).not.toBeNull();
    expect(got!.payload.which).toBe('second'); // LIFO match
    expect(pq.size()).toBe(2);
  });

  it('resolve() returns null when no match', () => {
    const pq = new PendingTools<unknown>({ deferMs: 100, onTimeout: () => {} });
    pq.add('Read', 1, null);
    expect(pq.resolve('Bash')).toBeNull();
    expect(pq.size()).toBe(1);
  });

  it('onTimeout fires for an unresolved entry after deferMs', () => {
    const onTimeout = vi.fn();
    const pq = new PendingTools<unknown>({ deferMs: 2000, onTimeout });
    pq.add('Read', 7, { tag: 'orphan' });
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const callArg = onTimeout.mock.calls[0]![0];
    expect(callArg.toolName).toBe('Read');
    expect(callArg.messageId).toBe(7);
    expect(pq.size()).toBe(0); // removed before callback
  });

  it('resolve() before timeout cancels the timer (no double-fire)', () => {
    const onTimeout = vi.fn();
    const pq = new PendingTools<unknown>({ deferMs: 2000, onTimeout });
    pq.add('Bash', 99, null);
    const got = pq.resolve('Bash');
    expect(got).not.toBeNull();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('clear() removes all entries and cancels their timers', () => {
    const onTimeout = vi.fn();
    const pq = new PendingTools<unknown>({ deferMs: 1000, onTimeout });
    pq.add('Read', 1, null);
    pq.add('Bash', 2, null);
    pq.add('Edit', 3, null);
    expect(pq.size()).toBe(3);
    pq.clear();
    expect(pq.size()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('onTimeout callback that throws does not crash the queue', () => {
    const pq = new PendingTools<unknown>({
      deferMs: 50,
      onTimeout: () => {
        throw new Error('callback boom');
      },
    });
    pq.add('Read', 1, null);
    // Should not throw — callback errors are swallowed defensively.
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    expect(pq.size()).toBe(0);
  });

  // Senior-review (Opus 4.7) [P1] — race-safe addPending coverage.
  describe('addPending (race-safe registration)', () => {
    it('enqueues SYNCHRONOUSLY so resolve() that races wins the entry', async () => {
      const pq = new PendingTools<{ tag: string }>({
        deferMs: 1_000,
        onTimeout: () => {},
      });
      // Send promise that never resolves within this microtask round.
      const sendPromise = new Promise<number | null>(() => {
        /* deliberately pending */
      });
      pq.addPending('Bash', { tag: 'fast' }, sendPromise);
      // Even though sendPromise hasn't resolved, the entry IS already
      // queued — a tool_result arriving in the same tick can resolve it.
      expect(pq.size()).toBe(1);
      const got = pq.resolve('Bash');
      expect(got).not.toBeNull();
      expect(got!.payload.tag).toBe('fast');
      // messageId is still null (send never resolved) but resolve() returned
      // the entry — caller is expected to await `messageReady` before edit.
      expect(got!.messageId).toBeNull();
    });

    it('defer timer starts only AFTER the send resolves with an id', async () => {
      // Run with real timers so the promise microtask flushes naturally.
      vi.useRealTimers();
      const onTimeout = vi.fn();
      const pq = new PendingTools<unknown>({ deferMs: 30, onTimeout });
      let resolveSend: (v: number | null) => void = () => {};
      const sendPromise = new Promise<number | null>((r) => {
        resolveSend = r;
      });
      pq.addPending('Read', null, sendPromise);
      // Wait 30ms — defer SHOULD NOT have fired because send hasn't resolved.
      await new Promise((r) => setTimeout(r, 60));
      expect(onTimeout).not.toHaveBeenCalled();
      // Resolve the send. Defer timer now starts; wait it out.
      resolveSend(42);
      await new Promise((r) => setTimeout(r, 60));
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout.mock.calls[0]![0].messageId).toBe(42);
      vi.useFakeTimers();
    });

    it('send failure (sendPromise resolves null) silently drops the entry', async () => {
      vi.useRealTimers();
      const onTimeout = vi.fn();
      const pq = new PendingTools<unknown>({ deferMs: 30, onTimeout });
      pq.addPending('Bash', null, Promise.resolve(null));
      await new Promise((r) => setTimeout(r, 60));
      expect(onTimeout).not.toHaveBeenCalled();
      expect(pq.size()).toBe(0);
      vi.useFakeTimers();
    });

    it('send rejection is normalized to null — no unhandled rejection', async () => {
      vi.useRealTimers();
      const pq = new PendingTools<unknown>({ deferMs: 30, onTimeout: () => {} });
      const entry = pq.addPending('Bash', null, Promise.reject(new Error('boom')));
      // messageReady must resolve to null without throwing.
      await expect(entry.messageReady).resolves.toBeNull();
      vi.useFakeTimers();
    });
  });

  // Senior-review (Opus 4.7) [P1] — collapse-burst regression coverage.
  describe('updateAllPayloads (collapse-burst integration)', () => {
    it('updates EVERY matching entry, not just the most recent', () => {
      const pq = new PendingTools<{ line: string }>({
        deferMs: 1_000,
        onTimeout: () => {},
      });
      pq.add('Read', 1, { line: 'old' });
      pq.add('Bash', 2, { line: 'bash-untouched' });
      pq.add('Read', 3, { line: 'old-2' });
      pq.add('Read', 4, { line: 'old-3' });
      const n = pq.updateAllPayloads('Read', (p) => ({ ...p, line: 'NEW' }));
      expect(n).toBe(3);
      // LIFO resolve walks newest first; every Read should report 'NEW'.
      const first = pq.resolve('Read');
      expect(first!.payload.line).toBe('NEW');
      const second = pq.resolve('Read');
      expect(second!.payload.line).toBe('NEW');
      const third = pq.resolve('Read');
      expect(third!.payload.line).toBe('NEW');
      // Untouched Bash entry retains its original payload.
      const bash = pq.resolve('Bash');
      expect(bash!.payload.line).toBe('bash-untouched');
    });

    it('returns 0 when no entries match the toolName', () => {
      const pq = new PendingTools<{ k: string }>({
        deferMs: 1_000,
        onTimeout: () => {},
      });
      pq.add('Bash', 1, { k: 'x' });
      expect(pq.updateAllPayloads('Read', (p) => p)).toBe(0);
    });
  });
});
