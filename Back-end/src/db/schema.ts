export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  auth_provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(auth_provider, external_id)
);

CREATE TABLE IF NOT EXISTS preferences (
  user_id TEXT PRIMARY KEY,
  focus_duration_min INTEGER NOT NULL DEFAULT 25,
  short_break_min INTEGER NOT NULL DEFAULT 5,
  long_break_min INTEGER NOT NULL DEFAULT 20,
  cycles_before_long_break INTEGER NOT NULL DEFAULT 4,
  volume_focus REAL NOT NULL DEFAULT 0.7,
  volume_break REAL NOT NULL DEFAULT 0.3,
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  theme TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  current_index INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  accumulated_pause_ms INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER,
  ended_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON sessions(user_id, status);

CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cycle_index INTEGER NOT NULL,
  phase_type TEXT NOT NULL,
  planned_duration_ms INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  completed_at INTEGER,
  skipped INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cycles_session ON cycles(session_id, cycle_index);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  user_priority TEXT NOT NULL DEFAULT 'LOW',
  ai_priority TEXT,
  effective_priority TEXT NOT NULL DEFAULT 'LOW',
  priority_score REAL NOT NULL DEFAULT 0,
  priority_reason TEXT,
  priority_computed_at INTEGER,
  priority_dismissed_until INTEGER,
  priority_dismiss_count INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_completed ON tasks(user_id, completed);
CREATE INDEX IF NOT EXISTS idx_tasks_user_priority ON tasks(user_id, effective_priority, priority_score DESC);

CREATE TABLE IF NOT EXISTS daily_stats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  sessions_completed INTEGER NOT NULL DEFAULT 0,
  focus_ms INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  primordial_completed INTEGER NOT NULL DEFAULT 0,
  primordial_ignored INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  client_timestamp INTEGER,
  server_timestamp INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_logs_user_time ON event_logs(user_id, server_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_event_logs_entity ON event_logs(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS search_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  query TEXT NOT NULL,
  results_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_search_history_user_time ON search_history(user_id, created_at DESC);
`;
