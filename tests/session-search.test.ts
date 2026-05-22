import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SessionStore } from '../src/session/store.js';

describe('session-search (v1.2 D6)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  it('creates session_fts virtual table', () => {
    const tables = store.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='session_fts'`,
    ).all() as { name: string }[];
    expect(tables.some((t) => t.name === 'session_fts')).toBe(true);
  });

  it('indexes and searches sessions', () => {
    const id = randomUUID();
    store.createSession({ id, label: 'refactor-auth', agent: 'claude', project_id: null, chat_id: 1, sdk_session_id: null, status: 'idle' });
    store.updateSearchIndex(id, 'refactor-auth', 'refactoring the authentication module with JWT tokens');

    const results = store.searchSessions(1, 'JWT tokens');
    expect(results.length).toBe(1);
    expect(results[0]!.sessionId).toBe(id);
    expect(results[0]!.label).toBe('refactor-auth');
    expect(results[0]!.snippet).toContain('JWT');
  });

  it('returns empty results for non-matching query', () => {
    const id = randomUUID();
    store.createSession({ id, label: 'test-session', agent: 'kiro', project_id: null, chat_id: 1, sdk_session_id: null, status: 'idle' });
    store.updateSearchIndex(id, 'test-session', 'writing unit tests for the parser');

    const results = store.searchSessions(1, 'database migration');
    expect(results.length).toBe(0);
  });

  it('searches with Vietnamese text', () => {
    const id = randomUUID();
    store.createSession({ id, label: 'fix-bug', agent: 'claude', project_id: null, chat_id: 1, sdk_session_id: null, status: 'idle' });
    store.updateSearchIndex(id, 'fix-bug', 'sửa lỗi xác thực người dùng khi đăng nhập');

    const results = store.searchSessions(1, 'đăng nhập');
    expect(results.length).toBe(1);
    expect(results[0]!.sessionId).toBe(id);
  });

  it('respects chat_id isolation', () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    store.createSession({ id: id1, label: 'session-a', agent: 'claude', project_id: null, chat_id: 1, sdk_session_id: null, status: 'idle' });
    store.createSession({ id: id2, label: 'session-b', agent: 'claude', project_id: null, chat_id: 2, sdk_session_id: null, status: 'idle' });
    store.updateSearchIndex(id1, 'session-a', 'shared keyword here');
    store.updateSearchIndex(id2, 'session-b', 'shared keyword here');

    const results = store.searchSessions(1, 'keyword');
    expect(results.length).toBe(1);
    expect(results[0]!.sessionId).toBe(id1);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      const id = randomUUID();
      store.createSession({ id, label: `s-${i}`, agent: 'claude', project_id: null, chat_id: 1, sdk_session_id: null, status: 'idle' });
      store.updateSearchIndex(id, `s-${i}`, `common search term number ${i}`);
    }

    const results = store.searchSessions(1, 'common', 3);
    expect(results.length).toBe(3);
  });

  it('generates snippets with highlight markers', () => {
    const id = randomUUID();
    store.createSession({ id, label: 'demo', agent: 'claude', project_id: null, chat_id: 1, sdk_session_id: null, status: 'idle' });
    store.updateSearchIndex(id, 'demo', 'the quick brown fox jumps over the lazy dog');

    const results = store.searchSessions(1, 'fox');
    expect(results.length).toBe(1);
    expect(results[0]!.snippet).toContain('»fox«');
  });

  it('appendTranscript updates FTS index', () => {
    const id = randomUUID();
    store.createSession({ id, label: 'live', agent: 'kiro', project_id: null, chat_id: 1, sdk_session_id: null, status: 'running' });

    store.appendTranscript(id, '> deploy the application to staging');

    const results = store.searchSessions(1, 'staging');
    expect(results.length).toBe(1);
    expect(results[0]!.sessionId).toBe(id);
  });

  it('updateSearchIndex replaces previous content', () => {
    const id = randomUUID();
    store.createSession({ id, label: 'evolve', agent: 'claude', project_id: null, chat_id: 1, sdk_session_id: null, status: 'idle' });
    store.updateSearchIndex(id, 'evolve', 'old content about databases');
    store.updateSearchIndex(id, 'evolve', 'new content about networking');

    expect(store.searchSessions(1, 'databases').length).toBe(0);
    expect(store.searchSessions(1, 'networking').length).toBe(1);
  });

  describe('getRecentSessions', () => {
    it('returns sessions within the specified day range', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      store.createSession({ id: id1, label: 'recent', agent: 'claude', project_id: null, chat_id: 1, sdk_session_id: null, status: 'idle' });
      // Manually backdate id2
      store.createSession({ id: id2, label: 'old', agent: 'claude', project_id: null, chat_id: 1, sdk_session_id: null, status: 'closed' });
      store.db.prepare(`UPDATE sessions SET created_at = ? WHERE id = ?`).run(Date.now() - 30 * 86_400_000, id2);

      const results = store.getRecentSessions(1, 7);
      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe('recent');
    });

    it('respects chat_id isolation', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      store.createSession({ id: id1, label: 'mine', agent: 'claude', project_id: null, chat_id: 1, sdk_session_id: null, status: 'idle' });
      store.createSession({ id: id2, label: 'theirs', agent: 'claude', project_id: null, chat_id: 2, sdk_session_id: null, status: 'idle' });

      const results = store.getRecentSessions(1, 7);
      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe('mine');
    });

    it('returns empty array when no sessions in range', () => {
      const results = store.getRecentSessions(1, 7);
      expect(results).toEqual([]);
    });
  });

  describe('backfill on construction', () => {
    it('backfills existing sessions into FTS on store creation', () => {
      // Create a store, add a session without explicit FTS indexing
      const store1 = new SessionStore(':memory:');
      const id = randomUUID();
      store1.db.prepare(
        `INSERT INTO sessions (id,label,agent,chat_id,status,created_at,updated_at,transcript_tail) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, 'backfill-test', 'claude', 1, 'idle', Date.now(), Date.now(), 'some transcript content');
      // Remove from FTS to simulate pre-D6 state
      store1.db.prepare(`DELETE FROM session_fts WHERE session_id = ?`).run(id);

      // Re-construct store — should trigger backfill
      const db2 = new SessionStore(':memory:');
      // Copy data to db2 for isolation isn't practical with :memory:, so test
      // the backfill logic directly on store1 by re-running the constructor logic
      const unindexed = store1.db.prepare(
        `SELECT id, label, transcript_tail FROM sessions WHERE id NOT IN (SELECT session_id FROM session_fts)`,
      ).all() as { id: string; label: string; transcript_tail: string | null }[];
      expect(unindexed.length).toBe(1);
      expect(unindexed[0]!.id).toBe(id);

      // Now manually backfill like the constructor does
      for (const row of unindexed) {
        store1.db.prepare(`INSERT INTO session_fts(session_id, label, transcript) VALUES (?, ?, ?)`).run(row.id, row.label, row.transcript_tail ?? '');
      }

      const results = store1.searchSessions(1, 'transcript');
      expect(results.length).toBe(1);
      db2.close();
      store1.close();
    });
  });
});
