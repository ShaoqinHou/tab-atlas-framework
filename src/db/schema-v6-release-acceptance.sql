PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS manual_browser_acceptance_sessions (
  id TEXT PRIMARY KEY,
  browser TEXT NOT NULL CHECK (browser IN ('chrome', 'edge')),
  status TEXT NOT NULL DEFAULT 'created',
  receiver_url TEXT NOT NULL,
  challenge_id TEXT REFERENCES pairing_challenges(id) ON DELETE SET NULL,
  capability_id TEXT REFERENCES local_capabilities(id) ON DELETE SET NULL,
  baseline_snapshot_count INTEGER NOT NULL DEFAULT 0,
  paired_at TEXT,
  snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
  snapshot_observed_at TEXT,
  revoked_at TEXT,
  revocation_observed_at TEXT,
  denial_audit_id TEXT REFERENCES security_audit_events(id) ON DELETE SET NULL,
  popup_opened_confirmed_at TEXT,
  token_absent_verified_at TEXT,
  failure_code TEXT,
  failure_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_browser_acceptance_status
  ON manual_browser_acceptance_sessions(browser, status, created_at DESC);

CREATE TABLE IF NOT EXISTS hierarchical_planning_runs (
  id TEXT PRIMARY KEY,
  command_text_hash TEXT NOT NULL,
  retrieval_run_id TEXT REFERENCES retrieval_runs(id) ON DELETE SET NULL,
  provider_role TEXT,
  provider_scope_key TEXT,
  provider_thread_id TEXT,
  model TEXT,
  reasoning_effort TEXT,
  redaction_version TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  target_count INTEGER NOT NULL DEFAULT 0,
  chunk_size INTEGER NOT NULL,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  failed_chunks INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_hierarchical_planning_runs_status
  ON hierarchical_planning_runs(status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hierarchical_planning_runs_fingerprint
  ON hierarchical_planning_runs(evidence_fingerprint, provider_scope_key, model, reasoning_effort);

CREATE TABLE IF NOT EXISTS hierarchical_planning_chunks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES hierarchical_planning_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  target_ids_json TEXT NOT NULL,
  result_json TEXT,
  usage_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  split_parent_id TEXT REFERENCES hierarchical_planning_chunks(id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(run_id, ordinal, evidence_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_hierarchical_planning_chunks_next
  ON hierarchical_planning_chunks(run_id, status, ordinal);

CREATE TABLE IF NOT EXISTS release_acceptance_runs (
  id TEXT PRIMARY KEY,
  git_sha TEXT NOT NULL,
  report_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  blocker_count INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_release_acceptance_runs_status
  ON release_acceptance_runs(status, created_at DESC);
