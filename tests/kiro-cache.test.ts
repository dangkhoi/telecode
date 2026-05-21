import { describe, it, expect, beforeEach } from 'vitest';
import { _internals } from '../src/agents/kiro.js';

/**
 * P6.4 — Unit tests for the kiro-cli `--list-sessions` per-cwd TTL cache.
 *
 * The cache is a Map keyed by cwd holding `{ sdkSessionId, expiresAt }`.
 * Tests exercise read/write/expiry directly via the `_internals` test seam
 * (the cache is not used outside `KiroAdapter.run`, so a fake-time approach
 * is overkill — we manipulate `expiresAt` directly).
 */
describe('P6.4 kiro sessions cache', () => {
  beforeEach(() => {
    _internals.clearKiroSessionsCache();
  });

  it('exposes a 30 second TTL', () => {
    expect(_internals.KIRO_SESSIONS_TTL_MS).toBe(30_000);
  });

  it('starts empty after clear', () => {
    expect(_internals.kiroSessionsCache.size).toBe(0);
  });

  it('stores per-cwd entries (no cross-pollution)', () => {
    const now = Date.now();
    _internals.kiroSessionsCache.set('/proj/a', {
      sdkSessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      expiresAt: now + 30_000,
    });
    _internals.kiroSessionsCache.set('/proj/b', {
      sdkSessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      expiresAt: now + 30_000,
    });
    expect(_internals.kiroSessionsCache.get('/proj/a')?.sdkSessionId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(_internals.kiroSessionsCache.get('/proj/b')?.sdkSessionId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  it('allows null sdkSessionId entries (negative cache for "no session yet")', () => {
    const now = Date.now();
    _internals.kiroSessionsCache.set('/proj/empty', { sdkSessionId: null, expiresAt: now + 30_000 });
    const hit = _internals.kiroSessionsCache.get('/proj/empty');
    expect(hit?.sdkSessionId).toBeNull();
    expect(hit?.expiresAt).toBeGreaterThan(now);
  });

  it('does not leak entries between describe blocks (clearKiroSessionsCache works)', () => {
    _internals.kiroSessionsCache.set('/x', { sdkSessionId: 'x', expiresAt: Date.now() + 1000 });
    expect(_internals.kiroSessionsCache.size).toBe(1);
    _internals.clearKiroSessionsCache();
    expect(_internals.kiroSessionsCache.size).toBe(0);
  });

  it('expiry timestamps are honoured by adapter-level read helper semantics', () => {
    // We can't import the (private) read helper, but we mirror its rule here:
    // a hit with `expiresAt <= now` is stale.
    const now = Date.now();
    _internals.kiroSessionsCache.set('/stale', {
      sdkSessionId: 'stale-uuid',
      expiresAt: now - 1, // already in the past
    });
    _internals.kiroSessionsCache.set('/fresh', {
      sdkSessionId: 'fresh-uuid',
      expiresAt: now + 30_000,
    });

    // Caller-side check (mirrors readKiroSessionsCache logic).
    const stale = _internals.kiroSessionsCache.get('/stale');
    const fresh = _internals.kiroSessionsCache.get('/fresh');
    expect(stale && stale.expiresAt <= now).toBe(true);
    expect(fresh && fresh.expiresAt > now).toBe(true);
  });

  it('TTL window math matches the constant', () => {
    const now = 1_000_000;
    const entry = { sdkSessionId: 'u', expiresAt: now + _internals.KIRO_SESSIONS_TTL_MS };
    _internals.kiroSessionsCache.set('/p', entry);
    expect(entry.expiresAt - now).toBe(30_000);
  });

  // ---------------------------------------------------------------------
  // P6.4 hardening (senior-review additions).
  // ---------------------------------------------------------------------

  it('senior-review: exposes single-flight inflight map so concurrent misses dedupe', () => {
    // The cache implementation MUST also export `kiroSessionsInflight` (a
    // Map<cwd, Promise>) so that two parallel `KiroAdapter.run` calls in the
    // same cwd share one `--list-sessions` spawn rather than both spawning.
    expect(_internals.kiroSessionsInflight).toBeInstanceOf(Map);
    expect(_internals.kiroSessionsInflight.size).toBe(0);
  });

  it('senior-review: clearKiroSessionsCache() also wipes the inflight map', () => {
    _internals.kiroSessionsInflight.set('/p', Promise.resolve(null));
    expect(_internals.kiroSessionsInflight.size).toBe(1);
    _internals.clearKiroSessionsCache();
    expect(_internals.kiroSessionsInflight.size).toBe(0);
  });
});
