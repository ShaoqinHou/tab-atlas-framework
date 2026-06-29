import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { openDatabase } from '../src/db/index.js';
import { ensureDatabaseIdentity, getIdentityFromOpenDatabase } from '../src/runtime/databaseIdentity.js';
import { fingerprintOpenDatabase } from '../src/runtime/databaseFingerprint.js';
import { verifyRemediationBackup } from '../src/runtime/remediationBackup.js';

const program = new Command();
program.requiredOption('--database <path>', 'SQLite database path');
program.requiredOption('--bootstrap-id <id>', 'Bootstrap row id to remediate');
program.requiredOption('--incident-report <path>', 'Redacted incident report path');
program.option('--backup <path>', 'Recent backup path required for --apply');
program.option('--dry-run', 'Report actions without modifying the database');
program.option('--apply', 'Apply remediation');
program.parse(process.argv);

const opts = program.opts<{
  database: string;
  bootstrapId: string;
  incidentReport: string;
  backup?: string;
  dryRun?: boolean;
  apply?: boolean;
}>();
if (Boolean(opts.dryRun) === Boolean(opts.apply)) throw new Error('Specify exactly one of --dry-run or --apply.');

const remediationStartedAt = new Date();
const db = opts.apply ? openDatabase(opts.database) : new Database(opts.database, { readonly: true, fileMustExist: true });
try {
  const row = db.prepare(`
    SELECT id, status, file_path, consumed_at, created_at, expires_at
    FROM onboarding_bootstrap_secrets
    WHERE id = ?
  `).get(opts.bootstrapId) as {
    id: string;
    status: string;
    file_path: string | null;
    consumed_at: string | null;
    created_at: string;
    expires_at: string;
  } | undefined;
  if (!row) throw new Error(`Bootstrap row not found: ${opts.bootstrapId}`);
  const fileExists = row.file_path ? fs.existsSync(row.file_path) : false;
  const activeAuthority = (db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM local_capabilities WHERE status = 'active' AND created_at >= ?) AS capabilities,
      (SELECT COUNT(*) FROM local_sessions WHERE revoked_at IS NULL AND created_at >= ?) AS sessions
  `).get(row.created_at, row.created_at) as { capabilities: number; sessions: number });
  const existingIdentity = getIdentityFromOpenDatabase(db);
  const currentFingerprint = fingerprintOpenDatabase(db, opts.database, existingIdentity);
  const backup = opts.backup
    ? verifyRemediationBackup({
        backupPath: opts.backup,
        databasePath: opts.database,
        currentFingerprint,
        remediationStartedAt,
      })
    : null;
  const remediation = {
    bootstrapId: row.id,
    currentStatus: row.status,
    consumed: Boolean(row.consumed_at),
    fileExists,
    activeAuthority,
    backup,
    action: row.status === 'active' ? 'mark_orphaned' : 'record_only',
  };
  if (opts.apply) {
    if (!backup) throw new Error('--backup is required for --apply.');
    if (fileExists) throw new Error('Refusing to apply while the bootstrap plaintext file still exists.');
    if (row.consumed_at) throw new Error('Refusing to orphan a consumed bootstrap row.');
    if (activeAuthority.capabilities || activeAuthority.sessions) {
      throw new Error('Refusing to apply because active authority was created after the bootstrap row.');
    }
    const identity = existingIdentity ?? ensureDatabaseIdentity(db, {
      runtimeProfile: 'production',
      environment: 'production',
      allowInitialize: true,
    });
    const now = new Date().toISOString();
    const incidentId = `incident_${nanoid()}`;
    const evidence = {
      ...remediation,
      databaseIdentity: {
        databaseId: identity.databaseId,
        environment: identity.environment,
        initializedDuringRemediation: !existingIdentity,
      },
    };
    db.transaction(() => {
      db.prepare(`
        UPDATE onboarding_bootstrap_secrets
        SET status = CASE WHEN status = 'active' THEN 'orphaned' ELSE status END
        WHERE id = ?
      `).run(row.id);
      db.prepare(`
        INSERT INTO runtime_incidents
          (id, incident_type, database_id, bootstrap_id, report_path, status, evidence_json, created_at, remediated_at)
        VALUES (?, 'orphan_bootstrap', ?, ?, ?, 'remediated', ?, ?, ?)
      `).run(
        incidentId,
        identity?.databaseId ?? null,
        row.id,
        path.resolve(opts.incidentReport),
        JSON.stringify(evidence),
        now,
        now,
      );
    })();
    console.log(JSON.stringify({ ok: true, dryRun: false, incidentId, remediation: evidence }, null, 2));
  } else {
    console.log(JSON.stringify({ ok: true, dryRun: true, remediation }, null, 2));
  }
} finally {
  db.close();
}
