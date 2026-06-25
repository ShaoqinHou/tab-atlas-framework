import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import {
  assertProfileDatabaseCompatibility,
  DatabaseEnvironment,
  type RuntimeProfile,
} from './contracts.js';

export interface DatabaseIdentity {
  databaseId: string;
  environment: DatabaseEnvironment;
  sourceDatabaseId?: string;
  createdAt: string;
  updatedAt: string;
}

export function readDatabaseIdentity(databasePath: string): DatabaseIdentity | null {
  if (databasePath === ':memory:' || !fs.existsSync(databasePath)) return null;
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const hasTable = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'database_identity'
    `).get();
    if (!hasTable) return null;
    return getIdentityFromOpenDatabase(db);
  } finally {
    db.close();
  }
}

export function getIdentityFromOpenDatabase(db: Database.Database): DatabaseIdentity | null {
  const rows = db.prepare(`
    SELECT database_id, environment, source_database_id, created_at, updated_at
    FROM database_identity
    ORDER BY created_at
    LIMIT 2
  `).all() as Array<{
    database_id: string;
    environment: string;
    source_database_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
  if (rows.length > 1) {
    throw new Error(`Database has ${rows.length} runtime identities. Explicit remediation is required before TabAtlas can open it.`);
  }
  const row = rows[0];
  if (!row) return null;
  return {
    databaseId: row.database_id,
    environment: DatabaseEnvironment.parse(row.environment),
    sourceDatabaseId: row.source_database_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensureDatabaseIdentity(
  db: Database.Database,
  input: {
    runtimeProfile: RuntimeProfile;
    environment: DatabaseEnvironment;
    sourceDatabaseId?: string;
    allowInitialize: boolean;
  },
): DatabaseIdentity {
  const tx = db.transaction((): DatabaseIdentity => {
    const existing = getIdentityFromOpenDatabase(db);
    if (existing) {
      assertProfileDatabaseCompatibility(input.runtimeProfile, existing.environment);
      return existing;
    }
    if (!input.allowInitialize) {
      throw new Error('Database has no runtime identity. Initialize it with an explicit runtime command before starting TabAtlas.');
    }
    assertProfileDatabaseCompatibility(input.runtimeProfile, input.environment);
    const now = new Date().toISOString();
    const identity: DatabaseIdentity = {
      databaseId: `db_${nanoid()}_${crypto.randomBytes(4).toString('hex')}`,
      environment: input.environment,
      sourceDatabaseId: input.sourceDatabaseId,
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(`
      INSERT INTO database_identity (database_id, environment, source_database_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(identity.databaseId, identity.environment, identity.sourceDatabaseId ?? null, identity.createdAt, identity.updatedAt);
    return identity;
  });
  return tx();
}

export function runtimeProfileDefaultEnvironment(profile: RuntimeProfile): DatabaseEnvironment {
  switch (profile) {
    case 'production':
      return 'production';
    case 'roleplay':
      return 'clone';
    case 'acceptance':
      return 'acceptance';
    case 'development':
      return 'development';
    case 'test':
      return 'test';
    default:
      throw new Error(`Unhandled runtime profile ${String(profile)}`);
  }
}
