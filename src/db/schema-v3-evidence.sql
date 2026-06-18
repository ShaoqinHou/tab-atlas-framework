PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS resource_extraction_state (
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  recipe_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  dependency_hash TEXT NOT NULL,
  artifact_id TEXT REFERENCES extraction_artifacts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  retry_after TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, recipe_id, adapter_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_extraction_state_status
  ON resource_extraction_state(recipe_id, adapter_id, status, updated_at);

CREATE TABLE IF NOT EXISTS membership_feedback_context (
  feedback_id TEXT PRIMARY KEY REFERENCES membership_feedback(id) ON DELETE CASCADE,
  scope_mode TEXT NOT NULL DEFAULT 'intent',
  source_view_id TEXT REFERENCES views(id) ON DELETE SET NULL,
  source_revision_id TEXT REFERENCES view_revisions(id) ON DELETE SET NULL,
  source_command_text TEXT NOT NULL DEFAULT '',
  source_goal TEXT NOT NULL DEFAULT '',
  source_rules_json TEXT NOT NULL DEFAULT '[]',
  intent_terms_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_context_view
  ON membership_feedback_context(source_view_id, source_revision_id);

CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  context_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread
  ON conversation_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES conversation_messages(id) ON DELETE SET NULL,
  action_kind TEXT NOT NULL,
  approval TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  idempotency_key TEXT NOT NULL DEFAULT '',
  execution_token TEXT,
  execution_started_at TEXT,
  action_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_thread_status
  ON agent_actions(thread_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_actions_idempotency_key
  ON agent_actions(idempotency_key)
  WHERE idempotency_key <> '';
