import { z } from 'zod';

export const JobKind = z.enum([
  'codex_scan',
  'deterministic_extract',
  'semantic_view_plan',
  'metadata_fetch',
  'fts_reindex',
]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum([
  'queued',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobItemStatus = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);
export type JobItemStatus = z.infer<typeof JobItemStatus>;

export const JobProgress = z.object({
  total: z.number().int().min(0).default(0),
  pending: z.number().int().min(0).default(0),
  running: z.number().int().min(0).default(0),
  succeeded: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  skipped: z.number().int().min(0).default(0),
  cancelled: z.number().int().min(0).default(0),
});
export type JobProgress = z.infer<typeof JobProgress>;

export const CreateJobInput = z.object({
  kind: JobKind,
  requestedBy: z.string().min(1).default('user'),
  input: z.unknown().default({}),
  items: z.array(z.object({
    key: z.string().min(1),
    resourceId: z.string().optional(),
    input: z.unknown().default({}),
  })).default([]),
});
export type CreateJobInput = z.input<typeof CreateJobInput>;

export const JobSnapshot = z.object({
  id: z.string(),
  kind: JobKind,
  status: JobStatus,
  requestedBy: z.string(),
  input: z.unknown(),
  progress: JobProgress,
  result: z.unknown().optional(),
  error: z.string().optional(),
  cancelRequested: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type JobSnapshot = z.infer<typeof JobSnapshot>;

export const ClaimedJobItem = z.object({
  id: z.string(),
  jobId: z.string(),
  key: z.string(),
  resourceId: z.string().optional(),
  input: z.unknown(),
  attempts: z.number().int().positive(),
});
export type ClaimedJobItem = z.infer<typeof ClaimedJobItem>;
