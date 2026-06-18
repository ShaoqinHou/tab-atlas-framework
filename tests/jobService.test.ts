import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { beginNextJobItem, createJob, finishJobItem, getJobSnapshot, requestJobCancel } from '../src/jobs/service.js';

describe('durable job service', () => {
  it('tracks queued, running, and completed scan items', () => {
    const db = openDatabase(':memory:');
    const created = createJob(db, {
      kind: 'codex_scan',
      requestedBy: 'test',
      input: { batchSize: 1 },
      items: [
        { key: 'res_1', resourceId: 'res_1' },
        { key: 'res_2', resourceId: 'res_2' },
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
      items: [{ key: 'res_1', resourceId: 'res_1' }],
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
});
