import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(filePath = path.join(process.cwd(), 'data', 'tabatlas.sqlite')) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  const schemas = [
    new URL('./schema.sql', import.meta.url),
    new URL('./schema-v2-durable.sql', import.meta.url),
    new URL('./schema-v3-evidence.sql', import.meta.url),
    new URL('./schema-v4-local-trust.sql', import.meta.url),
  ];
  for (const schemaPath of schemas) {
    db.exec(fs.readFileSync(schemaPath, 'utf8'));
  }
  runLightweightMigrations(db);
  return db;
}

function runLightweightMigrations(db: Database.Database): void {
  ensureColumn(db, 'agent_actions', 'idempotency_key', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'agent_actions', 'execution_token', 'TEXT');
  ensureColumn(db, 'agent_actions', 'execution_started_at', 'TEXT');
  ensureColumn(db, 'agent_actions', 'model_action_key', 'TEXT');
  ensureColumn(db, 'agent_actions', 'action_ordinal', 'INTEGER');
  db.exec(`
    UPDATE agent_actions
    SET idempotency_key = id
    WHERE idempotency_key = ''
  `);
  db.exec(`
    UPDATE agent_actions
    SET model_action_key = id
    WHERE model_action_key IS NULL
  `);
  db.exec(`
    UPDATE agent_actions
    SET action_ordinal = 0
    WHERE action_ordinal IS NULL
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_actions_idempotency_key
      ON agent_actions(idempotency_key)
      WHERE idempotency_key <> ''
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_actions_model_key
      ON agent_actions(thread_id, message_id, model_action_key)
  `);
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some(row => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
