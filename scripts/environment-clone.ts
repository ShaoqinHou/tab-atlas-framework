import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { getIdentityFromOpenDatabase, readDatabaseIdentity } from '../src/runtime/databaseIdentity.js';

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
if (fs.existsSync(opts.destination) && !opts.replace) throw new Error('Destination exists. Use --replace to overwrite it explicitly.');

const sourceBefore = inspectSource(opts.source);
fs.mkdirSync(path.dirname(path.resolve(opts.destination)), { recursive: true });
if (opts.replace) fs.rmSync(opts.destination, { force: true });

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
  destDb.prepare('DELETE FROM database_identity').run();
  destDb.prepare(`
    INSERT INTO database_identity (database_id, environment, source_database_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(`db_clone_${crypto.randomUUID()}`, opts.environment, sourceIdentity?.databaseId ?? null, now, now);
  const cloneIdentity = getIdentityFromOpenDatabase(destDb);
  const destination = inspectOpen(destDb, opts.destination);
  const sourceAfter = inspectSource(opts.source);
  const manifest = {
    generatedAt: now,
    source: redactInspection(sourceBefore),
    sourceAfter: redactInspection(sourceAfter),
    sourceUnchanged: sourceBefore.sha256 === sourceAfter.sha256
      && sourceBefore.snapshots === sourceAfter.snapshots
      && sourceBefore.resources === sourceAfter.resources,
    destination: redactInspection(destination),
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

function inspectSource(databasePath: string) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return inspectOpen(db, databasePath);
  } finally {
    db.close();
  }
}

function inspectOpen(db: Database.Database, databasePath: string) {
  return {
    path: path.resolve(databasePath),
    sha256: fileSha256(databasePath),
    integrity: db.pragma('integrity_check', { simple: true }),
    snapshots: count(db, 'snapshots'),
    resources: count(db, 'resources'),
    userAnnotations: count(db, 'user_annotations'),
  };
}

function count(db: Database.Database, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } catch {
    return 0;
  }
}

function fileSha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function redactInspection<T extends { path: string; sha256: string }>(value: T): Omit<T, 'path'> & { pathHash: string; file: string } {
  const { path: filePath, ...rest } = value;
  return {
    ...rest,
    file: path.basename(filePath),
    pathHash: crypto.createHash('sha256').update(filePath.toLowerCase()).digest('hex').slice(0, 16),
  };
}
