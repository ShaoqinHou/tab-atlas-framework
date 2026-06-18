import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import Fastify from 'fastify';
import { runAgentCommand, type RunAgentCommandInput } from '../agent/commandService.js';
import {
  cancelAgentAction,
  confirmAgentAction,
  createConversationThread,
  getAgentAction,
  getConversationSnapshot,
  sendConversationMessage,
} from '../agent/conversationService.js';
import {
  countAtomicItems,
  countCodexScanArtifacts,
  createCodexScanJob,
  resumeCodexScanJob,
  runCodexResourceScan,
  type RunCodexResourceScanInput,
} from '../agent/scanService.js';
import { openDatabase } from '../db/index.js';
import { runDeterministicExtraction } from '../extract/deterministic.js';
import { createExtractionJob, ExtractionAdapterRegistry, resumeExtractionJob } from '../extract/runtime.js';
import { createGenericWebpageAdapter } from '../extract/webpage.js';
import { createYouTubeLayeredEvidenceAdapter, importManualYouTubeTranscript } from '../extract/youtube.js';
import { importSnapshot } from '../import/headlessSnapshot.js';
import { getJobSnapshot, listJobItems, listJobs, requestJobCancel, retryFailedJobItems } from '../jobs/service.js';
import { startInProcessJobWorker } from '../jobs/worker.js';
import { addUserAnnotationTool, explainMembership, getReviewNext, getResourceBriefs, searchResources, submitReviewDecision } from '../agent/tools.js';
import { CodexSdkProvider, type CodexSdkProviderConfig } from '../llm/CodexSdkProvider.js';
import { buildResourceBrief } from '../resources/briefs.js';
import { applyViewPlan, previewView } from '../views/service.js';
import {
  acceptViewRevision,
  compareViewRevisions,
  getLatestViewRevision,
  listViewRevisions,
  recordMembershipFeedback,
  rejectViewRevision,
} from '../views/feedbackService.js';

const host = '127.0.0.1';
const port = Number(process.env.TABATLAS_PORT ?? 9787);
const db = openDatabase(process.env.TABATLAS_DB);
const app = Fastify({ logger: true });
const indexHtml = new URL('../../web-ui/index.html', import.meta.url);
const codexProviders = new Map<string, CodexSdkProvider>();
const extractionRegistry = new ExtractionAdapterRegistry();
registerExtractionAdapters(extractionRegistry);
const jobWorker = startInProcessJobWorker(db, {
  codex_scan: async (jobId, context) => {
    const job = getJobSnapshot(db, jobId);
    const input = asRecord(job.input);
    const reasoningEffort = readReasoningEffort(input.reasoningEffort);
    const provider = getCodexProvider({ reasoningEffort, scope: `job:${jobId}` });
    await resumeCodexScanJob(db, provider, jobId, {
      maxItems: Number(process.env.TABATLAS_WORKER_MAX_ITEMS_PER_TICK ?? 1),
      maxRetries: Number(process.env.TABATLAS_JOB_MAX_RETRIES ?? 3),
      signal: context.signal,
    });
  },
  metadata_fetch: async (jobId, context) => {
    await resumeExtractionJob(db, extractionRegistry, jobId, {
      maxItems: Number(process.env.TABATLAS_WORKER_MAX_ITEMS_PER_TICK ?? 1),
      maxRetries: Number(process.env.TABATLAS_JOB_MAX_RETRIES ?? 3),
      signal: context.signal,
    });
  },
}, {
  pollMs: Number(process.env.TABATLAS_WORKER_POLL_MS ?? 1500),
  concurrency: Number(process.env.TABATLAS_WORKER_CONCURRENCY ?? 1),
});

app.get('/health', async () => ({ ok: true, app: 'tabatlas', time: new Date().toISOString() }));

