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
  transcript_tail TEXT DEFAULT ''              -- newline-joined preview
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
