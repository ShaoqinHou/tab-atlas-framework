import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ensureDatabaseIdentity } from '../src/runtime/databaseIdentity.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('start-tabatlas receiver reuse', () => {
  it('reuses a healthy receiver only when profile database ID and instance match', async () => {
    const fx = fixture('roleplay', 'clone');
    const identity = fx.identity.databaseId;
    const port = await freePort();
    const server = await fakeHealth(port, {
      ok: true,
      app: 'tabatlas',
      profile: 'roleplay',
      instanceName: 'clone-runner',
      port,
      databaseId: identity,
    });
    try {
      const result = await runLauncher(['-Profile', 'roleplay', '-Port', String(port), '-Database', fx.dbPath, '-InstanceName', 'clone-runner', '-NoOpen']);
      expect(result.code).toBe(0);
      expect(result.output).toContain('already running');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a healthy receiver with the wrong profile or database ID', async () => {
    const fx = fixture('roleplay', 'clone');
    const port = await freePort();
    const server = await fakeHealth(port, {
      ok: true,
      app: 'tabatlas',
      profile: 'production',
      instanceName: 'tabatlas-production-9787',
      port,
      databaseId: 'db_production_receiver',
    });
    try {
      const result = await runLauncher(['-Profile', 'roleplay', '-Port', String(port), '-Database', fx.dbPath, '-InstanceName', 'clone-runner', '-NoOpen']);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/instance mismatch/);
      expect(result.output).toMatch(/profile expected roleplay/);
      expect(result.output).toMatch(/database ID expected/);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects reuse when the target database has no identity', async () => {
    const dir = tempRoot();
    const dbPath = path.join(dir, 'unidentified.sqlite');
    openDatabase(dbPath).close();
    const port = await freePort();
    const server = await fakeHealth(port, {
      ok: true,
      app: 'tabatlas',
      profile: 'roleplay',
      instanceName: 'clone-runner',
      port,
      databaseId: 'db_any',
    });
    try {
      const result = await runLauncher(['-Profile', 'roleplay', '-Port', String(port), '-Database', dbPath, '-InstanceName', 'clone-runner', '-NoOpen']);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/target database has no runtime identity/);
    } finally {
      await closeServer(server);
    }
  });
});

function fixture(
  runtimeProfile: 'production' | 'roleplay' | 'acceptance' | 'development' | 'test',
  environment: 'production' | 'clone' | 'acceptance' | 'development' | 'test',
) {
  const dir = tempRoot();
  const dbPath = path.join(dir, `${environment}.sqlite`);
  const db = openDatabase(dbPath);
  try {
    const identity = ensureDatabaseIdentity(db, {
      runtimeProfile,
      environment,
      allowInitialize: true,
    });
    return { dir, dbPath, identity };
  } finally {
    db.close();
  }
}

function runLauncher(args: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(process.cwd(), 'scripts', 'start-tabatlas.ps1'),
    ...args,
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  return new Promise(resolve => {
    child.once('exit', code => resolve({ code, output }));
  });
}

async function fakeHealth(port: number, body: Record<string, unknown>): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-launcher-test-'));
  roots.push(root);
  return root;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port);
        else reject(new Error('Unable to reserve a free port'));
      });
    });
  });
}
