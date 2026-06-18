import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import {
  beginNextJobItem,
  createJob,
  finishJobItem,
  getJobSnapshot,
  listJobItems,
  recoverStaleRunningItems,
  requestJobCancel,
  retryFailedJobItems,
} from '../src/jobs/service.js';
import { runJobWorkerOnce } from '../src/jobs/worker.js';

describe('durable job service', () => {
  it('tracks queued, running, and completed scan items', () => {
    const db = openDatabase(':memory:');
    const created = createJob(db, {
      kind: 'codex_scan',
      requestedBy: 'test',
      input: { batchSize: 1 },
      items: [
        { key: 'res_1' },
        { key: 'res_2' },
      ],
    });
    expect(created.status).toBe('queued');
    expect(created.progress).toMatchObject({ total: 2, pending: 2 });

    const first = beginNextJobItem(db, created.id);
    expect(first?.key).toBe('res_1');
    expect(getJobSnapshot(db, created.id).progress.running).toBe(1);

    finishJobItem(db, first!.id, { ok: true, result: { artifactId: 'art_1' } });
    const second = beginNextJobItem(db, created.id);
    expect(second?.key).toBe('res_2');
    const finished = finishJobItem(db, second!.id, { ok: true });

    expect(finished.status).toBe('succeeded');
    expect(finished.progress).toMatchObject({ total: 2, succeeded: 2, pending: 0, running: 0 });
  });

  it('cancels pending items without deleting job history', () => {
    const db = openDatabase(':memory:');
    const created = createJob(db, {
      kind: 'metadata_fetch',
      requestedBy: 'test',
      items: [{ key: 'res_1' }],
    });
    const cancelled = requestJobCancel(db, created.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelRequested).toBe(true);
    expect(cancelled.progress.cancelled).toBe(1);
  });

  it('rejects duplicate item keys so resume semantics stay deterministic', () => {
    const db = openDatabase(':memory:');
    expect(() => createJob(db, {
      kind: 'codex_scan',
      requestedBy: 'test',
      items: [{ key: 'same' }, { key: 'same' }],
    })).toThrow('unique');
  });

  it('finalizes empty jobs immediately', () => {
    const db = openDatabase(':memory:');
    const created = createJob(db, {
      kind: 'fts_reindex',
      requestedBy: 'test',
      items: [],
    });

    expect(created.status).toBe('succeeded');
    expect(created.progress.total).toBe(0);
  });

  it('recovers stale running leases back to pending', () => {
    const db = openDatabase(':memory:');
    const created = createJob(db, {
      kind: 'codex_scan',
      requestedBy: 'test',
      items: [{ key: 'res_1' }],
    });
    const claimed = beginNextJobItem(db, created.id);
    expect(claimed).not.toBeNull();
    db.prepare(`
      UPDATE job_items
      SET updated_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(claimed!.id);

    const recovered = recoverStaleRunningItems(db, created.id, { staleAfterMs: 1 });

    expect(recovered.status).toBe('queued');
    expect(recovered.progress.pending).toBe(1);
    expect(recovered.progress.running).toBe(0);
  });

  it('cancels pending work while preserving completed item history', () => {
    const db = openDatabase(':memory:');
    const created = createJob(db, {
      kind: 'codex_scan',
      requestedBy: 'test',
      items: [{ key: 'res_1' }, { key: 'res_2' }],
    });
    const first = beginNextJobItem(db, created.id);
    finishJobItem(db, first!.id, { ok: true });

    const cancelled = requestJobCancel(db, created.id);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.progress.succeeded).toBe(1);
    expect(cancelled.progress.cancelled).toBe(1);
  });

  it('retries failed items without repeating successful items', () => {
    const db = openDatabase(':memory:');
    const created = createJob(db, {
      kind: 'codex_scan',
      requestedBy: 'test',
      items: [{ key: 'res_1' }, { key: 'res_2' }],
    });
    const first = beginNextJobItem(db, created.id);
    finishJobItem(db, first!.id, { ok: true });
    const second = beginNextJobItem(db, created.id);
    finishJobItem(db, second!.id, { ok: false, error: 'temporary failure' });

    const retried = retryFailedJobItems(db, created.id, { maxAttempts: 3 });
    const items = listJobItems(db, created.id);

    expect(retried.status).toBe('queued');
    expect(items.find(item => item.key === 'res_1')?.status).toBe('succeeded');
    expect(items.find(item => item.key === 'res_2')?.status).toBe('pending');
  });

  it('enforces retry limits when claiming work', () => {
    const db = openDatabase(':memory:');
    const created = createJob(db, {
      kind: 'codex_scan',
      requestedBy: 'test',
      items: [{ key: 'res_1' }],
    });
    db.prepare(`UPDATE job_items SET attempts = 2 WHERE job_id = ?`).run(created.id);

    const claimed = beginNextJobItem(db, created.id, { maxAttempts: 2 });
    const snapshot = getJobSnapshot(db, created.id);

    expect(claimed).toBeNull();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.progress.failed).toBe(1);
  });

  it('worker advances queued jobs and does not repeat completed items after reopen', async () => {
    const db = openDatabase(':memory:');
    const created = createJob(db, {
      kind: 'codex_scan',
      requestedBy: 'test',
      items: Array.from({ length: 20 }, (_, index) => ({ key: `res_${index + 1}` })),
    });
    const processed: string[] = [];
    const handler = async (jobId: string) => {
      for (let index = 0; index < 5; index += 1) {
        const item = beginNextJobItem(db, jobId);
        if (!item) break;
        processed.push(item.key);
        finishJobItem(db, item.id, { ok: true });
      }
    };

    await runJobWorkerOnce(db, { codex_scan: handler }, { concurrency: 1 });
    expect(getJobSnapshot(db, created.id).progress.succeeded).toBe(5);

    await runJobWorkerOnce(db, { codex_scan: handler }, { concurrency: 1 });
    await runJobWorkerOnce(db, { codex_scan: handler }, { concurrency: 1 });
    await runJobWorkerOnce(db, { codex_scan: handler }, { concurrency: 1 });

    expect(getJobSnapshot(db, created.id).status).toBe('succeeded');
    expect(new Set(processed).size).toBe(20);
  });
});
