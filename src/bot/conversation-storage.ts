import type { Database } from 'better-sqlite3';
import type { VersionedState, VersionedStateStorage } from '@grammyjs/conversations';

/**
 * SQLite-backed storage adapter for the @grammyjs/conversations plugin.
 *
 * The conversations plugin (v2.1.1) expects a {@link VersionedStateStorage}
 * with synchronous-or-async `read`, `write`, `delete` methods keyed by string.
 * Data is opaque to us — we JSON.stringify on write and JSON.parse on read.
 *
 * Statements are prepared once in the closure (not per-call) for perf:
 * better-sqlite3 prepared statements are reused across `.get()` / `.run()`
 * calls without re-parsing the SQL each time.
 *
 * Errors are NOT swallowed — they propagate to the conversations plugin,
 * which surfaces them to the caller (bot.ts wires error handling).
 *
 * The caller is responsible for ensuring `conversation_state` table exists.
 * SessionStore's constructor runs schema.sql on every open, which creates it
 * idempotently via `CREATE TABLE IF NOT EXISTS`.
 *
 * @param db - A better-sqlite3 Database handle (typically `sessionStore.db`).
 * @returns A VersionedStateStorage<string, unknown> suitable for passing to
 *          `conversations()` as `storage: { type: "key", adapter, version }`.
 */
export function createSqliteConversationStorage<S = unknown>(
  db: Database,
): VersionedStateStorage<string, S> {
  const stmts = {
    read: db.prepare<[string], { data: string }>(
      'SELECT data FROM conversation_state WHERE key = ?',
    ),
    write: db.prepare<[string, string, number]>(
      `INSERT INTO conversation_state(key, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ),
    delete: db.prepare<[string]>('DELETE FROM conversation_state WHERE key = ?'),
  };

  return {
    read(key: string): VersionedState<S> | undefined {
      const row = stmts.read.get(key);
      if (!row) return undefined;
      return JSON.parse(row.data) as VersionedState<S>;
    },
    write(key: string, state: VersionedState<S>): void {
      stmts.write.run(key, JSON.stringify(state), Date.now());
    },
    delete(key: string): void {
      stmts.delete.run(key);
    },
  };
}
