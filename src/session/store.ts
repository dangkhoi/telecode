import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, TELECODE_HOME } from '../util/paths.js';
import {
  isVerbosityMode,
  type VerbosityMode,
} from './verbosity.js';
// Plan P1.1: AgentKind is now an open string type defined in agents/types.ts.
// Re-export from here to keep existing imports stable while removing the
// duplicate literal-union definition that used to live in this file.
export type { AgentKind } from '../agents/types.js';

export type SessionStatus = 'idle' | 'running' | 'waiting_approval' | 'interrupted' | 'closed';

export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  created_at: number;
}

export interface SessionRow {
  id: string;
  label: string;
  agent: import('../agents/types.js').AgentKind;
  project_id: number | null;
  chat_id: number;
  sdk_session_id: string | null;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  last_message: string | null;
  transcript_tail: string;
  /**
   * Set by `/handoff`: a self-generated summary that should be injected once
   * into the next plain-text dispatch (then cleared). `null` means no pending
   * handoff context. See commands/index.ts plain-text handler.
   */
  handoff_context: string | null;
  /**
   * Phase B (v1.1): per-session verbosity override. `null` → fall back to the
   * chat default (`chat_settings.default_mode`) and then `summary`. Set via
   * `/mode <name>`. Stored as raw TEXT — coerced to {@link VerbosityMode} by
   * {@link SessionStore.getSessionMode}.
   */
  verbosity_mode: string | null;
}

export interface ToolLogRow {
  id: number;
  session_id: string;
  tool_name: string;
  input_preview: string | null;
  decision: string | null;
  duration_ms: number | null;
  created_at: number;
}

export class SessionStore {
  readonly db: Database.Database;

  constructor(path = DB_PATH) {
    mkdirSync(TELECODE_HOME, { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    const here = dirname(fileURLToPath(import.meta.url));
    // schema.sql is copied next to the compiled JS via build step OR resolved from src in dev.
    let schemaSql: string;
    try {
      schemaSql = readFileSync(`${here}/schema.sql`, 'utf8');
    } catch {
      // dev/tsx fallback
      schemaSql = readFileSync(`${here}/../../src/session/schema.sql`, 'utf8');
    }
    this.db.exec(schemaSql);

    // ---- one-time idempotent migrations ----
    // SQLite CREATE TABLE IF NOT EXISTS skips the table entirely on
    // upgrade, so adding columns to an existing schema needs PRAGMA-guarded
    // ALTER. Add new columns here as the schema evolves; ALTER TABLE ADD
    // COLUMN errors if the column already exists, so we probe first.
    const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('handoff_context')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN handoff_context TEXT`);
    }
    // Phase B (v1.1) — per-session verbosity override. Nullable so existing
    // rows (created pre-v1.1) keep falling back to the chat default + the
    // baked-in 'summary'. Idempotent: schema.sql adds the column for fresh
    // installs, ALTER below adds it for upgrades.
    if (!colNames.has('verbosity_mode')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN verbosity_mode TEXT`);
    }
  }

  // ---------- Projects ----------
  upsertProject(name: string, path: string): ProjectRow {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO projects (name, path, created_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET path = excluded.path
       RETURNING id, name, path, created_at`,
    );
    return stmt.get(name, path, now) as ProjectRow;
  }
  listProjects(): ProjectRow[] {
    return this.db.prepare(`SELECT * FROM projects ORDER BY name`).all() as ProjectRow[];
  }
  getProject(id: number | null): ProjectRow | undefined {
    if (id == null) return undefined;
    return this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
  }
  findProject(nameOrPath: string): ProjectRow | undefined {
    return this.db
      .prepare(`SELECT * FROM projects WHERE name = ? OR path = ? LIMIT 1`)
      .get(nameOrPath, nameOrPath) as ProjectRow | undefined;
  }

  // ---------- Sessions ----------
  createSession(row: Omit<SessionRow, 'created_at' | 'updated_at' | 'transcript_tail' | 'last_message' | 'handoff_context' | 'verbosity_mode'> & {
    transcript_tail?: string;
    last_message?: string | null;
  }): SessionRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id,label,agent,project_id,chat_id,sdk_session_id,status,created_at,updated_at,last_message,transcript_tail)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.label,
        row.agent,
        row.project_id,
        row.chat_id,
        row.sdk_session_id,
        row.status,
        now,
        now,
        row.last_message ?? null,
        row.transcript_tail ?? '',
      );
    return this.getSession(row.id)!;
  }
  getSession(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  }
  findSessionByLabel(chatId: number, label: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE chat_id = ? AND label = ? AND status != 'closed'`)
      .get(chatId, label) as SessionRow | undefined;
  }
  listSessions(chatId: number, includeClosed = false): SessionRow[] {
    const sql = includeClosed
      ? `SELECT * FROM sessions WHERE chat_id = ? ORDER BY updated_at DESC`
      : `SELECT * FROM sessions WHERE chat_id = ? AND status != 'closed' ORDER BY updated_at DESC`;
    return this.db.prepare(sql).all(chatId) as SessionRow[];
  }
  updateSession(id: string, patch: Partial<Pick<SessionRow, 'status' | 'sdk_session_id' | 'last_message' | 'transcript_tail' | 'label' | 'project_id' | 'handoff_context' | 'verbosity_mode'>>): void {
    const fields: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
    fields.push(`updated_at = ?`);
    vals.push(Date.now());
    vals.push(id);
    this.db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  appendTranscript(id: string, line: string, maxLines = 50): void {
    const row = this.getSession(id);
    if (!row) return;
    const lines = (row.transcript_tail ?? '').split('\n').filter(Boolean);
    lines.push(line);
    const tail = lines.slice(-maxLines).join('\n');
    this.updateSession(id, { transcript_tail: tail, last_message: line });
  }
  markRunningAsInterrupted(): SessionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE status IN ('running','waiting_approval')`)
      .all() as SessionRow[];
    this.db
      .prepare(`UPDATE sessions SET status = 'interrupted', updated_at = ? WHERE status IN ('running','waiting_approval')`)
      .run(Date.now());
    return rows;
  }

  // ---------- Tool log ----------
  logTool(row: Omit<ToolLogRow, 'id' | 'created_at'>): void {
    this.db
      .prepare(
        `INSERT INTO tool_log (session_id,tool_name,input_preview,decision,duration_ms,created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(row.session_id, row.tool_name, row.input_preview, row.decision, row.duration_ms, Date.now());
  }
  tailToolLog(sessionId: string, n: number): ToolLogRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM tool_log WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all(sessionId, n) as ToolLogRow[];
    return rows.reverse();
  }
  pruneToolLog(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const res = this.db.prepare(`DELETE FROM tool_log WHERE created_at < ?`).run(cutoff);
    return Number(res.changes);
  }

