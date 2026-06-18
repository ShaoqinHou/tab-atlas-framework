import fs from 'node:fs';
import path from 'node:path';

export type CheckpointStatus = 'pending' | 'running' | 'passed' | 'failed' | 'timeout' | 'skipped';

export interface AcceptanceCheckpoint<T = unknown> {
  id: string;
  status: CheckpointStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  timeoutAt?: string;
  result?: T;
  error?: string;
}

export class CheckpointStore<T = unknown> {
  private state: Record<string, AcceptanceCheckpoint<T>> = {};

  constructor(private readonly filePath: string) {
    this.load();
  }

  get(id: string): AcceptanceCheckpoint<T> | undefined {
    return this.state[id];
  }

  list(): AcceptanceCheckpoint<T>[] {
    return Object.values(this.state).sort((a, b) => a.id.localeCompare(b.id));
  }

  shouldRun(id: string, options: { resume?: boolean; retryFailed?: boolean; retryTimeouts?: boolean } = {}): boolean {
    const checkpoint = this.get(id);
    if (!checkpoint) return true;
    if (checkpoint.status === 'passed') return !options.resume;
    if (checkpoint.status === 'failed') return Boolean(options.retryFailed);
    if (checkpoint.status === 'timeout') return Boolean(options.retryTimeouts);
    return true;
  }

  start(id: string, timeoutMs?: number): AcceptanceCheckpoint<T> {
    const now = new Date();
    const checkpoint: AcceptanceCheckpoint<T> = {
      id,
      status: 'running',
      attempts: (this.state[id]?.attempts ?? 0) + 1,
      startedAt: now.toISOString(),
      timeoutAt: timeoutMs ? new Date(now.getTime() + timeoutMs).toISOString() : undefined,
    };
    this.state[id] = checkpoint;
    this.save();
    return checkpoint;
  }

  pass(id: string, result: T): AcceptanceCheckpoint<T> {
    return this.finish(id, 'passed', result);
  }

  fail(id: string, error: unknown): AcceptanceCheckpoint<T> {
    return this.finish(id, 'failed', undefined, error);
  }

  timeout(id: string, error: unknown): AcceptanceCheckpoint<T> {
    return this.finish(id, 'timeout', undefined, error);
  }

  skipped(id: string, reason: string): AcceptanceCheckpoint<T> {
    return this.finish(id, 'skipped', undefined, reason);
  }

  private finish(id: string, status: CheckpointStatus, result?: T, error?: unknown): AcceptanceCheckpoint<T> {
    const previous = this.state[id] ?? { id, attempts: 0, status: 'pending' as const };
    const checkpoint: AcceptanceCheckpoint<T> = {
      ...previous,
      status,
      finishedAt: new Date().toISOString(),
      result,
      error: error === undefined ? undefined : error instanceof Error ? error.message : String(error),
    };
    this.state[id] = checkpoint;
    this.save();
    return checkpoint;
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    this.state = JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, AcceptanceCheckpoint<T>>;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
