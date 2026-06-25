PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS database_identity (
  database_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('production', 'clone', 'acceptance', 'development', 'test')),
  source_database_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_incidents (
  id TEXT PRIMARY KEY,
  incident_type TEXT NOT NULL,
  database_id TEXT,
  bootstrap_id TEXT,
  report_path TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  remediated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_incidents_status
  ON runtime_incidents(status, created_at);

CREATE TABLE IF NOT EXISTS agent_action_recovery_events (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES agent_actions(id) ON DELETE CASCADE,
  prior_status TEXT NOT NULL,
  recovered_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_action_recovery_events_action
  ON agent_action_recovery_events(action_id, created_at);