  // ---------- Approvals ----------
  recordApproval(id: string, sessionId: string, toolName: string, inputJson: string): void {
    this.db
      .prepare(`INSERT INTO approvals (id,session_id,tool_name,input_json,created_at) VALUES (?,?,?,?,?)`)
      .run(id, sessionId, toolName, inputJson, Date.now());
  }
  resolveApproval(id: string, decision: string): void {
    this.db
      .prepare(`UPDATE approvals SET decision = ?, resolved_at = ? WHERE id = ?`)
      .run(decision, Date.now(), id);
  }

  // ---------- Chat state ----------
  setActiveSession(chatId: number, sessionId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO chat_state (chat_id, active_session_id) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET active_session_id = excluded.active_session_id`,
      )
      .run(chatId, sessionId);
  }
  setActiveProject(chatId: number, projectId: number | null): void {
    this.db
      .prepare(
        `INSERT INTO chat_state (chat_id, active_project_id) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET active_project_id = excluded.active_project_id`,
      )
      .run(chatId, projectId);
  }
  getChatState(chatId: number): { active_session_id: string | null; active_project_id: number | null } {
    const row = this.db
      .prepare(`SELECT active_session_id, active_project_id FROM chat_state WHERE chat_id = ?`)
      .get(chatId) as { active_session_id: string | null; active_project_id: number | null } | undefined;
    return row ?? { active_session_id: null, active_project_id: null };
  }

  // ---------- Verbosity (Phase B / plan §B.2) ----------
  /**
   * Return the per-session verbosity override, or `null` when none was set
   * (caller should then fall back to {@link getChatDefaultMode}).
   *
   * Returns `null` for malformed values too (defensive — protects against a
   * future TEXT value that doesn't match any known mode, e.g. someone hand-
   * edited the DB). The resolver in `verbosity.ts` will then fall through to
   * the chat default → baked-in default.
   */
  getSessionMode(sessionId: string): VerbosityMode | null {
    const row = this.db
      .prepare(`SELECT verbosity_mode FROM sessions WHERE id = ?`)
      .get(sessionId) as { verbosity_mode: string | null } | undefined;
    if (!row || row.verbosity_mode == null) return null;
    return isVerbosityMode(row.verbosity_mode) ? row.verbosity_mode : null;
  }

  /**
   * Persist a per-session override. Reuses the existing `updateSession`
   * path so the `updated_at` bookkeeping stays consistent with other writes.
   */
  setSessionMode(sessionId: string, mode: VerbosityMode): void {
    this.updateSession(sessionId, { verbosity_mode: mode });
  }

  /**
   * Return the per-chat default mode, or {@link DEFAULT_VERBOSITY_MODE}
   * (which is `'summary'`) when the chat has no row yet. The fall-back is
   * applied here so callers can treat the return as non-null.
   *
   * NOTE: this method is purely a read — it does NOT auto-insert a default
   * row. The migration-message bookkeeping (plan §B.5) relies on the absence
   * of a chat_settings row as the "first boot of v1.1 for this chat" marker;
   * auto-inserting here would defeat that.
   */
  getChatDefaultMode(chatId: number): VerbosityMode {
    const row = this.db
      .prepare(`SELECT default_mode FROM chat_settings WHERE chat_id = ?`)
      .get(chatId) as { default_mode: string | null } | undefined;
    if (!row || row.default_mode == null) return 'summary';
    return isVerbosityMode(row.default_mode) ? row.default_mode : 'summary';
  }

  /**
   * Idempotent upsert for the chat default. Used by `/settings mode <name>`
   * and by the migration-message handler in `src/index.ts` to mark a chat as
   * "v1.1 announcement already shown".
   */
  setChatDefaultMode(chatId: number, mode: VerbosityMode): void {
    this.db
      .prepare(
        `INSERT INTO chat_settings (chat_id, default_mode) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET default_mode = excluded.default_mode`,
      )
      .run(chatId, mode);
  }

  /**
   * Returns `true` when the chat has NO chat_settings row yet — used by the
   * v1.1 migration announcement (plan §B.5) to decide whether to send the
   * one-shot "mode default is now Summary" message.
   */
  chatSettingsExists(chatId: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS one FROM chat_settings WHERE chat_id = ?`)
      .get(chatId) as { one: number } | undefined;
    return row != null;
  }

  close(): void {
    this.db.close();
  }
}
