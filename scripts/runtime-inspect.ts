import fs from 'node:fs';
import crypto from 'node:crypto';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { readDatabaseIdentity } from '../src/runtime/databaseIdentity.js';
import { readDatabaseLease } from '../src/runtime/databaseLease.js';

const program = new Command();
program.requiredOption('--database <path>', 'SQLite database path');
program.parse(process.argv);

const opts = program.opts<{ database: string }>();
const db = new Database(opts.database, { readonly: true, fileMustExist: true });
try {
  const identity = readDatabaseIdentity(opts.database);
  const lease = readDatabaseLease(opts.database);
  const bootstrapRows = tableExists(db, 'onboarding_bootstrap_secrets')
    ? db.prepare(`
        SELECT id, status, created_at AS createdAt, expires_at AS expiresAt, file_path AS filePath, consumed_at AS consumedAt
        FROM onboarding_bootstrap_secrets
        ORDER BY created_at DESC
      `).all().map(redactBootstrapRow)
    : [];
  const activeAdminCapabilities = tableExists(db, 'local_capabilities')
    ? (db.prepare(`
        SELECT COUNT(*) AS count
        FROM local_capabilities
        WHERE status = 'active' AND scopes_json LIKE '%admin%'
      `).get() as { count: number }).count
    : 0;
  const activeDashboardSessions = tableExists(db, 'local_sessions')
    ? (db.prepare(`
        SELECT COUNT(*) AS count
        FROM local_sessions
        WHERE revoked_at IS NULL AND expires_at > ?
      `).get(new Date().toISOString()) as { count: number }).count
    : 0;
  console.log(JSON.stringify({
    database: redactPath(opts.database),
    identity,
    lease,
    bootstrapRows,
    activeAdminCapabilities,
    activeDashboardSessions,
    integrity: db.pragma('integrity_check', { simple: true }),
  }, null, 2));
} finally {
  db.close();
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function redactBootstrapRow(row: unknown): Record<string, unknown> {
  const item = row as { filePath?: string | null };
  return {
    ...(row as Record<string, unknown>),
    filePath: item.filePath ? redactPath(item.filePath) : null,
    fileExists: item.filePath ? fs.existsSync(item.filePath) : false,
  };
}

function redactPath(value: string): { file?: string; sha256: string } {
  return {
    file: value.split(/[\\/]/).pop(),
    sha256: crypto.createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 16),
  };
}
