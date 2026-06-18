PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS local_capabilities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_capabilities_status
  ON local_capabilities(status, kind, created_at);

CREATE TABLE IF NOT EXISTS local_pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  capability_id TEXT REFERENCES local_capabilities(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_local_pairing_codes_expiry
  ON local_pairing_codes(expires_at, used_at);

CREATE TABLE IF NOT EXISTS security_audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  method TEXT,
  route TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  capability_id TEXT REFERENCES local_capabilities(id) ON DELETE SET NULL,
  host TEXT,
  origin TEXT,
  remote_address TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_audit_created
  ON security_audit_events(created_at, event_type, outcome);

CREATE TABLE IF NOT EXISTS codex_provider_threads (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  thread_id TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(role, scope_key, generation)
);

CREATE INDEX IF NOT EXISTS idx_codex_provider_threads_scope
  ON codex_provider_threads(role, scope_key, generation);

CREATE TABLE IF NOT EXISTS codex_prompt_manifests (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  provider_role TEXT,
  provider_scope_key TEXT,
  redaction_version TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codex_prompt_manifests_created
  ON codex_prompt_manifests(created_at, purpose);
