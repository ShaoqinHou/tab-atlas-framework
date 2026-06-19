PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS resource_knowledge_state (
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  recipe_id TEXT NOT NULL,
  dependency_hash TEXT NOT NULL,
  artifact_id TEXT REFERENCES extraction_artifacts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'fresh',
  generation INTEGER NOT NULL DEFAULT 1,
  last_scanned_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, recipe_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_knowledge_state_status
  ON resource_knowledge_state(recipe_id, status, updated_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  requested_by TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (job_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_job_items_claim ON job_items(job_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_job_items_resource ON job_items(resource_id, status);

CREATE TABLE IF NOT EXISTS view_revisions (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL,
  view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES view_revisions(id) ON DELETE SET NULL,
  command_id TEXT REFERENCES user_commands(id) ON DELETE SET NULL,
  revision_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (lineage_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_view_revisions_view
  ON view_revisions(view_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_view_revisions_lineage
  ON view_revisions(lineage_id, revision_number DESC);

CREATE TABLE IF NOT EXISTS membership_feedback (
  id TEXT PRIMARY KEY,
  view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  membership_id TEXT REFERENCES memberships(id) ON DELETE SET NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  correction_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_membership_feedback_target
  ON membership_feedback(target_kind, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_membership_feedback_view
  ON membership_feedback(view_id, created_at DESC);

CREATE TABLE IF NOT EXISTS membership_feedback_undo (
  feedback_id TEXT PRIMARY KEY REFERENCES membership_feedback(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  previous_state TEXT NOT NULL,
  previous_section TEXT,
  previous_reason TEXT,
  previous_conflict_note TEXT,
  previous_accepted_by_user INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_membership_feedback_undo_membership
  ON membership_feedback_undo(membership_id, created_at DESC);
