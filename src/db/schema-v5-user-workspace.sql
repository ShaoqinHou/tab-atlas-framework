PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pairing_challenges (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'extension',
  browser TEXT NOT NULL DEFAULT 'unknown',
  label TEXT,
  scopes_json TEXT NOT NULL DEFAULT '["snapshot:write"]',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  locked_at TEXT,
  capability_id TEXT REFERENCES local_capabilities(id) ON DELETE SET NULL,
  last_attempt_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_pairing_challenges_status
  ON pairing_challenges(status, expires_at, created_at);

CREATE TABLE IF NOT EXISTS pairing_exchange_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS onboarding_state (
  step_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  data_json TEXT NOT NULL DEFAULT '{}',
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_bootstrap_secrets (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  file_path TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS local_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'dashboard',
  scopes_json TEXT NOT NULL DEFAULT '["api:read"]',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_sessions_expiry
  ON local_sessions(kind, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS action_effects (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  stale_after TEXT
);

CREATE INDEX IF NOT EXISTS idx_action_effects_action
  ON action_effects(action_id, effect_kind, status);

CREATE TABLE IF NOT EXISTS retrieval_runs (
  id TEXT PRIMARY KEY,
  command_text TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'heuristic',
  plan_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  source_coverage_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_runs_created
  ON retrieval_runs(created_at);

CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  session_type TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  command_text TEXT,
  filters_json TEXT NOT NULL DEFAULT '{}',
  current_index INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paused_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS review_session_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_json TEXT,
  decided_at TEXT,
  UNIQUE(session_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_review_session_items_progress
  ON review_session_items(session_id, status, position);
