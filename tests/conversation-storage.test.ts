import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VersionedState } from '@grammyjs/conversations';
import { createSqliteConversationStorage } from '../src/bot/conversation-storage.js';

/**
 * SQL run on every open so memory-DBs and file-DBs share the same shape.
 * Must mirror src/session/schema.sql `conversation_state` table verbatim.
 */
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_state (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

function makeMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(CREATE_TABLE_SQL);
  return db;
}

function sampleState(extra: Record<string, unknown> = {}): VersionedState<unknown> {
  return {
    version: [0, 1],
    state: { step: 'agent', agent: 'claude', ...extra },
  };
}

describe('createSqliteConversationStorage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('write then read returns the same state (JSON round-trip)', () => {
    const storage = createSqliteConversationStorage(db);
    const state = sampleState({ project: 'telecode' });

    storage.write('conv:42', state);
    const got = storage.read('conv:42');

    expect(got).toEqual(state);
  });

  it('read returns undefined for a non-existent key', () => {
    const storage = createSqliteConversationStorage(db);
    expect(storage.read('does-not-exist')).toBeUndefined();
  });

  it('write same key twice — second write replaces first (UPSERT)', () => {
    const storage = createSqliteConversationStorage(db);
    const first = sampleState({ step: 'agent' });
    const second = sampleState({ step: 'project', agent: 'kiro' });

    storage.write('conv:99', first);
    storage.write('conv:99', second);

    const got = storage.read('conv:99');
    expect(got).toEqual(second);

    // sanity: still exactly one row
    const count = db.prepare('SELECT COUNT(*) AS n FROM conversation_state').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('delete then read returns undefined', () => {
    const storage = createSqliteConversationStorage(db);
    storage.write('conv:7', sampleState());
    expect(storage.read('conv:7')).toBeDefined();

    storage.delete('conv:7');
    expect(storage.read('conv:7')).toBeUndefined();
  });

  it('delete on a non-existent key does not throw', () => {
    const storage = createSqliteConversationStorage(db);
    expect(() => storage.delete('ghost')).not.toThrow();
  });

  it('preserves nested + special characters via JSON', () => {
    const storage = createSqliteConversationStorage(db);
    const state: VersionedState<unknown> = {
      version: [0, 'v1'],
      state: {
        label: "it's: with \"quotes\" / 中文 / 🎯",
        nested: { a: [1, 2, 3], b: null, c: true },
      },
    };
    storage.write('weird:key', state);
    expect(storage.read('weird:key')).toEqual(state);
  });
});

describe('createSqliteConversationStorage — restart persistence', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `telecode-conv-${process.pid}-`));
    dbPath = join(dir, 'state.db');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('survives a simulated daemon restart (file-backed db, close then reopen)', () => {
    // First boot — write state, close db
    {
      const db = new Database(dbPath);
      db.exec(CREATE_TABLE_SQL);
      const storage = createSqliteConversationStorage(db);
      storage.write('conv:resume', sampleState({ step: 'label', label: 'refactor-auth' }));
      db.close();
    }

    // Second boot — reopen same file, verify state present
    {
      const db = new Database(dbPath);
      db.exec(CREATE_TABLE_SQL); // idempotent
      const storage = createSqliteConversationStorage(db);
      const got = storage.read('conv:resume');
      expect(got).toEqual(sampleState({ step: 'label', label: 'refactor-auth' }));
      db.close();
    }
  });
});
