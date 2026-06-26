import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { ensureDatabaseIdentity, readDatabaseIdentity } from '../src/runtime/databaseIdentity.js';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

const root = process.cwd();
const outputDir = path.join(root, '.local', 'rc3-runtime-safety-eval');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const results: EvalResult[] = [];

results.push(await directStartRequiresProfile());
results.push(await directStartRequiresDatabase());
results.push(await roleplayRejectsProductionIdentity());
results.push(await occupiedPortNoMutation());
results.push(await sameDatabaseLeaseRejectsSecondProcess());
results.push(await productionRejectsCloneIdentity());
results.push(await cloneCommandCreatesCloneIdentity());
results.push(await startupCreatesBootstrapOnlyAfterListenAndReleasesLease());

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Runtime safety evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Runtime safety evaluation passed: ${results.length}/${results.length} cases.`);

async function directStartRequiresProfile(): Promise<EvalResult> {
  const productionBefore = fileState(path.join(root, 'data', 'tabatlas.sqlite'));
  const child = spawnNode([tsx, 'src/server/index.ts'], {}, 'no-profile');
  const exited = await waitForExit(child, 10_000);
  const productionAfter = fileState(path.join(root, 'data', 'tabatlas.sqlite'));
  return result(
    'Direct server start with no profile',
    'process exits before selecting or opening production database',
    `code=${exited.code}; message=${compact(exited.stderr + exited.stdout)}; productionUnchanged=${sameFileState(productionBefore, productionAfter)}`,
    exited.code !== 0
      && /TABATLAS_RUNTIME_PROFILE/.test(exited.stderr + exited.stdout)
      && sameFileState(productionBefore, productionAfter),
  );
}

async function directStartRequiresDatabase(): Promise<EvalResult> {
  const productionBefore = fileState(path.join(root, 'data', 'tabatlas.sqlite'));
  const child = spawnNode([tsx, 'src/server/index.ts'], {
    TABATLAS_RUNTIME_PROFILE: 'development',
    TABATLAS_PORT: String(await freePort()),
  }, 'no-db');
  const exited = await waitForExit(child, 10_000);
  const productionAfter = fileState(path.join(root, 'data', 'tabatlas.sqlite'));
  return result(
    'Direct server start with no database',
    'process exits before opening any implicit database',
    `code=${exited.code}; message=${compact(exited.stderr + exited.stdout)}; productionUnchanged=${sameFileState(productionBefore, productionAfter)}`,
    exited.code !== 0
      && /TABATLAS_DB/.test(exited.stderr + exited.stdout)
      && sameFileState(productionBefore, productionAfter),
  );
}

async function roleplayRejectsProductionIdentity(): Promise<EvalResult> {
  const dir = path.join(outputDir, 'roleplay-production');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'production.sqlite');
  createIdentifiedDatabase(dbPath, 'production', 'production');
  const before = fileState(dbPath);
  const child = spawnNode([tsx, 'src/server/index.ts'], {
    TABATLAS_RUNTIME_PROFILE: 'roleplay',
    TABATLAS_PORT: String(await freePort()),
    TABATLAS_DB: dbPath,
    TABATLAS_BOOTSTRAP_DIR: path.join(dir, 'bootstrap'),
    TABATLAS_INSTANCE_NAME: 'roleplay-production-reject',
  }, 'roleplay-production');
  const exited = await waitForExit(child, 10_000);
  const after = fileState(dbPath);
  return result(
    'Role-play profile pointing at production DB',
    'server rejects production identity before writable mutation',
    `code=${exited.code}; message=${compact(exited.stderr + exited.stdout)}; unchanged=${sameFileState(before, after)}`,
    exited.code !== 0
      && /Runtime profile roleplay cannot open a production database/.test(exited.stderr + exited.stdout)
      && sameFileState(before, after),
  );
}

async function occupiedPortNoMutation(): Promise<EvalResult> {
  const dir = path.join(outputDir, 'occupied-port');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'occupied.sqlite');
  const bootstrapDir = path.join(dir, 'bootstrap');
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', () => resolve());
  });
  try {
    const child = spawnNode([tsx, 'src/server/index.ts'], {
      TABATLAS_RUNTIME_PROFILE: 'test',
      TABATLAS_PORT: String(port),
      TABATLAS_DB: dbPath,
      TABATLAS_BOOTSTRAP_DIR: bootstrapDir,
      TABATLAS_INSTANCE_NAME: 'occupied-port-eval',
      TABATLAS_ALLOW_IDENTITY_INIT: '1',
    }, 'occupied-port');
    const exited = await waitForExit(child, 10_000);
    const bootstrapFiles = fs.existsSync(bootstrapDir) ? fs.readdirSync(bootstrapDir) : [];
    return result(
      'Occupied port',
      'no DB file, bootstrap file, worker, or lease is retained',
      `code=${exited.code}; dbExists=${fs.existsSync(dbPath)}; bootstrapFiles=${bootstrapFiles.length}; lease=${fs.existsSync(leasePath(dbPath))}`,
      exited.code !== 0
        && !fs.existsSync(dbPath)
        && bootstrapFiles.length === 0
        && !fs.existsSync(leasePath(dbPath)),
    );
  } finally {
    blocker.close();
  }
}

async function sameDatabaseLeaseRejectsSecondProcess(): Promise<EvalResult> {
  const dir = path.join(outputDir, 'same-db');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'receiver.sqlite');
  const firstPort = await freePort();
  const secondPort = await freePort();
  const first = spawnServer(dbPath, firstPort, dir, 'test', 'lease-first');
  try {
    await waitForHealth(firstPort, first, 15_000);
    const beforeSecond = fileState(dbPath);
    const second = spawnServer(dbPath, secondPort, dir, 'test', 'lease-second', false);
    const exited = await waitForExit(second, 10_000);
    const afterSecond = fileState(dbPath);
    return result(
      'Same DB second port',
      'exclusive lease rejects second process without mutating the database',
      `secondCode=${exited.code}; message=${compact(exited.stderr + exited.stdout)}; unchanged=${sameFileState(beforeSecond, afterSecond)}`,
      exited.code !== 0
        && /already leased/.test(exited.stderr + exited.stdout)
        && sameFileState(beforeSecond, afterSecond),
    );
  } finally {
    await stopProcess(first);
  }
}

async function productionRejectsCloneIdentity(): Promise<EvalResult> {
  const dir = path.join(outputDir, 'production-clone');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'clone.sqlite');
  createIdentifiedDatabase(dbPath, 'roleplay', 'clone');
  const before = fileState(dbPath);
  const child = spawnNode([tsx, 'src/server/index.ts'], {
    TABATLAS_RUNTIME_PROFILE: 'production',
    TABATLAS_PORT: String(await freePort()),
    TABATLAS_DB: dbPath,
    TABATLAS_BOOTSTRAP_DIR: path.join(dir, 'bootstrap'),
    TABATLAS_INSTANCE_NAME: 'production-clone-reject',
  }, 'production-clone');
  const exited = await waitForExit(child, 10_000);
  const after = fileState(dbPath);
  return result(
    'Production profile with clone DB',
    'server rejects clone identity before writable mutation',
    `code=${exited.code}; message=${compact(exited.stderr + exited.stdout)}; unchanged=${sameFileState(before, after)}`,
    exited.code !== 0
      && /Runtime profile production cannot open a clone database/.test(exited.stderr + exited.stdout)
      && sameFileState(before, after),
  );
}

async function cloneCommandCreatesCloneIdentity(): Promise<EvalResult> {
  const dir = path.join(outputDir, 'clone-command');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'source.sqlite');
  const destination = path.join(dir, 'clone.sqlite');
  const sourceIdentity = createIdentifiedDatabase(source, 'production', 'production');
  const sourceBefore = fileState(source);
  const child = spawnNode([tsx, 'scripts/environment-clone.ts', '--source', source, '--destination', destination, '--environment', 'clone'], {}, 'clone-command');
  const exited = await waitForExit(child, 20_000);
  const sourceAfter = fileState(source);
  const cloneIdentity = readDatabaseIdentity(destination);
  return result(
    'Clone command',
    'destination gets new clone identity with source ID and source remains unchanged',
    `code=${exited.code}; sourceUnchanged=${sameFileState(sourceBefore, sourceAfter)}; clone=${cloneIdentity?.databaseId ?? '(none)'}; sourceId=${cloneIdentity?.sourceDatabaseId ?? '(none)'}`,
    exited.code === 0
      && sameFileState(sourceBefore, sourceAfter)
      && cloneIdentity?.environment === 'clone'
      && cloneIdentity.databaseId !== sourceIdentity.databaseId
      && cloneIdentity.sourceDatabaseId === sourceIdentity.databaseId,
  );
}

async function startupCreatesBootstrapOnlyAfterListenAndReleasesLease(): Promise<EvalResult> {
  const dir = path.join(outputDir, 'startup-success');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'receiver.sqlite');
  const port = await freePort();
  const child = spawnServer(dbPath, port, dir, 'test', 'startup-success');
  try {
    await waitForHealth(port, child, 15_000);
    const db = openDatabase(dbPath);
    try {
      const bootstrapCount = (db.prepare(`
        SELECT COUNT(*) AS count
        FROM onboarding_bootstrap_secrets
        WHERE status = 'active'
      `).get() as { count: number }).count;
      const identity = readDatabaseIdentity(dbPath);
      const leaseExists = fs.existsSync(leasePath(dbPath));
      await stopProcess(child);
      return result(
        'Startup success and shutdown',
        'listener becomes healthy, then bootstrap exists, identity is test, and lease releases on shutdown',
        `bootstrap=${bootstrapCount}; identity=${identity?.environment ?? '(none)'}; leaseDuringRun=${leaseExists}; leaseAfterStop=${fs.existsSync(leasePath(dbPath))}`,
        bootstrapCount === 1
          && identity?.environment === 'test'
          && leaseExists
          && !fs.existsSync(leasePath(dbPath)),
      );
    } finally {
      db.close();
    }
  } finally {
    await stopProcess(child);
  }
}

function createIdentifiedDatabase(
  dbPath: string,
  runtimeProfile: 'production' | 'roleplay' | 'acceptance' | 'development' | 'test',
  environment: 'production' | 'clone' | 'acceptance' | 'development' | 'test',
) {
  const db = openDatabase(dbPath);
  try {
    return ensureDatabaseIdentity(db, {
      runtimeProfile,
      environment,
      allowInitialize: true,
    });
  } finally {
    db.close();
  }
}

function spawnServer(
  dbPath: string,
  port: number,
  dir: string,
  profile: string,
  instanceName: string,
  initializeIdentity = true,
): ChildProcess {
  return spawnNode([tsx, 'src/server/index.ts'], {
    TABATLAS_RUNTIME_PROFILE: profile,
    TABATLAS_PORT: String(port),
    TABATLAS_DB: dbPath,
    TABATLAS_BOOTSTRAP_DIR: path.join(dir, 'bootstrap'),
    TABATLAS_INSTANCE_NAME: instanceName,
    TABATLAS_WORKER_POLL_MS: '60000',
    ...(initializeIdentity ? { TABATLAS_ALLOW_IDENTITY_INIT: '1' } : {}),
  }, instanceName);
}

function spawnNode(args: string[], env: Record<string, string>, label: string): ChildProcess {
  const log = fs.createWriteStream(path.join(outputDir, `${label}.log`), { flags: 'a' });
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      TEMP: process.env.TEMP ?? os.tmpdir(),
      TMP: process.env.TMP ?? os.tmpdir(),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once('exit', () => log.end());
  return child;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for process exit. stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Receiver exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Wait for the child to bind.
    }
    await delay(250);
  }
  throw new Error(`Receiver did not become healthy on ${port}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (child.connected) child.send('tabatlas:shutdown');
  else child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(3000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port);
        else reject(new Error('Unable to allocate a free port'));
      });
    });
  });
}

function fileState(filePath: string): { exists: boolean; size: number; sha256: string } {
  if (!fs.existsSync(filePath)) return { exists: false, size: 0, sha256: '' };
  return {
    exists: true,
    size: fs.statSync(filePath).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
  };
}

function sameFileState(a: ReturnType<typeof fileState>, b: ReturnType<typeof fileState>): boolean {
  return a.exists === b.exists && a.size === b.size && a.sha256 === b.sha256;
}

function leasePath(dbPath: string): string {
  return `${path.resolve(dbPath)}.tabatlas-lease.json`;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}
