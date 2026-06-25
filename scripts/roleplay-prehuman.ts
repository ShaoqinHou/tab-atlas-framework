import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { readDatabaseIdentity } from '../src/runtime/databaseIdentity.js';

type DbCounts = {
  sha256: string;
  integrity: string;
  snapshots: number;
  resources: number;
  userAnnotations: number;
  activeCapabilities: number;
  dashboardSessions: number;
};

type StoryResult = {
  story: string;
  result: 'passed' | 'failed';
  score: number;
  help: string;
  issues: string[];
};

const program = new Command();
program
  .option('--source <path>', 'Production/source database path', path.join('data', 'tabatlas.sqlite'))
  .option('--workdir <path>', 'Local role-play evidence directory', path.join('.local', 'prehuman-roleplay-rc3'))
  .option('--port <port>', 'Role-play receiver port', '9786')
  .option('--replace', 'Replace an existing role-play clone')
  .option('--skip-workspace-ux', 'Skip the heavier browser workspace role-play gate')
  .parse(process.argv);

const opts = program.opts<{ source: string; workdir: string; port: string; replace?: boolean; skipWorkspaceUx?: boolean }>();
const root = process.cwd();
const source = path.resolve(root, opts.source);
const workdir = path.resolve(root, opts.workdir);
const cloneDb = path.join(workdir, 'roleplay.sqlite');
const bootstrapDir = path.join(workdir, 'bootstrap');
const port = Number(opts.port);
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid --port: ${opts.port}`);
if (!fs.existsSync(source)) throw new Error(`Source database not found: ${source}`);
if (!await canBind(port)) throw new Error(`Role-play port ${port} is not available.`);

fs.mkdirSync(workdir, { recursive: true });
fs.rmSync(bootstrapDir, { recursive: true, force: true });
fs.mkdirSync(bootstrapDir, { recursive: true });

const productionBefore = inspectDatabase(source);
const productionIdentity = readDatabaseIdentity(source);
if (!productionIdentity || productionIdentity.environment !== 'production') {
  throw new Error('Production/source database must have a production identity before role-play. Run the explicit runtime identity/remediation path first.');
}

const cloneExitCode = await runCommand('environment-clone', [
  process.execPath,
  tsx,
  'scripts/environment-clone.ts',
  '--source',
  source,
  '--destination',
  cloneDb,
  '--environment',
  'clone',
  ...(opts.replace ? ['--replace'] : []),
]);
if (cloneExitCode !== 0) throw new Error(`environment-clone failed; see ${path.join(workdir, 'environment-clone.log')}`);
if (!fs.existsSync(cloneDb)) throw new Error(`environment-clone did not create ${cloneDb}`);

const cloneIdentity = readDatabaseIdentity(cloneDb);
if (!cloneIdentity || cloneIdentity.environment !== 'clone' || cloneIdentity.sourceDatabaseId !== productionIdentity.databaseId) {
  throw new Error('Role-play clone identity verification failed.');
}

const server = startRoleplayReceiver();
const storyResults: StoryResult[] = [];
try {
  await waitForHealth(port, server, 30_000);
  storyResults.push(...await runPrehumanGates());
} finally {
  await stopProcess(server);
}

const productionAfter = inspectDatabase(source);
const report = {
  generatedAt: new Date().toISOString(),
  source: {
    databaseId: productionIdentity.databaseId,
    before: productionBefore,
    after: productionAfter,
    unchanged: sameCounts(productionBefore, productionAfter),
  },
  clone: {
    databaseId: cloneIdentity.databaseId,
    sourceDatabaseId: cloneIdentity.sourceDatabaseId,
    integrity: inspectDatabase(cloneDb).integrity,
  },
  runtime: {
    profile: 'roleplay',
    port,
    database: path.basename(cloneDb),
    bootstrapDirectory: path.basename(bootstrapDir),
    cleanup: {
      serverStopped: server.exitCode !== null,
      leaseReleased: !fs.existsSync(`${cloneDb}.tabatlas-lease.json`),
    },
  },
  stories: storyResults,
  ok: sameCounts(productionBefore, productionAfter) && storyResults.every(story => story.result === 'passed'),
};
const reportPath = path.join(workdir, 'prehuman-roleplay-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, reportPath, stories: storyResults }, null, 2));
if (!report.ok) process.exit(1);

async function runPrehumanGates(): Promise<StoryResult[]> {
  const commands: Array<{ id: string; command: string[]; stories: string[] }> = [
    {
      id: 'runtime-safety',
      command: ['npm', 'run', 'eval:runtime-safety'],
      stories: ['Review seeding'],
    },
    {
      id: 'action-lifecycle',
      command: ['npm', 'run', 'eval:action-lifecycle'],
      stories: ['Creative Collector', 'Skeptical Curator'],
    },
    {
      id: 'pilot-readiness',
      command: ['npm', 'run', 'eval:pilot-readiness'],
      stories: ['Knowledge Miner', 'Project Builder', 'Opened for Later', 'Returning User'],
    },
    ...(opts.skipWorkspaceUx ? [] : [{
      id: 'workspace-ux',
      command: ['npm', 'run', 'eval:workspace-ux'],
      stories: ['Creative Collector', 'Project Builder', 'Skeptical Curator', 'Returning User'],
    }]),
  ];
  const stories = new Map<string, StoryResult>();
  for (const item of commands) {
    const exitCode = await runCommand(item.id, item.command);
    for (const story of item.stories) {
      const existing = stories.get(story);
      const passed = exitCode === 0 && existing?.result !== 'failed';
      stories.set(story, {
        story,
        result: passed ? 'passed' : 'failed',
        score: passed ? 1 : 0,
        help: passed ? `${item.id} gate passed` : `${item.id} gate failed; see ${item.id}.log`,
        issues: passed ? [] : [`${item.id} failed`],
      });
    }
  }
  for (const required of ['Review seeding', 'Creative Collector', 'Project Builder', 'Knowledge Miner', 'Skeptical Curator', 'Opened for Later', 'Returning User']) {
    if (!stories.has(required)) {
      stories.set(required, {
        story: required,
        result: 'failed',
        score: 0,
        help: 'Story was not covered by the pre-human runner.',
        issues: ['missing story coverage'],
      });
    }
  }
  return [...stories.values()];
}

function startRoleplayReceiver(): ChildProcess {
  const log = fs.createWriteStream(path.join(workdir, 'roleplay-receiver.log'), { flags: 'a' });
  const child = spawn(process.execPath, [tsx, 'src/server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      TABATLAS_RUNTIME_PROFILE: 'roleplay',
      TABATLAS_PORT: String(port),
      TABATLAS_DB: cloneDb,
      TABATLAS_BOOTSTRAP_DIR: bootstrapDir,
      TABATLAS_INSTANCE_NAME: 'prehuman-roleplay-rc3',
      TABATLAS_WORKER_POLL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once('exit', () => log.end());
  return child;
}

async function runCommand(label: string, args: string[]): Promise<number> {
  const invocation = resolveCommandInvocation(args);
  const logPath = path.join(workdir, `${label}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(invocation.command, invocation.args, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return await new Promise(resolve => {
    child.once('exit', code => {
      log.end();
      resolve(code ?? 1);
    });
  });
}