app.get('/', async (_request, reply) => {
  const html = await fs.readFile(indexHtml, 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

app.post('/snapshot', async (request, reply) => {
  const result = importSnapshot(db, request.body, 'extension_snapshot');
  return reply.send(result);
});

app.post('/api/import-file', async (request, reply) => {
  const body = asRecord(request.body);
  const file = typeof body.file === 'string' ? body.file : '';
  if (!file) return reply.status(400).send({ ok: false, error: 'file is required' });
  const json = JSON.parse(await fs.readFile(file, 'utf8'));
  const result = importSnapshot(db, json, 'manual_file_import');
  return reply.send({ ok: true, ...result });
});

app.post('/api/extract/run', async (request, reply) => {
  const body = asRecord(request.body);
  const resourceIds = Array.isArray(body.resourceIds)
    ? body.resourceIds.filter((item): item is string => typeof item === 'string')
    : undefined;
  return reply.send(runDeterministicExtraction(db, resourceIds));
});

app.post('/api/jobs/extraction', async (request, reply) => {
  const body = asRecord(request.body);
  const result = createExtractionJob(db, {
    resourceIds: Array.isArray(body.resourceIds) ? body.resourceIds.filter((item): item is string => typeof item === 'string') : undefined,
    recipeIds: Array.isArray(body.recipeIds) ? body.recipeIds.filter((item): item is string => typeof item === 'string') : undefined,
    force: Boolean(body.force),
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : undefined,
  });
  return reply.code(202).send(result);
});

app.post('/api/resources/:resourceId/youtube/manual-transcript', async (request, reply) => {
  const params = request.params as { resourceId: string };
  const body = asRecord(request.body);
  const plainText = typeof body.plainText === 'string' ? body.plainText : '';
  if (!plainText.trim()) return reply.status(400).send({ ok: false, error: 'plainText is required' });
  const result = importManualYouTubeTranscript(db, {
    resourceId: params.resourceId,
    plainText,
    language: typeof body.language === 'string' ? body.language : undefined,
    isAutoGenerated: Boolean(body.isAutoGenerated),
  });
  return reply.send({ ok: true, ...result });
});

app.get('/api/status', async () => {
  const snapshots = db.prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number };
  const resources = db.prepare('SELECT COUNT(*) AS c FROM resources').get() as { c: number };
  const observations = db.prepare('SELECT COUNT(*) AS c FROM tab_observations').get() as { c: number };
  const unmarked = db.prepare(`
    SELECT COUNT(*) AS c
    FROM review_queue_items
    WHERE queue_name = 'unmarked' AND status IN ('pending', 'skipped')
  `).get() as { c: number };
  const youtube = db.prepare("SELECT COUNT(*) AS c FROM resources WHERE url_kind LIKE 'youtube_%'").get() as { c: number };
  const proposedViews = db.prepare("SELECT COUNT(*) AS c FROM views WHERE status = 'proposed'").get() as { c: number };
  const acceptedViews = db.prepare("SELECT COUNT(*) AS c FROM views WHERE status = 'accepted'").get() as { c: number };
  const agentRuns = db.prepare('SELECT COUNT(*) AS c FROM agent_runs').get() as { c: number };
  const annotated = db.prepare(`
    SELECT COUNT(DISTINCT target_id) AS c
    FROM user_annotations
    WHERE target_kind = 'resource'
  `).get() as { c: number };
  return {
    snapshots: snapshots.c,
    resources: resources.c,
    observations: observations.c,
    unmarked: unmarked.c,
    youtube: youtube.c,
    annotated: annotated.c,
    proposedViews: proposedViews.c,
    acceptedViews: acceptedViews.c,
    agentRuns: agentRuns.c,
    codexScanArtifacts: countCodexScanArtifacts(db),
    atomicItems: countAtomicItems(db),
  };
});

app.get('/api/resources', async () => {
  return db.prepare('SELECT id, canonical_url, url_kind, host, title_best, first_seen_at, last_seen_at FROM resources ORDER BY last_seen_at DESC LIMIT 500').all();
});

app.post('/api/agent/tools/searchResources', async (request, reply) => {
  return reply.send(searchResources(db, request.body));
});

app.post('/api/agent/tools/getResourceBriefs', async (request, reply) => {
  return reply.send(getResourceBriefs(db, request.body));
});

app.post('/api/agent/command', async (request, reply) => {
  const body = asRecord(request.body);
  const mode = body.mode === 'heuristic' ? 'heuristic' : 'codex';
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = mode === 'codex'
    ? getCodexProvider({ reasoningEffort, scope: `agent-command:${crypto.randomUUID()}`, reuseThread: false })
    : 'heuristic';
  const input: RunAgentCommandInput = {
    text: typeof body.text === 'string' ? body.text : '',
    mode,
    candidateLimit: typeof body.candidateLimit === 'number' ? body.candidateLimit : undefined,
    dryRun: Boolean(body.dryRun),
    reasoningEffort,
  };
  const result = await runAgentCommand(db, provider, input);
  return reply.send(result);
});

app.post('/api/conversations', async (request, reply) => {
  const body = asRecord(request.body);
  const thread = createConversationThread(db, typeof body.title === 'string' ? body.title : undefined);
  return reply.code(201).send(getConversationSnapshot(db, thread.id));
});

app.get('/api/conversations/:threadId', async (request, reply) => {
  const params = request.params as { threadId: string };
  return reply.send(getConversationSnapshot(db, params.threadId));
});

app.post('/api/conversations/:threadId/messages', async (request, reply) => {
  const params = request.params as { threadId: string };
  const body = asRecord(request.body);
  const content = typeof body.content === 'string' ? body.content : '';
  if (!content.trim()) return reply.status(400).send({ ok: false, error: 'content is required' });
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = getCodexProvider({ reasoningEffort, scope: `conversation:${params.threadId}` });
  const snapshot = await sendConversationMessage(db, {
    threadId: params.threadId,
    content,
  }, {
    plannerProvider: provider,
  });
  return reply.send(snapshot);
});

app.post('/api/agent-actions/:actionId/confirm', async (request, reply) => {
  const params = request.params as { actionId: string };
  const body = asRecord(request.body);
  const action = getAgentAction(db, params.actionId);
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = getCodexProvider({ reasoningEffort, scope: `conversation:${action.threadId}` });
  return reply.send(await confirmAgentAction(db, params.actionId, { plannerProvider: provider }));
});

app.post('/api/agent-actions/:actionId/cancel', async (request, reply) => {
  const params = request.params as { actionId: string };
  return reply.send(cancelAgentAction(db, params.actionId));
});

app.post('/api/agent/refine', async (request, reply) => {
  const body = asRecord(request.body);
  const viewId = typeof body.viewId === 'string' ? body.viewId : '';
  const refinement = typeof body.text === 'string' ? body.text : '';
  if (!viewId || !refinement) return reply.status(400).send({ ok: false, error: 'viewId and text are required' });
  const mode = body.mode === 'heuristic' ? 'heuristic' : 'codex';
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = mode === 'codex'
    ? getCodexProvider({ reasoningEffort, scope: `agent-refine:${viewId}:${crypto.randomUUID()}`, reuseThread: false })
    : 'heuristic';
  const preview = previewView(db, viewId);
  const parentRevision = getLatestViewRevision(db, viewId);
  const seedResourceIds = db.prepare(`
    SELECT DISTINCT target_id AS id
    FROM memberships
    WHERE view_id = ? AND target_kind = 'resource'
  `).all(viewId).map((row: unknown) => (row as { id: string }).id);
  const input: RunAgentCommandInput = {
    text: [
      `Refine existing view "${preview.name}".`,
      preview.goal ? `Existing goal: ${preview.goal}` : '',
      `User refinement: ${refinement}`,
    ].filter(Boolean).join(' '),
    mode,
    candidateLimit: typeof body.candidateLimit === 'number' ? body.candidateLimit : undefined,
    reasoningEffort,
    seedResourceIds,
    parentRevisionId: parentRevision?.id,
  };
  const result = await runAgentCommand(db, provider, input);
  return reply.send(result);
});

app.post('/api/agent/scan', async (request, reply) => {
  const body = asRecord(request.body);
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = getCodexProvider({ reasoningEffort, scope: `scan:${crypto.randomUUID()}`, reuseThread: false });
  const input = readCodexScanInput(body, reasoningEffort);
  const result = await runCodexResourceScan(db, provider, input);
  return reply.send(result);
});

app.get('/api/jobs', async () => {
  return listJobs(db, { limit: 25 });
});

app.post('/api/jobs/codex-scan', async (request, reply) => {
  const body = asRecord(request.body);
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const result = createCodexScanJob(db, readCodexScanInput(body, reasoningEffort));
  return reply.code(202).send(result);
});

app.get('/api/jobs/:jobId', async (request, reply) => {
  const params = request.params as { jobId: string };
  return reply.send({
    job: getJobSnapshot(db, params.jobId),
    items: listJobItems(db, params.jobId),
  });
});

app.post('/api/jobs/:jobId/cancel', async (request, reply) => {
  const params = request.params as { jobId: string };
  return reply.send(requestJobCancel(db, params.jobId));
});

app.post('/api/jobs/:jobId/resume', async (request, reply) => {
  const params = request.params as { jobId: string };
  const body = asRecord(request.body);
  const job = getJobSnapshot(db, params.jobId);
  if (job.kind === 'metadata_fetch') {
    const result = await resumeExtractionJob(db, extractionRegistry, params.jobId, {
      maxItems: typeof body.maxItems === 'number' ? body.maxItems : undefined,
      maxRetries: typeof body.maxRetries === 'number' ? body.maxRetries : undefined,
    });
    return reply.send(result);
  }
  if (job.kind !== 'codex_scan') return reply.status(400).send({ ok: false, error: `Unsupported job kind: ${job.kind}` });
  const input = asRecord(job.input);
  const reasoningEffort = readReasoningEffort(input.reasoningEffort);
  const provider = getCodexProvider({ reasoningEffort, scope: `job:${params.jobId}` });
  const result = await resumeCodexScanJob(db, provider, params.jobId, {
    maxItems: typeof body.maxItems === 'number' ? body.maxItems : undefined,
    maxRetries: typeof body.maxRetries === 'number' ? body.maxRetries : undefined,
  });
  return reply.send(result);
});

app.post('/api/jobs/:jobId/retry-failed', async (request, reply) => {
  const params = request.params as { jobId: string };
  const body = asRecord(request.body);
  const retried = retryFailedJobItems(db, params.jobId, {
    itemIds: Array.isArray(body.itemIds) ? body.itemIds.filter((item): item is string => typeof item === 'string') : undefined,
    maxAttempts: typeof body.maxAttempts === 'number' ? body.maxAttempts : undefined,
  });
  return reply.send(retried);
});

app.get('/api/commands', async () => {
  return db.prepare(`
    SELECT
      c.id,
      c.text,
      c.status,
      c.created_at,
      COALESCE((
        SELECT json_group_array(s.view_id)
        FROM semantic_view_specs s
        WHERE s.command_id = c.id
      ), '[]') AS view_ids_json
    FROM user_commands c
    ORDER BY c.created_at DESC
    LIMIT 25
  `).all().map((row: unknown) => {
    const command = row as { view_ids_json: string };
    return { ...command, viewIds: parseJsonArray(command.view_ids_json) };
  });
});

app.post('/api/annotations', async (request, reply) => {
  return reply.send(addUserAnnotationTool(db, request.body));
});

app.get('/api/review/next', async (request, reply) => {
  const query = request.query as { queue?: string; preload?: string };
  return reply.send(getReviewNext(db, {
    queue: query.queue ?? 'unmarked',
    preload: query.preload ? Number(query.preload) : 2,
  }));
});

app.post('/api/review/:resourceId/skip', async (request, reply) => {
  const params = request.params as { resourceId: string };
  return reply.send(submitReviewDecision(db, {
    resourceId: params.resourceId,
    action: 'skip',
    tags: [],
    decision: 'none',
  }));
});

app.post('/api/review/:resourceId/complete', async (request, reply) => {
  const params = request.params as { resourceId: string };
  const body = typeof request.body === 'object' && request.body !== null ? request.body : {};
  return reply.send(submitReviewDecision(db, {
    resourceId: params.resourceId,
    action: 'save_and_next',
    ...body,
  }));
});

app.post('/api/review/:resourceId/ignore', async (request, reply) => {
  const params = request.params as { resourceId: string };
  return reply.send(submitReviewDecision(db, {
    resourceId: params.resourceId,
    action: 'mark_ignore',
    tags: ['ignore'],
    decision: 'ignore',
  }));
});

app.get('/api/resources/:id/preview', async (request, reply) => {
  const params = request.params as { id: string };
  return reply.send(buildResourceBrief(db, params.id));
});

app.get('/api/resources/:id/explain', async (request, reply) => {
  const params = request.params as { id: string };
  const query = request.query as { viewId?: string };
  return reply.send(explainMembership(db, {
    resourceId: params.id,
    viewId: query.viewId ?? '',
  }));
});

app.get('/api/views', async () => {
  return db.prepare(`
    SELECT id, name, description, origin, status, created_at
    FROM views
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
});

app.get('/api/views/:viewId/preview', async (request, reply) => {
  const params = request.params as { viewId: string };
  return reply.send(previewView(db, params.viewId));
});

app.get('/api/views/:viewId/revisions', async (request, reply) => {
  const params = request.params as { viewId: string };
  return reply.send(listViewRevisions(db, params.viewId));
});

app.post('/api/views/:viewId/revisions/:revisionId/accept', async (request, reply) => {
  const params = request.params as { revisionId: string };
  return reply.send(acceptViewRevision(db, params.revisionId));
});

app.post('/api/views/:viewId/revisions/:revisionId/reject', async (request, reply) => {
  const params = request.params as { revisionId: string };
  return reply.send(rejectViewRevision(db, params.revisionId));
});

app.get('/api/views/:viewId/revisions/:revisionId/compare', async (request, reply) => {
  const params = request.params as { revisionId: string };
  const query = request.query as { otherRevisionId?: string };
  if (!query.otherRevisionId) return reply.status(400).send({ ok: false, error: 'otherRevisionId is required' });
  return reply.send(compareViewRevisions(db, params.revisionId, query.otherRevisionId));
});

app.post('/api/views/:viewId/apply', async (request, reply) => {
  const params = request.params as { viewId: string };
  const body = asRecord(request.body);
  const mode = body.mode === 'accepted' ? 'accepted' : 'proposed';
  return reply.send(applyViewPlan(db, params.viewId, mode));
});

app.post('/api/membership-feedback', async (request, reply) => {
  return reply.send(recordMembershipFeedback(db, asRecord(request.body) as Parameters<typeof recordMembershipFeedback>[1]));
});

app.listen({ host, port }).catch(err => {
  app.log.error(err);
  process.exit(1);
});

process.once('SIGINT', () => jobWorker.stop());
process.once('SIGTERM', () => jobWorker.stop());

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function readCodexScanInput(
  body: Record<string, unknown>,
  reasoningEffort: CodexSdkProviderConfig['reasoningEffort'],
): RunCodexResourceScanInput {
  return {
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    batchSize: typeof body.batchSize === 'number' ? body.batchSize : undefined,
    maxBatchBytes: typeof body.maxBatchBytes === 'number' ? body.maxBatchBytes : undefined,
    resourceIds: Array.isArray(body.resourceIds) ? body.resourceIds.filter((item): item is string => typeof item === 'string') : undefined,
    reasoningEffort,
    force: Boolean(body.force),
  };
}

function getCodexProvider(config: Pick<CodexSdkProviderConfig, 'reasoningEffort' | 'reuseThread'> & { scope: string }): CodexSdkProvider {
  if (config.reuseThread === false) {
    return new CodexSdkProvider({
      reasoningEffort: config.reasoningEffort ?? 'medium',
      reuseThread: false,
      workingDirectory: process.cwd(),
    });
  }
  const key = `${config.scope}:${config.reasoningEffort ?? 'medium'}`;
  const existing = codexProviders.get(key);
  if (existing) return existing;
  const provider = new CodexSdkProvider({
    reasoningEffort: config.reasoningEffort ?? 'medium',
    reuseThread: true,
    workingDirectory: process.cwd(),
  });
  codexProviders.set(key, provider);
  return provider;
}

function readReasoningEffort(value: unknown): CodexSdkProviderConfig['reasoningEffort'] {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' ? value : 'medium';
}

function registerExtractionAdapters(registry: ExtractionAdapterRegistry): void {
  registry.register(createGenericWebpageAdapter());
  registry.register(createYouTubeLayeredEvidenceAdapter({
    officialDataApi: {
      enabled: process.env.TABATLAS_YOUTUBE_DATA_API_ENABLED === '1',
      apiKeyEnvironmentVariable: process.env.TABATLAS_YOUTUBE_API_KEY_ENV ?? 'YOUTUBE_API_KEY',
    },
    localYtDlp: {
      enabled: process.env.TABATLAS_YTDLP_ENABLED === '1',
      executable: process.env.TABATLAS_YTDLP_EXECUTABLE ?? 'yt-dlp',
      allowAutomaticCaptions: process.env.TABATLAS_YTDLP_AUTO_CAPTIONS === '1',
      preferredLanguages: (process.env.TABATLAS_YTDLP_LANGS ?? 'en.*').split(',').map(item => item.trim()).filter(Boolean),
    },
  }));
}
