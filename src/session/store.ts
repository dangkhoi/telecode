import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, TELECODE_HOME } from '../util/paths.js';

export type SessionStatus = 'idle' | 'running' | 'waiting_approval' | 'interrupted' | 'closed';
export type AgentKind = 'claude' | 'kiro';

export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  created_at: number;
}

export interface SessionRow {
  id: string;
  label: string;
  agent: AgentKind;
  project_id: number | null;
  chat_id: number;
  sdk_session_id: string | null;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  last_message: string | null;
  transcript_tail: string;
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
  findProject(nameOrPath: string): ProjectRow | undefined {
    return this.db
      .prepare(`SELECT * FROM projects WHERE name = ? OR path = ? LIMIT 1`)
      .get(nameOrPath, nameOrPath) as ProjectRow | undefined;
  }

  // ---------- Sessions ----------
  createSession(row: Omit<SessionRow, 'created_at' | 'updated_at' | 'transcript_tail' | 'last_message'> & {
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
  updateSession(id: string, patch: Partial<Pick<SessionRow, 'status' | 'sdk_session_id' | 'last_message' | 'transcript_tail' | 'label' | 'project_id'>>): void {
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

  close(): void {
    this.db.close();
  }
}
