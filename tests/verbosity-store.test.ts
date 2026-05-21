/**
 * Phase B — SessionStore migration + helpers for verbosity (plan §B.2).
 *
 * Covers:
 *  - Idempotent migration: re-opening the same DB doesn't error or duplicate
 *    the `sessions.verbosity_mode` column.
 *  - chat_settings table exists after migration.
 *  - get/set per-session + per-chat helpers persist + roundtrip.
 *  - Fallback chain (session override → chat default → 'summary').
 *  - chatSettingsExists distinguishes "shown announcement" vs "fresh".
 *  - Backward compat: a v1.0 schema DB (no verbosity_mode col) gets migrated
 *    on open without losing existing rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SessionStore } from '../src/session/store.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'telecode-verb-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function newDbPath(name = 's.db'): string {
  return join(tmpDir, name);
}

describe('SessionStore — verbosity migration', () => {
  it('fresh DB has sessions.verbosity_mode column (from schema.sql) + chat_settings table', () => {
    const path = newDbPath();
    const store = new SessionStore(path);
    try {
      const cols = store.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain('verbosity_mode');

      const tables = store.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='chat_settings'`)
        .all() as { name: string }[];
      expect(tables).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('reopening an existing DB does not re-run ALTER (idempotent)', () => {
    const path = newDbPath();
    let store = new SessionStore(path);
    store.close();
    // Second open — should NOT throw "duplicate column" on the ALTER guard.
    expect(() => {
      store = new SessionStore(path);
      store.close();
    }).not.toThrow();
  });

  it('v1.0 schema (no verbosity_mode column) is migrated forward on open', () => {
    const path = newDbPath('v1_0_legacy.db');
    // Seed a v1.0-style sessions table missing verbosity_mode.
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, label TEXT, agent TEXT, project_id INTEGER,
        chat_id INTEGER NOT NULL, sdk_session_id TEXT,
        status TEXT, created_at INTEGER, updated_at INTEGER,
        last_message TEXT, transcript_tail TEXT, handoff_context TEXT
      );
      INSERT INTO sessions (id,label,agent,chat_id,status,created_at,updated_at)
      VALUES ('legacy-1','old','claude',7,'idle', 1, 1);
    `);
    raw.close();

    const store = new SessionStore(path);
    try {
      const cols = store.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain('verbosity_mode');
      // Pre-existing row survives + has null override.
      const row = store.getSession('legacy-1');
      expect(row).toBeDefined();
      expect(row!.verbosity_mode).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('SessionStore — session/chat mode helpers', () => {
  it('getSessionMode returns null for fresh session (no override)', () => {
    const store = new SessionStore(newDbPath());
    try {
      const sess = store.createSession({
        id: 's1',
        label: 'x',
        agent: 'claude',
        project_id: null,
        chat_id: 1,
        sdk_session_id: null,
        status: 'idle',
      });
      expect(sess.verbosity_mode).toBeNull();
      expect(store.getSessionMode('s1')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('setSessionMode persists + getSessionMode returns it', () => {
    const store = new SessionStore(newDbPath());
    try {
      store.createSession({
        id: 's1',
        label: 'x',
        agent: 'claude',
        project_id: null,
        chat_id: 1,
        sdk_session_id: null,
        status: 'idle',
      });
      store.setSessionMode('s1', 'verbose');
      expect(store.getSessionMode('s1')).toBe('verbose');
      // Roundtrips through the SessionRow shape too.
      expect(store.getSession('s1')!.verbosity_mode).toBe('verbose');

      // Overwrite works.
      store.setSessionMode('s1', 'normal');
      expect(store.getSessionMode('s1')).toBe('normal');
    } finally {
      store.close();
    }
  });

  it('getSessionMode rejects DB-stored garbage (defensive)', () => {
    const store = new SessionStore(newDbPath());
    try {
      store.createSession({
        id: 's1',
        label: 'x',
        agent: 'claude',
        project_id: null,
        chat_id: 1,
        sdk_session_id: null,
        status: 'idle',
      });
      // Hand-poke an invalid value into the row to simulate edited DB.
      store.db.prepare(`UPDATE sessions SET verbosity_mode = ? WHERE id = ?`).run('bogus', 's1');
      expect(store.getSessionMode('s1')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('getChatDefaultMode returns "summary" when no chat_settings row exists', () => {
    const store = new SessionStore(newDbPath());
    try {
      expect(store.getChatDefaultMode(42)).toBe('summary');
    } finally {
      store.close();
    }
  });

  it('setChatDefaultMode upserts + getChatDefaultMode returns it', () => {
    const store = new SessionStore(newDbPath());
    try {
      store.setChatDefaultMode(99, 'verbose');
      expect(store.getChatDefaultMode(99)).toBe('verbose');
      // Update wins (no UNIQUE conflict).
      store.setChatDefaultMode(99, 'thinking');
      expect(store.getChatDefaultMode(99)).toBe('thinking');
    } finally {
      store.close();
    }
  });

  it('chatSettingsExists distinguishes pre-/post-announcement state', () => {
    const store = new SessionStore(newDbPath());
    try {
      expect(store.chatSettingsExists(1)).toBe(false);
      store.setChatDefaultMode(1, 'summary');
      expect(store.chatSettingsExists(1)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('per-session and per-chat preferences are independent', () => {
    const store = new SessionStore(newDbPath());
    try {
      const s = store.createSession({
        id: 'sA',
        label: 'a',
        agent: 'claude',
        project_id: null,
        chat_id: 7,
        sdk_session_id: null,
        status: 'idle',
      });
      void s;
      store.setChatDefaultMode(7, 'verbose');
      store.setSessionMode('sA', 'thinking');
      // Independent lanes.
      expect(store.getChatDefaultMode(7)).toBe('verbose');
      expect(store.getSessionMode('sA')).toBe('thinking');
    } finally {
      store.close();
    }
  });
});
