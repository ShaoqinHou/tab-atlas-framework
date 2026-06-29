import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { fingerprintOpenDatabase, redactDatabasePath, type DatabaseFingerprint } from './databaseFingerprint.js';
import { getIdentityFromOpenDatabase } from './databaseIdentity.js';

export interface VerifiedRemediationBackup {
  pathHash: string;
  sha256: string;
  ageMinutes: number;
  integrity: string;
  databaseId: string;
  sourceDatabaseId?: string;
  predatesRemediation: boolean;
  criticalCounts: CriticalCounts;
}

type CriticalCounts = Pick<
DatabaseFingerprint['counts'],
'snapshots'
  | 'resources'
  | 'userAnnotations'
  | 'views'
  | 'conversations'
  | 'actions'
  | 'activeCapabilities'
  | 'activeDashboardSessions'
  | 'bootstrapRows'
  | 'runtimeIncidents'
>;

export function verifyRemediationBackup(input: {
  backupPath: string;
  databasePath: string;
  currentFingerprint: DatabaseFingerprint;
  remediationStartedAt?: Date;
  maxAgeMs?: number;
}): VerifiedRemediationBackup {
  const backupPath = path.resolve(input.backupPath);
  const stat = fs.statSync(backupPath);
  const maxAgeMs = input.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const nowMs = input.remediationStartedAt?.getTime() ?? Date.now();
  const ageMs = nowMs - stat.mtimeMs;
  if (ageMs < -1000) throw new Error(`Backup appears newer than remediation start: ${redactDatabasePath(backupPath).file}`);
  if (ageMs > maxAgeMs) throw new Error(`Backup is older than ${Math.round(maxAgeMs / 60000)} minutes: ${redactDatabasePath(backupPath).file}`);
  if (!input.currentFingerprint.databaseId) throw new Error('Current database has no identity; backup identity cannot be verified.');

  const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const backupIdentity = getIdentityFromOpenDatabase(backupDb);
    if (!backupIdentity) throw new Error('Backup database has no runtime identity.');
    const identityMatches = backupIdentity.databaseId === input.currentFingerprint.databaseId
      || backupIdentity.sourceDatabaseId === input.currentFingerprint.databaseId;
    if (!identityMatches) {
      throw new Error(`Backup identity ${backupIdentity.databaseId} does not match current database ${input.currentFingerprint.databaseId}.`);
    }
    const backupFingerprint = fingerprintOpenDatabase(backupDb, backupPath, backupIdentity);
    if (backupFingerprint.integrity !== 'ok') {
      throw new Error(`Backup integrity check failed: ${backupFingerprint.integrity}`);
    }
    const countDiffs = criticalCountDiffs(backupFingerprint.counts, input.currentFingerprint.counts);
    if (countDiffs.length) {
      throw new Error(`Backup critical counts differ from current database: ${countDiffs.join(', ')}`);
    }
    const data = fs.readFileSync(backupPath);
    return {
      pathHash: crypto.createHash('sha256').update(backupPath.toLowerCase()).digest('hex').slice(0, 16),
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      ageMinutes: Math.max(0, Math.round(ageMs / 60000)),
      integrity: backupFingerprint.integrity,
      databaseId: backupIdentity.databaseId,
      sourceDatabaseId: backupIdentity.sourceDatabaseId,
      predatesRemediation: stat.mtimeMs <= nowMs,
      criticalCounts: pickCriticalCounts(backupFingerprint.counts),
    };
  } finally {
    backupDb.close();
  }
}

function criticalCountDiffs(
  backup: DatabaseFingerprint['counts'],
  current: DatabaseFingerprint['counts'],
): string[] {
  return (Object.keys(pickCriticalCounts(current)) as Array<keyof CriticalCounts>)
    .filter(key => backup[key] !== current[key])
    .map(key => `${key} backup=${backup[key]} current=${current[key]}`);
}

function pickCriticalCounts(counts: DatabaseFingerprint['counts']): CriticalCounts {
  return {
    snapshots: counts.snapshots,
    resources: counts.resources,
    userAnnotations: counts.userAnnotations,
    views: counts.views,
    conversations: counts.conversations,
    actions: counts.actions,
    activeCapabilities: counts.activeCapabilities,
    activeDashboardSessions: counts.activeDashboardSessions,
    bootstrapRows: counts.bootstrapRows,
    runtimeIncidents: counts.runtimeIncidents,
  };
}
