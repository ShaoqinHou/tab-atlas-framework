PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  redacted_url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  url_kind TEXT NOT NULL,
  host TEXT NOT NULL,
  title_best TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS tab_observations (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  browser TEXT NOT NULL,
  window_id TEXT,
  tab_id TEXT,
  tab_index INTEGER,
  active INTEGER,
  pinned INTEGER,
  group_id TEXT,
  group_title TEXT,
  group_color TEXT,
  title TEXT,
  url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extraction_artifacts (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  recipe_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  text_excerpt TEXT,
  json_payload TEXT,
  source_url TEXT,
  provenance TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'complete',
  error_code TEXT,
  extracted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS atomic_items (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT,
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_by TEXT NOT NULL DEFAULT 'codex',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_annotations (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('resource', 'atomic_item')),
  target_id TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  decision TEXT NOT NULL DEFAULT 'none',
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_annotations_target ON user_annotations(target_kind, target_id);

CREATE TABLE IF NOT EXISTS user_commands (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  parsed_intent_json TEXT,
  plan_json TEXT,
  status TEXT NOT NULL DEFAULT 'proposed'
);

CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  query_json TEXT,
  origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_view_specs (
  id TEXT PRIMARY KEY,
  view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  command_id TEXT REFERENCES user_commands(id) ON DELETE SET NULL,
  goal TEXT NOT NULL,
  inclusion_rules_json TEXT NOT NULL DEFAULT '[]',
  exclusion_rules_json TEXT NOT NULL DEFAULT '[]',
  section_rules_json TEXT NOT NULL DEFAULT '[]',
  sort_policy TEXT,
  created_by_agent_run_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  view_id TEXT REFERENCES views(id) ON DELETE CASCADE,
  tag_name TEXT,
  state TEXT NOT NULL DEFAULT 'strong_include',
  section TEXT,
  confidence REAL NOT NULL,
  reason TEXT,
  conflict_note TEXT,
  evidence_refs TEXT NOT NULL,
  accepted_by_user INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memberships_view ON memberships(view_id);
CREATE INDEX IF NOT EXISTS idx_memberships_target ON memberships(target_kind, target_id);

CREATE TABLE IF NOT EXISTS review_queue_items (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  queue_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0,
  position INTEGER,
  last_presented_at TEXT,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_queue ON review_queue_items(queue_name, status, priority DESC, position ASC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  schema_id TEXT,
  validation_status TEXT NOT NULL,
  usage_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS resource_fts USING fts5(
  resource_id UNINDEXED,
  title,
  url,
  user_text,
  extracted_text
);