function resolveCommandInvocation(args: string[]): { command: string; args: string[] } {
  const [command, ...commandArgs] = args;
  if (command !== 'npm') return { command, args: commandArgs };
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...commandArgs] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: commandArgs };
}

async function waitForHealth(targetPort: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Role-play receiver exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/health`);
      if (response.ok) return;
    } catch {
      // Wait for receiver startup.
    }
    await delay(250);
  }
  throw new Error(`Role-play receiver did not become healthy on ${targetPort}.`);
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

async function canBind(targetPort: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(targetPort, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function inspectDatabase(databasePath: string): DbCounts {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return {
      sha256: crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex'),
      integrity: String(db.pragma('integrity_check', { simple: true })),
      snapshots: count(db, 'snapshots'),
      resources: count(db, 'resources'),
      userAnnotations: count(db, 'user_annotations'),
      activeCapabilities: countWhere(db, 'local_capabilities', "status = 'active'"),
      dashboardSessions: countWhere(db, 'local_sessions', "revoked_at IS NULL AND expires_at > datetime('now')"),
    };
  } finally {
    db.close();
  }
}

function count(db: Database.Database, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } catch {
    return 0;
  }
}

function countWhere(db: Database.Database, table: string, where: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
  } catch {
    return 0;
  }
}

function sameCounts(a: DbCounts, b: DbCounts): boolean {
  return a.sha256 === b.sha256
    && a.snapshots === b.snapshots
    && a.resources === b.resources
    && a.userAnnotations === b.userAnnotations
    && a.activeCapabilities === b.activeCapabilities
    && a.dashboardSessions === b.dashboardSessions;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
