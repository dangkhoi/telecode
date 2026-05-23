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
  /**
   * Per-session model override. `null` → use adapter default from config.
   * Set via `/model <name>`.
   */
  model: string | null;
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
    if (!colNames.has('model')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`);
    }
    // v1.2 — persist last usage so /status survives daemon restart.
    if (!colNames.has('last_input_tokens')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_input_tokens INTEGER`);
    }
    if (!colNames.has('last_output_tokens')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_output_tokens INTEGER`);
    }
    if (!colNames.has('last_context_window')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_context_window INTEGER`);
    }
    if (!colNames.has('last_model')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_model TEXT`);
    }

    // v1.2 D6 — FTS5 search index + backfill existing sessions.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_id UNINDEXED,
        label,
        transcript,
        tokenize='unicode61'
      );
    `);
    const unindexed = this.db.prepare(
      `SELECT id, label, transcript_tail FROM sessions WHERE id NOT IN (SELECT session_id FROM session_fts)`,
    ).all() as { id: string; label: string; transcript_tail: string | null }[];
    for (const row of unindexed) {
      this.db.prepare(`INSERT INTO session_fts(session_id, label, transcript) VALUES (?, ?, ?)`).run(row.id, row.label, row.transcript_tail ?? '');
    }

    // v1.2 D2 — quiet hours columns on chat_settings.
    const csCols = this.db.prepare(`PRAGMA table_info(chat_settings)`).all() as { name: string }[];
    const csColNames = new Set(csCols.map((c) => c.name));
    if (!csColNames.has('quiet_start')) {
      this.db.exec(`ALTER TABLE chat_settings ADD COLUMN quiet_start INTEGER`);
    }
    if (!csColNames.has('quiet_end')) {
      this.db.exec(`ALTER TABLE chat_settings ADD COLUMN quiet_end INTEGER`);
    }
    if (!csColNames.has('quiet_tz')) {
      this.db.exec(`ALTER TABLE chat_settings ADD COLUMN quiet_tz TEXT`);
    }
    // Phase i18n — per-chat language. SQLite ALTER TABLE cannot add a NOT
    // NULL column without a default, so we add as nullable then backfill.
    // Backfill rule: existing rows (pre-i18n users) → 'vi' to preserve the
    // historical Vietnamese UX; the schema-level DEFAULT 'en' kicks in for
    // FRESH chats only (new chat_settings inserts via setChatLanguage /
    // setChatDefaultMode after this migration runs).
    if (!csColNames.has('language')) {
      this.db.exec(`ALTER TABLE chat_settings ADD COLUMN language TEXT`);
      this.db.exec(`UPDATE chat_settings SET language = 'vi' WHERE language IS NULL`);
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
  createSession(row: Omit<SessionRow, 'created_at' | 'updated_at' | 'transcript_tail' | 'last_message' | 'handoff_context' | 'verbosity_mode' | 'model'> & {
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
  updateSession(id: string, patch: Partial<Pick<SessionRow, 'status' | 'sdk_session_id' | 'last_message' | 'transcript_tail' | 'label' | 'project_id' | 'handoff_context' | 'verbosity_mode' | 'model'>>): void {
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
    this.updateSearchIndex(id, row.label, tail);
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
  getToolLog(sessionId: string): ToolLogRow[] {
    return this.db
      .prepare(`SELECT * FROM tool_log WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as ToolLogRow[];
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
   * Set or clear the per-session model override. Used by `/model <name>`.
   */
  setSessionModel(sessionId: string, model: string | null): void {
    this.db.prepare('UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?').run(model, Date.now(), sessionId);
  }

  /** Persist last usage snapshot so /status survives daemon restart. */
  setSessionUsage(sessionId: string, usage: { inputTokens: number; outputTokens: number; contextWindow: number; model: string }): void {
    this.db.prepare(
      'UPDATE sessions SET last_input_tokens = ?, last_output_tokens = ?, last_context_window = ?, last_model = ?, updated_at = ? WHERE id = ?',
    ).run(usage.inputTokens, usage.outputTokens, usage.contextWindow, usage.model, Date.now(), sessionId);
  }

  /** Load persisted usage (returns null if never set). */
  getSessionUsage(sessionId: string): { inputTokens: number; outputTokens: number; contextWindow: number; model: string } | null {
    const row = this.db.prepare(
      'SELECT last_input_tokens, last_output_tokens, last_context_window, last_model FROM sessions WHERE id = ?',
    ).get(sessionId) as { last_input_tokens: number | null; last_output_tokens: number | null; last_context_window: number | null; last_model: string | null } | undefined;
    if (!row || row.last_input_tokens == null) return null;
    return { inputTokens: row.last_input_tokens, outputTokens: row.last_output_tokens ?? 0, contextWindow: row.last_context_window ?? 0, model: row.last_model ?? '' };
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

  // ---------- i18n (Phase 1 — language picker) ----------
  /**
   * Resolve the chat's UI language. Returns `'vi'` for chats whose
   * chat_settings row was migrated from pre-i18n (preserves the historical
   * Vietnamese UX), `'en'` for fresh installs without a row (matches the
   * schema-level DEFAULT). Unknown values fall back to `'en'` defensively.
   *
   * Pure read — does NOT auto-insert a row, so the `chatSettingsExists`
   * marker for first-boot detection (plan §B.5 + i18n setup picker) stays
   * intact.
   */
  getChatLanguage(chatId: number): 'en' | 'vi' {
    const row = this.db
      .prepare(`SELECT language FROM chat_settings WHERE chat_id = ?`)
      .get(chatId) as { language: string | null } | undefined;
    if (!row) return 'en';
    if (row.language === 'vi' || row.language === 'en') return row.language;
    return 'en';
  }

  /**
   * Idempotent upsert for the chat's UI language. Used by the language
   * picker callback (`lang:set:*`) and the `/language` command. Inserts a
   * full chat_settings row on first call (with `default_mode='summary'`),
   * UPDATEs the language column on subsequent calls.
   */
  setChatLanguage(chatId: number, language: 'en' | 'vi'): void {
    this.db
      .prepare(
        `INSERT INTO chat_settings (chat_id, default_mode, language) VALUES (?, 'summary', ?)
         ON CONFLICT(chat_id) DO UPDATE SET language = excluded.language`,
      )
      .run(chatId, language);
  }

  // ---------- Cost tracking (v1.2 D3) ----------
  logCost(sessionId: string, chatId: number, agent: string, inputTokens: number, outputTokens: number, costUsd: number): void {
    this.db
      .prepare(
        `INSERT INTO cost_log (session_id,chat_id,agent,input_tokens,output_tokens,cost_usd,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(sessionId, chatId, agent, inputTokens, outputTokens, costUsd, Date.now());
  }

  getCostBySession(sessionId: string): { total_cost: number; input_tokens: number; output_tokens: number } {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd),0) AS total_cost, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens FROM cost_log WHERE session_id = ?`)
      .get(sessionId) as { total_cost: number; input_tokens: number; output_tokens: number };
    return row;
  }

  getCostByChat(chatId: number, sinceDaysAgo?: number): { total_cost: number; input_tokens: number; output_tokens: number } {
    const cutoff = sinceDaysAgo != null ? Date.now() - sinceDaysAgo * 86_400_000 : 0;
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd),0) AS total_cost, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens FROM cost_log WHERE chat_id = ? AND created_at >= ?`)
      .get(chatId, cutoff) as { total_cost: number; input_tokens: number; output_tokens: number };
    return row;
  }

  getCostBreakdown(chatId: number, sinceDaysAgo?: number): { agent: string; total_cost: number; input_tokens: number; output_tokens: number }[] {
    const cutoff = sinceDaysAgo != null ? Date.now() - sinceDaysAgo * 86_400_000 : 0;
    return this.db
      .prepare(`SELECT agent, COALESCE(SUM(cost_usd),0) AS total_cost, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens FROM cost_log WHERE chat_id = ? AND created_at >= ? GROUP BY agent`)
      .all(chatId, cutoff) as { agent: string; total_cost: number; input_tokens: number; output_tokens: number }[];
  }

  // ---------- Templates (v1.2 D4) ----------
  saveTemplate(chatId: number, name: string, agent: string, prompt: string, projectId?: number | null): void {
    this.db
      .prepare(
        `INSERT INTO templates (chat_id,name,agent,prompt,project_id,created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(chat_id,name) DO UPDATE SET agent=excluded.agent, prompt=excluded.prompt, project_id=excluded.project_id, created_at=excluded.created_at`,
      )
      .run(chatId, name, agent, prompt, projectId ?? null, Date.now());
  }

  listTemplates(chatId: number): { id: number; name: string; agent: string; prompt: string; project_id: number | null; created_at: number }[] {
    return this.db
      .prepare(`SELECT id, name, agent, prompt, project_id, created_at FROM templates WHERE chat_id = ? ORDER BY name`)
      .all(chatId) as { id: number; name: string; agent: string; prompt: string; project_id: number | null; created_at: number }[];
  }

  getTemplate(chatId: number, name: string): { id: number; name: string; agent: string; prompt: string; project_id: number | null; created_at: number } | undefined {
    return this.db
      .prepare(`SELECT id, name, agent, prompt, project_id, created_at FROM templates WHERE chat_id = ? AND name = ?`)
      .get(chatId, name) as { id: number; name: string; agent: string; prompt: string; project_id: number | null; created_at: number } | undefined;
  }

  deleteTemplate(chatId: number, name: string): boolean {
    const res = this.db.prepare(`DELETE FROM templates WHERE chat_id = ? AND name = ?`).run(chatId, name);
    return res.changes > 0;
  }

  // ---------- Schedules (v1.2 D5) ----------
  createSchedule(chatId: number, name: string, cron: string, agent: string, prompt: string, projectId?: number | null): void {
    this.db
      .prepare(
        `INSERT INTO schedules (chat_id,name,cron,agent,prompt,project_id,enabled,created_at)
         VALUES (?,?,?,?,?,?,1,?)`,
      )
      .run(chatId, name, cron, agent, prompt, projectId ?? null, Date.now());
  }

  listSchedules(chatId: number): { id: number; name: string; cron: string; agent: string; prompt: string; project_id: number | null; enabled: number; last_run_at: number | null; created_at: number }[] {
    return this.db
      .prepare(`SELECT id, name, cron, agent, prompt, project_id, enabled, last_run_at, created_at FROM schedules WHERE chat_id = ? ORDER BY name`)
      .all(chatId) as { id: number; name: string; cron: string; agent: string; prompt: string; project_id: number | null; enabled: number; last_run_at: number | null; created_at: number }[];
  }

  getSchedule(chatId: number, name: string): { id: number; chat_id: number; name: string; cron: string; agent: string; prompt: string; project_id: number | null; enabled: number; last_run_at: number | null; created_at: number } | undefined {
    return this.db
      .prepare(`SELECT * FROM schedules WHERE chat_id = ? AND name = ?`)
      .get(chatId, name) as { id: number; chat_id: number; name: string; cron: string; agent: string; prompt: string; project_id: number | null; enabled: number; last_run_at: number | null; created_at: number } | undefined;
  }

  deleteSchedule(chatId: number, name: string): boolean {
    const res = this.db.prepare(`DELETE FROM schedules WHERE chat_id = ? AND name = ?`).run(chatId, name);
    return res.changes > 0;
  }

  toggleSchedule(chatId: number, name: string, enabled: boolean): void {
    this.db.prepare(`UPDATE schedules SET enabled = ? WHERE chat_id = ? AND name = ?`).run(enabled ? 1 : 0, chatId, name);
  }

  updateScheduleLastRun(id: number): void {
    this.db.prepare(`UPDATE schedules SET last_run_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  getEnabledSchedules(): { id: number; chat_id: number; name: string; cron: string; agent: string; prompt: string; project_id: number | null; enabled: number; last_run_at: number | null; created_at: number }[] {
    return this.db
      .prepare(`SELECT * FROM schedules WHERE enabled = 1`)
      .all() as { id: number; chat_id: number; name: string; cron: string; agent: string; prompt: string; project_id: number | null; enabled: number; last_run_at: number | null; created_at: number }[];
  }

  // ---------- Quiet Hours (v1.2 D2) ----------
  setQuietHours(chatId: number, startMinute: number, endMinute: number, tz = 'Asia/Ho_Chi_Minh'): void {
    this.db
      .prepare(
        `INSERT INTO chat_settings (chat_id, default_mode, quiet_start, quiet_end, quiet_tz)
         VALUES (?, 'summary', ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, quiet_tz = excluded.quiet_tz`,
      )
      .run(chatId, startMinute, endMinute, tz);
  }

  clearQuietHours(chatId: number): void {
    const row = this.db.prepare(`SELECT 1 FROM chat_settings WHERE chat_id = ?`).get(chatId);
    if (row) {
      this.db.prepare(`UPDATE chat_settings SET quiet_start = NULL, quiet_end = NULL, quiet_tz = NULL WHERE chat_id = ?`).run(chatId);
    }
  }

  getQuietHours(chatId: number): { start: number; end: number; tz: string } | null {
    const row = this.db
      .prepare(`SELECT quiet_start, quiet_end, quiet_tz FROM chat_settings WHERE chat_id = ?`)
      .get(chatId) as { quiet_start: number | null; quiet_end: number | null; quiet_tz: string | null } | undefined;
    if (!row || row.quiet_start == null || row.quiet_end == null) return null;
    return { start: row.quiet_start, end: row.quiet_end, tz: row.quiet_tz ?? 'Asia/Ho_Chi_Minh' };
  }

  isQuietNow(chatId: number): boolean {
    const qh = this.getQuietHours(chatId);
    if (!qh) return false;
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: qh.tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
    const minute = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
    const currentMinute = hour * 60 + minute;

    if (qh.start <= qh.end) {
      return currentMinute >= qh.start && currentMinute < qh.end;
    }
    // Overnight range (e.g. 22:00-08:00)
    return currentMinute >= qh.start || currentMinute < qh.end;
  }

  // ---------- Session search (v1.2 D6) ----------
  updateSearchIndex(sessionId: string, label: string, transcript: string): void {
    this.db.prepare(`DELETE FROM session_fts WHERE session_id = ?`).run(sessionId);
    this.db.prepare(`INSERT INTO session_fts(session_id, label, transcript) VALUES (?, ?, ?)`).run(sessionId, label, transcript);
  }

  searchSessions(chatId: number, query: string, limit = 5): Array<{ sessionId: string; label: string; snippet: string; rank: number }> {
    return this.db.prepare(
      `SELECT f.session_id AS sessionId, f.label, snippet(session_fts, 2, '»', '«', '…', 30) AS snippet, f.rank
       FROM session_fts f
       JOIN sessions s ON s.id = f.session_id
       WHERE session_fts MATCH ? AND s.chat_id = ?
       ORDER BY f.rank
       LIMIT ?`,
    ).all(query, chatId, limit) as Array<{ sessionId: string; label: string; snippet: string; rank: number }>;
  }

  getRecentSessions(chatId: number, days: number): SessionRow[] {
    const cutoff = Date.now() - days * 86_400_000;
    return this.db.prepare(
      `SELECT * FROM sessions WHERE chat_id = ? AND created_at >= ? ORDER BY created_at DESC`,
    ).all(chatId, cutoff) as SessionRow[];
  }

  close(): void {
    this.db.close();
  }
}
