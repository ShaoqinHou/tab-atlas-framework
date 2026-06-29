import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { getIdentityFromOpenDatabase, type DatabaseIdentity } from './databaseIdentity.js';

export interface DatabaseFingerprint {
  databaseId?: string;
  environment?: string;
  sourceDatabaseId?: string;
  files: Record<'main' | 'wal' | 'shm', { exists: boolean; sha256?: string; size?: number }>;
  integrity: string;
  counts: {
    snapshots: number;
    resources: number;
    userAnnotations: number;
    views: number;
    conversations: number;
    actions: number;
    activeCapabilities: number;
    activeDashboardSessions: number;
    bootstrapRows: number;
    runtimeIncidents: number;
  };
  maxUpdatedAt: Record<string, string | null>;
}

export function fingerprintDatabase(databasePath: string): DatabaseFingerprint {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const identity = getIdentityFromOpenDatabase(db);
    return fingerprintOpenDatabase(db, databasePath, identity);
  } finally {
    db.close();
  }
}

export function fingerprintOpenDatabase(
  db: Database.Database,
  databasePath: string,
  identity: DatabaseIdentity | null = getIdentityFromOpenDatabase(db),
): DatabaseFingerprint {
  return {
    databaseId: identity?.databaseId,
    environment: identity?.environment,
    sourceDatabaseId: identity?.sourceDatabaseId,
    files: {
      main: fileFingerprint(databasePath),
      wal: fileFingerprint(`${databasePath}-wal`),
      shm: fileFingerprint(`${databasePath}-shm`),
    },
    integrity: String(db.pragma('integrity_check', { simple: true })),
    counts: {
      snapshots: count(db, 'snapshots'),
      resources: count(db, 'resources'),
      userAnnotations: count(db, 'user_annotations'),
      views: count(db, 'views'),
      conversations: count(db, 'conversation_threads'),
      actions: count(db, 'agent_actions'),
      activeCapabilities: countWhere(db, 'local_capabilities', "status = 'active'"),
      activeDashboardSessions: countWhere(db, 'local_sessions', "revoked_at IS NULL AND expires_at > datetime('now')"),
      bootstrapRows: count(db, 'onboarding_bootstrap_secrets'),
      runtimeIncidents: count(db, 'runtime_incidents'),
    },
    maxUpdatedAt: {
      snapshots: maxColumn(db, 'snapshots', 'captured_at'),
      resources: maxColumn(db, 'resources', 'last_seen_at'),
      userAnnotations: maxColumn(db, 'user_annotations', 'updated_at'),
      views: maxColumn(db, 'views', 'created_at'),
      conversations: maxColumn(db, 'conversation_threads', 'updated_at'),
      actions: maxColumn(db, 'agent_actions', 'updated_at'),
      capabilities: maxColumn(db, 'local_capabilities', 'created_at'),
      sessions: maxColumn(db, 'local_sessions', 'last_used_at'),
      bootstrapRows: maxColumn(db, 'onboarding_bootstrap_secrets', 'created_at'),
      runtimeIncidents: maxColumn(db, 'runtime_incidents', 'created_at'),
    },
  };
}

export function sameDatabaseFingerprint(left: DatabaseFingerprint, right: DatabaseFingerprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function redactDatabaseFingerprint(fingerprint: DatabaseFingerprint): DatabaseFingerprint {
  return fingerprint;
}

function fileFingerprint(filePath: string): { exists: boolean; sha256?: string; size?: number } {
  if (!fs.existsSync(filePath)) return { exists: false };
  const data = fs.readFileSync(filePath);
  return {
    exists: true,
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
}

function count(db: Database.Database, table: string): number {
  if (!tableExists(db, table)) return 0;
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function countWhere(db: Database.Database, table: string, where: string): number {
  if (!tableExists(db, table)) return 0;
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
}

function maxColumn(db: Database.Database, table: string, column: string): string | null {
  if (!tableExists(db, table) || !columnExists(db, table, column)) return null;
  const row = db.prepare(`SELECT MAX(${column}) AS value FROM ${table}`).get() as { value: string | null };
  return row.value ?? null;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table));
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some(row => row.name === column);
}

export function redactDatabasePath(databasePath: string): { file: string; pathHash: string } {
  return {
    file: path.basename(databasePath),
    pathHash: crypto.createHash('sha256').update(path.resolve(databasePath).toLowerCase()).digest('hex').slice(0, 16),
  };
}
