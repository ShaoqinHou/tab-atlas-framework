import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { getIdentityFromOpenDatabase, readDatabaseIdentity } from '../src/runtime/databaseIdentity.js';
import { fingerprintDatabase, fingerprintOpenDatabase, redactDatabasePath, sameDatabaseFingerprint } from '../src/runtime/databaseFingerprint.js';

const program = new Command();
program.requiredOption('--source <path>', 'Source SQLite database path');
program.requiredOption('--destination <path>', 'Destination SQLite database path');
program.option('--environment <environment>', 'Destination environment', 'clone');
program.option('--replace', 'Replace existing destination');
program.parse(process.argv);

const opts = program.opts<{ source: string; destination: string; environment: string; replace?: boolean }>();
if (opts.environment !== 'clone' && opts.environment !== 'acceptance' && opts.environment !== 'development' && opts.environment !== 'test') {
  throw new Error('--environment must be clone, acceptance, development, or test.');
}
if (destinationExists(opts.destination) && !opts.replace) throw new Error('Destination exists. Use --replace to overwrite it explicitly.');

const sourceBefore = fingerprintDatabase(opts.source);
fs.mkdirSync(path.dirname(path.resolve(opts.destination)), { recursive: true });
if (opts.replace) removeDestination(opts.destination);

const sourceDb = new Database(opts.source, { readonly: true, fileMustExist: true });
try {
  await sourceDb.backup(opts.destination);
} finally {
  sourceDb.close();
}

const destDb = openDatabase(opts.destination);
try {
  const now = new Date().toISOString();
  const sourceIdentity = readDatabaseIdentity(opts.source);
  if (!sourceIdentity) throw new Error('Source database has no runtime identity; clone creation requires an identified source.');
  destDb.transaction(() => {
    destDb.prepare('DELETE FROM database_identity').run();
    destDb.prepare(`
      INSERT INTO database_identity (database_id, environment, source_database_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(`db_clone_${crypto.randomUUID()}`, opts.environment, sourceIdentity.databaseId, now, now);
  })();
  const cloneIdentity = getIdentityFromOpenDatabase(destDb);
  const destination = fingerprintOpenDatabase(destDb, opts.destination, cloneIdentity);
  if (destination.integrity !== 'ok') throw new Error(`Destination integrity check failed: ${destination.integrity}`);
  const sourceAfter = fingerprintDatabase(opts.source);
  const manifest = {
    generatedAt: now,
    source: {
      database: redactDatabasePath(opts.source),
      fingerprint: sourceBefore,
    },
    sourceAfter: {
      database: redactDatabasePath(opts.source),
      fingerprint: sourceAfter,
    },
    sourceUnchanged: sameDatabaseFingerprint(sourceBefore, sourceAfter),
    destination: {
      database: redactDatabasePath(opts.destination),
      fingerprint: destination,
    },
    sourceDatabaseId: sourceIdentity?.databaseId ?? null,
    cloneDatabaseId: cloneIdentity?.databaseId,
    cloneSourceDatabaseId: cloneIdentity?.sourceDatabaseId ?? null,
  };
  const manifestPath = `${opts.destination}.clone-manifest.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, manifestPath, ...manifest }, null, 2));
} finally {
  destDb.close();
}

function destinationExists(destination: string): boolean {
  return [
    destination,
    `${destination}-wal`,
    `${destination}-shm`,
    `${destination}.tabatlas-lease.json`,
    `${destination}.clone-manifest.json`,
  ].some(item => fs.existsSync(item));
}

function removeDestination(destination: string): void {
  for (const item of [
    destination,
    `${destination}-wal`,
    `${destination}-shm`,
    `${destination}.tabatlas-lease.json`,
    `${destination}.clone-manifest.json`,
  ]) {
    fs.rmSync(item, { force: true });
  }
}
