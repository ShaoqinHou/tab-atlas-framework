import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LlmProvider, LlmResult, LlmTurnOptions } from './types.js';

export interface CodexExecProviderConfig {
  codexBin?: string;
  cwd?: string;
  timeoutMs?: number;
}

export class CodexExecProvider implements LlmProvider {
  constructor(private readonly cfg: CodexExecProviderConfig = {}) {}

  async complete(prompt: string, opts?: LlmTurnOptions): Promise<LlmResult> {
    const dir = await mkdtemp(path.join(tmpdir(), 'tabatlas-codex-'));
    const out = path.join(dir, 'last.json');
    const schemaPath = opts?.outputSchema ? path.join(dir, 'schema.json') : null;
    if (schemaPath) await writeFile(schemaPath, JSON.stringify(opts!.outputSchema, null, 2), 'utf8');

    const fullPrompt = opts?.system ? `${opts.system}\n\n---\n\n${prompt}` : prompt;
    const args = [
      'exec',
      '--json',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '-o', out,
      ...(schemaPath ? ['--output-schema', schemaPath] : []),
      fullPrompt,
    ];

    await runProcess(this.cfg.codexBin ?? 'codex', args, this.cfg.cwd, opts?.timeoutMs ?? this.cfg.timeoutMs ?? 120_000);
    const text = await readFile(out, 'utf8');
    return { text, usage: { quotaTurns: 1 } };
  }
}

function runProcess(command: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`codex exec failed with code ${code}: ${stderr.slice(0, 4000)}`));
    });
  });
}
