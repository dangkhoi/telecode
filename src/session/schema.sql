-- Telecode SQLite schema (WAL mode, run pragma at open time).
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,            -- uuid
  label           TEXT NOT NULL,
  agent           TEXT NOT NULL,               -- 'claude' | 'kiro'
  project_id      INTEGER REFERENCES projects(id),
  chat_id         INTEGER NOT NULL,
  sdk_session_id  TEXT,                        -- claude resume id
  status          TEXT NOT NULL DEFAULT 'idle',-- idle|running|waiting_approval|interrupted|closed
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_message    TEXT,
  transcript_tail TEXT DEFAULT '',             -- newline-joined preview
  handoff_context TEXT,                         -- /handoff summary; injected once into next prompt then cleared
  -- Phase B: per-session verbosity override (null = fall back to chat default
  -- and then the baked-in 'summary'). Stored as TEXT to avoid coupling the
  -- DB schema to the TS enum file.
  verbosity_mode  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_chat_label
  ON sessions(chat_id, label) WHERE status != 'closed';
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS tool_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  input_preview TEXT,
  decision    TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_log_session ON tool_log(session_id, id);

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,                -- request id
  session_id  TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  input_json  TEXT NOT NULL,
  decision    TEXT,                            -- allow_once|allow_always|deny|timeout
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS chat_state (
  chat_id           INTEGER PRIMARY KEY,
  active_session_id TEXT,
  active_project_id INTEGER
);

-- Phase B (plan §B.2) — per-chat verbosity defaults + v1.1 migration-message
-- bookkeeping. Default 'summary' matches the on-the-go persona that's the
-- majority of v1.1 use; users opt back into firehose via `/settings mode verbose`.
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id       INTEGER PRIMARY KEY,
  default_mode  TEXT NOT NULL DEFAULT 'summary',
  quiet_start   INTEGER,  -- minute-of-day (0-1439) when quiet hours begin, NULL = disabled
  quiet_end     INTEGER,  -- minute-of-day (0-1439) when quiet hours end
  quiet_tz      TEXT      -- IANA timezone string, default 'Asia/Ho_Chi_Minh'
);

-- Persisted state for the @grammyjs/conversations plugin (v0.7 wizards).
-- key is plugin-generated (e.g. "conversation-<chatId>"); data is JSON-encoded
-- VersionedState. Updated_at is a Date.now() ms timestamp for debugging/janitor.
CREATE TABLE IF NOT EXISTS conversation_state (
  key        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- v1.2 D3: Cost tracking per session
CREATE TABLE IF NOT EXISTS cost_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  chat_id     INTEGER NOT NULL,
  agent       TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_log_session ON cost_log(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_log_chat ON cost_log(chat_id);

-- v1.2 D4: Session templates
CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  agent       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  project_id  INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE(chat_id, name)
);

-- v1.2 D5: Scheduled tasks
CREATE TABLE IF NOT EXISTS schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  cron        TEXT NOT NULL,
  agent       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  project_id  INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE(chat_id, name)
);

-- v1.2 D6: Full-text search on session transcripts
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
  session_id UNINDEXED,
  label,
  transcript,
  tokenize='unicode61'
);