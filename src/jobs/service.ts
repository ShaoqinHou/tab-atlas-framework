import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import {
  ClaimedJobItem,
  CreateJobInput,
  JobProgress,
  JobSnapshot,
  type CreateJobInput as CreateJobInputValue,
  type JobProgress as JobProgressValue,
  type JobSnapshot as JobSnapshotValue,
} from './contracts.js';

type JobRow = {
  id: string;
  kind: string;
  status: string;
  requested_by: string;
  input_json: string;
  progress_json: string;
  result_json: string | null;
  error: string | null;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type ItemRow = {
  id: string;
  job_id: string;
  item_key: string;
  resource_id: string | null;
  input_json: string;
  attempts: number;
};

export function createJob(db: Database.Database, input: CreateJobInputValue): JobSnapshotValue {
  const parsed = CreateJobInput.parse(input);
  const uniqueKeys = new Set(parsed.items.map(item => item.key));
  if (uniqueKeys.size !== parsed.items.length) throw new Error('Job item keys must be unique');
  const id = `job_${nanoid()}`;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO jobs (id, kind, status, requested_by, input_json, progress_json, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(id, parsed.kind, parsed.requestedBy, JSON.stringify(parsed.input), JSON.stringify(progress({ pending: parsed.items.length })), now, now);
    const insert = db.prepare(`
      INSERT INTO job_items (id, job_id, item_key, resource_id, status, attempts, input_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `);
    for (const item of parsed.items) {
      insert.run(`jobitem_${nanoid()}`, id, item.key, item.resourceId ?? null, JSON.stringify(item.input), now, now);
    }
  });
  tx();
  return getJobSnapshot(db, id);
}

export function getJobSnapshot(db: Database.Database, jobId: string): JobSnapshotValue {
  const row = db.prepare(`
    SELECT id, kind, status, requested_by, input_json, progress_json, result_json, error,
           cancel_requested, created_at, updated_at, started_at, finished_at
    FROM jobs WHERE id = ?
  `).get(jobId) as JobRow | undefined;
  if (!row) throw new Error(`Job not found: ${jobId}`);
  return JobSnapshot.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    requestedBy: row.requested_by,
    input: parseJson(row.input_json, {}),
    progress: parseJson(row.progress_json, progress({})),
    result: row.result_json ? parseJson(row.result_json, undefined) : undefined,
    error: row.error ?? undefined,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  });
}

export function beginNextJobItem(db: Database.Database, jobId: string): ClaimedJobItem | null {
  const tx = db.transaction(() => {
    const job = db.prepare('SELECT status, cancel_requested FROM jobs WHERE id = ?').get(jobId) as { status: string; cancel_requested: number } | undefined;
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (job.cancel_requested === 1 || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return null;
    const item = db.prepare(`
      SELECT id, job_id, item_key, resource_id, input_json, attempts
      FROM job_items WHERE job_id = ? AND status = 'pending'
      ORDER BY created_at, id LIMIT 1
    `).get(jobId) as ItemRow | undefined;
    if (!item) {
      finalizeJob(db, jobId);
      return null;
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE job_items SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ?`).run(now, now, item.id);
    db.prepare(`UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`).run(now, now, jobId);
    refreshJobProgress(db, jobId);
    return ClaimedJobItem.parse({
      id: item.id,
      jobId: item.job_id,
      key: item.item_key,
      resourceId: item.resource_id ?? undefined,
      input: parseJson(item.input_json, {}),
      attempts: item.attempts + 1,
    });
  });
  return tx();
}

export function finishJobItem(db: Database.Database, itemId: string, outcome: { ok: boolean; result?: unknown; error?: string }): JobSnapshotValue {
  const tx = db.transaction(() => {
    const item = db.prepare('SELECT job_id FROM job_items WHERE id = ?').get(itemId) as { job_id: string } | undefined;
    if (!item) throw new Error(`Job item not found: ${itemId}`);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE job_items
      SET status = ?, result_json = ?, error = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(outcome.ok ? 'succeeded' : 'failed', outcome.result === undefined ? null : JSON.stringify(outcome.result), outcome.error ?? null, now, now, itemId);
    refreshJobProgress(db, item.job_id);
    finalizeJob(db, item.job_id);
    return item.job_id;
  });
  return getJobSnapshot(db, tx());
}

export function requestJobCancel(db: Database.Database, jobId: string): JobSnapshotValue {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?`).run(now, jobId);
    db.prepare(`UPDATE job_items SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE job_id = ? AND status = 'pending'`).run(now, now, jobId);
    refreshJobProgress(db, jobId);
    finalizeJob(db, jobId);
  });
  tx();
  return getJobSnapshot(db, jobId);
}

export function refreshJobProgress(db: Database.Database, jobId: string): JobProgressValue {
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM job_items WHERE job_id = ? GROUP BY status`).all(jobId) as { status: string; count: number }[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;
  const value = progress(counts);
  db.prepare(`UPDATE jobs SET progress_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(value), new Date().toISOString(), jobId);
  return value;
}

function finalizeJob(db: Database.Database, jobId: string): void {
  const job = db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(jobId) as { cancel_requested: number } | undefined;
  if (!job) return;
  const value = refreshJobProgress(db, jobId);
  if (value.pending || value.running) return;
  const status = job.cancel_requested ? 'cancelled' : value.failed ? 'failed' : 'succeeded';
  const now = new Date().toISOString();
  db.prepare(`UPDATE jobs SET status = ?, finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ?`).run(status, now, now, jobId);
}

function progress(counts: Record<string, number>): JobProgressValue {
  const value = JobProgress.parse({
    pending: counts.pending ?? 0,
    running: counts.running ?? 0,
    succeeded: counts.succeeded ?? 0,
    failed: counts.failed ?? 0,
    skipped: counts.skipped ?? 0,
    cancelled: counts.cancelled ?? 0,
  });
  value.total = value.pending + value.running + value.succeeded + value.failed + value.skipped + value.cancelled;
  return value;
}

function parseJson(value: string, fallback: unknown): unknown {
  try { return JSON.parse(value); } catch { return fallback; }
}
