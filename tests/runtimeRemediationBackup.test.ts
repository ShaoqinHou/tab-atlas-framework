import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ensureDatabaseIdentity } from '../src/runtime/databaseIdentity.js';
import { fingerprintDatabase } from '../src/runtime/databaseFingerprint.js';
import { verifyRemediationBackup } from '../src/runtime/remediationBackup.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime remediation backup validation', () => {
  it('accepts a recent intact backup for the same database identity and counts', () => {
    const dir = tempRoot();
    const databasePath = path.join(dir, 'production.sqlite');
    createIdentifiedDatabase(databasePath, 'production');
    const backupPath = path.join(dir, 'backup.sqlite');
    fs.copyFileSync(databasePath, backupPath);
    touch(backupPath, Date.now() - 1000);

    const verified = verifyRemediationBackup({
      backupPath,
      databasePath,
      currentFingerprint: fingerprintDatabase(databasePath),
      remediationStartedAt: new Date(),
    });

    expect(verified).toMatchObject({
      integrity: 'ok',
      predatesRemediation: true,
    });
    expect(verified.databaseId).toBe(fingerprintDatabase(databasePath).databaseId);
  });

  it('rejects a corrupt non-SQLite backup', () => {
    const dir = tempRoot();
    const databasePath = path.join(dir, 'production.sqlite');
    createIdentifiedDatabase(databasePath, 'production');
    const backupPath = path.join(dir, 'backup.txt');
    fs.writeFileSync(backupPath, 'not sqlite');
    touch(backupPath, Date.now() - 1000);

    expect(() => verifyRemediationBackup({
      backupPath,
      databasePath,
      currentFingerprint: fingerprintDatabase(databasePath),
      remediationStartedAt: new Date(),
    })).toThrow();
  });

  it('rejects a valid SQLite backup with an unrelated database identity', () => {
    const dir = tempRoot();
    const databasePath = path.join(dir, 'production.sqlite');
    const unrelatedPath = path.join(dir, 'unrelated.sqlite');
    createIdentifiedDatabase(databasePath, 'production');
    createIdentifiedDatabase(unrelatedPath, 'production');
    touch(unrelatedPath, Date.now() - 1000);

    expect(() => verifyRemediationBackup({
      backupPath: unrelatedPath,
      databasePath,
      currentFingerprint: fingerprintDatabase(databasePath),
      remediationStartedAt: new Date(),
    })).toThrow(/does not match current database/);
  });

  it('rejects stale backups even when identity and counts match', () => {
    const dir = tempRoot();
    const databasePath = path.join(dir, 'production.sqlite');
    createIdentifiedDatabase(databasePath, 'production');
    const backupPath = path.join(dir, 'backup.sqlite');
    fs.copyFileSync(databasePath, backupPath);
    touch(backupPath, Date.now() - (25 * 60 * 60 * 1000));

    expect(() => verifyRemediationBackup({
      backupPath,
      databasePath,
      currentFingerprint: fingerprintDatabase(databasePath),
      remediationStartedAt: new Date(),
    })).toThrow(/older/);
  });
});

function createIdentifiedDatabase(
  databasePath: string,
  environment: 'production' | 'clone',
): void {
  const db = openDatabase(databasePath);
  try {
    ensureDatabaseIdentity(db, {
      runtimeProfile: environment === 'production' ? 'production' : 'roleplay',
      environment,
      allowInitialize: true,
    });
  } finally {
    db.close();
  }
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-remediation-backup-test-'));
  roots.push(root);
  return root;
}

function touch(filePath: string, timeMs: number): void {
  const time = new Date(timeMs);
  fs.utimesSync(filePath, time, time);
}
