import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CheckpointStore } from '../src/acceptance/checkpointStore.js';
import {
  failedSmoke,
  privateLibraryCommands,
  type CommandSmoke,
  type PrivateLibraryMode,
} from './private-library-acceptance-common.js';

type Args = {
  resume: boolean;
  retryFailed: boolean;
  retryTimeouts: boolean;
  commandId?: string;
  timeoutMs?: number;
  mode?: PrivateLibraryMode;
};

const args = parseArgs(process.argv.slice(2));
const outputDir = path.join(process.cwd(), '.local', 'acceptance');
const outputPath = path.join(outputDir, 'private-library-smoke.json');
const checkpointPath = path.join(outputDir, 'private-library-checkpoints.json');
const mode = args.mode ?? (process.env.TABATLAS_ACCEPTANCE_MODE === 'heuristic' ? 'heuristic' : 'codex');
const timeoutMs = args.timeoutMs ?? Number(process.env.TABATLAS_ACCEPTANCE_COMMAND_TIMEOUT_MS ?? 240_000);
const store = new CheckpointStore<CommandSmoke>(checkpointPath);
const selectedCommands = args.commandId
  ? privateLibraryCommands.filter(command => command.commandId === args.commandId)
  : privateLibraryCommands;

if (args.commandId && selectedCommands.length === 0) {
  console.error(`Unknown command id: ${args.commandId}`);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

for (const command of selectedCommands) {
  if (!store.shouldRun(command.commandId, {
    resume: args.resume,
    retryFailed: args.retryFailed,
    retryTimeouts: args.retryTimeouts,
  })) {
    continue;
  }

  store.start(command.commandId, timeoutMs);
  const started = Date.now();
  const resultFile = path.join(outputDir, `${command.commandId}-worker-result.json`);
  fs.rmSync(resultFile, { force: true });
  const child = spawnWorker(command.commandId, mode, resultFile);
  const outcome = await waitForWorker(child, timeoutMs);
  const durationMs = Date.now() - started;

  if (outcome.status === 'timeout') {
    killProcessTree(child);
    const smoke = failedSmoke(command.commandId, mode, 'timeout', durationMs, `command timed out after ${timeoutMs}ms`);
    store.timeout(command.commandId, smoke.error ?? 'timeout');
    store.pass(`${command.commandId}:last-result`, smoke);
    continue;
  }
  if (outcome.status !== 'passed') {
    const smoke = failedSmoke(command.commandId, mode, 'failed', durationMs, outcome.error || `worker exited with code ${outcome.code}`);
    store.fail(command.commandId, smoke.error ?? 'failed');
    store.pass(`${command.commandId}:last-result`, smoke);
    continue;
  }

  const smoke = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as CommandSmoke;
  store.pass(command.commandId, smoke);
}

const checkpointResults = store.list();
const results = privateLibraryCommands.flatMap(command => {
  const checkpoint = store.get(command.commandId);
  if (checkpoint?.status === 'passed' && checkpoint.result) return [checkpoint.result];
  const failedResult = store.get(`${command.commandId}:last-result`)?.result;
  if (failedResult) return [failedResult];
  return [];
});

fs.writeFileSync(outputPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode,
  checkpointPath,
  checkpoints: checkpointResults.map(({ id, status, attempts, startedAt, finishedAt, timeoutAt, error }) => ({
    id,
    status,
    attempts,
    startedAt,
    finishedAt,
    timeoutAt,
    error,
  })),
  commands: results,
}, null, 2));
console.log(`Private-library smoke metrics written to ${outputPath}`);
console.log(JSON.stringify({ mode, commands: results }, null, 2));

if (results.length < privateLibraryCommands.length || results.some(result => result.status !== 'passed')) {
  process.exitCode = 1;
}

function spawnWorker(commandId: string, modeValue: PrivateLibraryMode, resultFile: string): ChildProcess {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return spawn(process.execPath, [
    tsxCli,
    'scripts/private-library-command-worker.ts',
    '--command',
    commandId,
    '--mode',
    modeValue,
    '--result-file',
    resultFile,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function waitForWorker(child: ChildProcess, timeoutMsValue: number): Promise<{
  status: 'passed' | 'failed' | 'timeout';
  code?: number | null;
  error?: string;
}> {
  return new Promise(resolve => {
    let stderr = '';
    const timer = setTimeout(() => {
      resolve({ status: 'timeout' });
    }, timeoutMsValue);
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ status: 'failed', error: error.message });
    });
    child.on('exit', code => {
      clearTimeout(timer);
      resolve(code === 0
        ? { status: 'passed', code }
        : { status: 'failed', code, error: stderr.slice(0, 4000) });
    });
  });
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

function parseArgs(raw: string[]): Args {
  const parsed = {
    resume: false,
    retryFailed: false,
    retryTimeouts: false,
  } as Args;
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index];
    if (arg === '--resume') parsed.resume = true;
    else if (arg === '--retry-failed') parsed.retryFailed = true;
    else if (arg === '--retry-timeouts') parsed.retryTimeouts = true;
    else if (arg === '--command') parsed.commandId = raw[++index];
    else if (arg === '--timeout-ms') parsed.timeoutMs = Number(raw[++index]);
    else if (arg === '--mode') {
      const value = raw[++index];
      if (value !== 'codex' && value !== 'heuristic') throw new Error(`Unsupported mode: ${value}`);
      parsed.mode = value;
    }
  }
  return parsed;
}
