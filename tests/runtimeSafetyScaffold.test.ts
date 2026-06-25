import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ensureDatabaseIdentity, getIdentityFromOpenDatabase, readDatabaseIdentity } from '../src/runtime/databaseIdentity.js';
import { acquireDatabaseLease } from '../src/runtime/databaseLease.js';
import { assertProfileDatabaseCompatibility, resolveRuntimeConfig } from '../src/runtime/contracts.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime safety scaffold', () => {
  it('requires profile, port, and database in runtime config', () => {
    expect(() => resolveRuntimeConfig({}, process.cwd())).toThrow(/TABATLAS_RUNTIME_PROFILE/);
    expect(() => resolveRuntimeConfig({
      TABATLAS_RUNTIME_PROFILE: 'development',
      TABATLAS_DB: 'dev.sqlite',
    }, process.cwd())).toThrow(/TABATLAS_PORT/);
    expect(() => resolveRuntimeConfig({
      TABATLAS_RUNTIME_PROFILE: 'development',
      TABATLAS_PORT: '9898',
    }, process.cwd())).toThrow(/TABATLAS_DB/);
  });

  it('enforces profile and database identity compatibility', () => {
    const dir = tempRoot();
    const dbPath = path.join(dir, 'prod.sqlite');
    const db = openDatabase(dbPath);
    try {
      const identity = ensureDatabaseIdentity(db, {
        runtimeProfile: 'production',
        environment: 'production',
        allowInitialize: true,
      });
      expect(readDatabaseIdentity(dbPath)).toMatchObject({
        databaseId: identity.databaseId,
        environment: 'production',
      });
      expect(() => assertProfileDatabaseCompatibility('roleplay', identity.environment)).toThrow(/Runtime profile roleplay cannot open a production database/);
      expect(() => assertProfileDatabaseCompatibility('production', 'clone')).toThrow(/Runtime profile production cannot open a clone database/);
    } finally {
      db.close();
    }
  });

  it('enforces exactly one runtime identity row', () => {
    const dir = tempRoot();
    const dbPath = path.join(dir, 'singleton.sqlite');
    const db = openDatabase(dbPath);
    try {
      ensureDatabaseIdentity(db, {
        runtimeProfile: 'production',
        environment: 'production',
        allowInitialize: true,
      });
      expect((db.prepare('SELECT COUNT(*) AS count FROM database_identity').get() as { count: number }).count).toBe(1);
      expect(() => db.prepare(`
        INSERT INTO database_identity (database_id, environment, created_at, updated_at)
        VALUES ('db_second', 'production', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run()).toThrow();
      expect((db.prepare('SELECT COUNT(*) AS count FROM database_identity').get() as { count: number }).count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('fails closed on ambiguous legacy runtime identities', () => {
    const dir = tempRoot();
    const dbPath = path.join(dir, 'ambiguous.sqlite');
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE database_identity (
          database_id TEXT PRIMARY KEY,
          environment TEXT NOT NULL,
          source_database_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO database_identity VALUES ('db_oldest', 'production', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO database_identity VALUES ('db_newest', 'clone', 'db_oldest', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      `);
      expect(() => getIdentityFromOpenDatabase(db)).toThrow(/runtime identities/);
    } finally {
      db.close();
    }
    expect(() => openDatabase(dbPath)).toThrow(/runtime identities/);
  });

  it('creates clones with exactly one runtime identity', async () => {
    const dir = tempRoot();
    const source = path.join(dir, 'source.sqlite');
    const destination = path.join(dir, 'clone.sqlite');
    const sourceDb = openDatabase(source);
    try {
      const sourceIdentity = ensureDatabaseIdentity(sourceDb, {
        runtimeProfile: 'production',
        environment: 'production',
        allowInitialize: true,
      });
      sourceDb.close();
      const result = await runNodeScript('scripts/environment-clone.ts', [
        '--source', source,
        '--destination', destination,
        '--environment', 'clone',
      ]);
      expect(result.code).toBe(0);
      const cloneDb = openDatabase(destination);
      try {
        const rows = cloneDb.prepare('SELECT database_id, environment, source_database_id FROM database_identity').all() as Array<{
          database_id: string;
          environment: string;
          source_database_id: string | null;
        }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          environment: 'clone',
          source_database_id: sourceIdentity.databaseId,
        });
      } finally {
        cloneDb.close();
      }
    } finally {
      if (sourceDb.open) sourceDb.close();
    }
  });

  it('holds an exclusive sidecar lease and releases only its own lease', () => {
    const dir = tempRoot();
    const dbPath = path.join(dir, 'lease.sqlite');
    const first = acquireDatabaseLease({
      databasePath: dbPath,
      profile: 'development',
      port: 9811,
      instanceName: 'test-a',
      recoverStale: false,
    });
    try {
      expect(fs.existsSync(`${path.resolve(dbPath)}.tabatlas-lease.json`)).toBe(true);
      expect(() => acquireDatabaseLease({
        databasePath: dbPath,
        profile: 'development',
        port: 9812,
        instanceName: 'test-b',
        recoverStale: false,
      })).toThrow(/already leased/);
    } finally {
      first.release();
    }
    expect(fs.existsSync(`${path.resolve(dbPath)}.tabatlas-lease.json`)).toBe(false);
  });

  it('fails an occupied port before creating database, bootstrap, worker, or retained lease', async () => {
    const dir = tempRoot();
    const dbPath = path.join(dir, 'occupied.sqlite');
    const bootstrapDir = path.join(dir, 'bootstrap');
    const port = await listenOnFreePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '127.0.0.1', () => resolve());
    });

    let child: ChildProcess | undefined;
    try {
      child = spawnServer({
        TABATLAS_RUNTIME_PROFILE: 'test',
        TABATLAS_PORT: String(port),
        TABATLAS_DB: dbPath,
        TABATLAS_BOOTSTRAP_DIR: bootstrapDir,
        TABATLAS_INSTANCE_NAME: 'occupied-port-test',
        TABATLAS_ALLOW_IDENTITY_INIT: '1',
      });
      const result = await waitForExit(child, 10_000);
      expect(result.code).not.toBe(0);
      expect(fs.existsSync(dbPath)).toBe(false);
      expect(fs.existsSync(`${path.resolve(dbPath)}.tabatlas-lease.json`)).toBe(false);
      expect(fs.existsSync(bootstrapDir) ? fs.readdirSync(bootstrapDir) : []).toEqual([]);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/already in use|EADDRINUSE|Port/);
    } finally {
      blocker.close();
      if (child && child.exitCode === null) child.kill('SIGKILL');
    }
  }, 15_000);
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-runtime-test-'));
  roots.push(root);
  return root;
}

function spawnServer(env: Record<string, string>): ChildProcess {
  const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return spawn(process.execPath, [tsx, 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      TEMP: process.env.TEMP ?? os.tmpdir(),
      TMP: process.env.TMP ?? os.tmpdir(),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runNodeScript(scriptPath: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsx, scriptPath, ...args], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      TEMP: process.env.TEMP ?? os.tmpdir(),
      TMP: process.env.TMP ?? os.tmpdir(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return waitForExit(child, 20_000);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for child exit. stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function listenOnFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (typeof address === 'object' && address) return address.port;
  throw new Error('Unable to allocate a free port.');
}
