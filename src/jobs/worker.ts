import type Database from 'better-sqlite3';
import { listRunnableJobs, recoverStaleRunningItems } from './service.js';

export interface JobWorkerContext {
  signal: AbortSignal;
}

export type JobWorkerHandler = (jobId: string, context: JobWorkerContext) => Promise<void>;

export interface JobWorkerOptions {
  pollMs?: number;
  concurrency?: number;
  staleLeaseMs?: number;
  kinds?: string[];
}

export interface RunningJobWorker {
  stop(): void;
  runOnce(): Promise<void>;
}

export function startInProcessJobWorker(
  db: Database.Database,
  handlers: Record<string, JobWorkerHandler>,
  options: JobWorkerOptions = {},
): RunningJobWorker {
  const pollMs = options.pollMs ?? 1500;
  const active = new Map<string, AbortController>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function runOnce(): Promise<void> {
    if (stopped) return;
    await runJobWorkerOnce(db, handlers, {
      ...options,
      active,
    });
  }

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      runOnce().catch(() => undefined).finally(schedule);
    }, pollMs);
  };
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
    runOnce,
  };
}

export async function runJobWorkerOnce(
  db: Database.Database,
  handlers: Record<string, JobWorkerHandler>,
  options: JobWorkerOptions & { active?: Map<string, AbortController> } = {},
): Promise<void> {
  const active = options.active ?? new Map<string, AbortController>();
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const staleLeaseMs = options.staleLeaseMs ?? 5 * 60 * 1000;
  const runnable = listRunnableJobs(db, { kinds: options.kinds ?? Object.keys(handlers), limit: concurrency * 2 });
  const starts: Promise<void>[] = [];

  for (const job of runnable) {
    if (active.size >= concurrency) break;
    if (active.has(job.id)) continue;
    const handler = handlers[job.kind];
    if (!handler) continue;
    recoverStaleRunningItems(db, job.id, { staleAfterMs: staleLeaseMs });
    const controller = new AbortController();
    active.set(job.id, controller);
    starts.push(
      handler(job.id, { signal: controller.signal })
        .catch(() => undefined)
        .finally(() => {
          active.delete(job.id);
        }),
    );
  }

  await Promise.all(starts);
}
