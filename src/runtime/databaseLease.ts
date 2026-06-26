import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { type RuntimeProfile } from './contracts.js';

export interface DatabaseLeaseMetadata {
  leaseId: string;
  pid: number;
  profile: RuntimeProfile;
  port: number;
  instanceName: string;
  hostname: string;
  databasePathHash: string;
  acquiredAt: string;
}

export interface DatabaseLease {
  metadata: DatabaseLeaseMetadata;
  leasePath: string;
  release(): void;
}

export function databaseLeasePath(databasePath: string): string {
  return `${path.resolve(databasePath)}.tabatlas-lease.json`;
}

export function acquireDatabaseLease(input: {
  databasePath: string;
  profile: RuntimeProfile;
  port: number;
  instanceName: string;
  recoverStale: boolean;
}): DatabaseLease {
  const leasePath = databaseLeasePath(input.databasePath);
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  const existing = readLeaseFile(leasePath);
  if (existing) {
    if (isPidAlive(existing.pid)) {
      throw new Error(`Database is already leased by ${existing.instanceName} pid=${existing.pid} profile=${existing.profile} port=${existing.port}.`);
    }
    if (!input.recoverStale) {
      throw new Error(`Stale database lease exists at ${leasePath}. Re-run with TABATLAS_RECOVER_STALE_LEASE=1 after preserving it as incident evidence.`);
    }
    const preserved = `${leasePath}.stale-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(leasePath, preserved);
  }

  const metadata: DatabaseLeaseMetadata = {
    leaseId: crypto.randomUUID(),
    pid: process.pid,
    profile: input.profile,
    port: input.port,
    instanceName: input.instanceName,
    hostname: os.hostname(),
    databasePathHash: crypto.createHash('sha256').update(path.resolve(input.databasePath).toLowerCase()).digest('hex'),
    acquiredAt: new Date().toISOString(),
  };
  fs.writeFileSync(leasePath, JSON.stringify(metadata, null, 2), { flag: 'wx' });
  return {
    metadata,
    leasePath,
    release() {
      const current = readLeaseFile(leasePath);
      if (current?.leaseId === metadata.leaseId) fs.rmSync(leasePath, { force: true });
    },
  };
}

export function readDatabaseLease(databasePath: string): DatabaseLeaseMetadata | null {
  return readLeaseFile(databaseLeasePath(databasePath));
}

function readLeaseFile(leasePath: string): DatabaseLeaseMetadata | null {
  try {
    return JSON.parse(fs.readFileSync(leasePath, 'utf8')) as DatabaseLeaseMetadata;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
