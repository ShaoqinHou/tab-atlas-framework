import fs from 'node:fs/promises';
import Fastify from 'fastify';
import { runAgentCommand, type RunAgentCommandInput } from '../agent/commandService.js';
import { countAtomicItems, countCodexScanArtifacts, runCodexResourceScan, type RunCodexResourceScanInput } from '../agent/scanService.js';
import { openDatabase } from '../db/index.js';
import { runDeterministicExtraction } from '../extract/deterministic.js';
import { importSnapshot } from '../import/headlessSnapshot.js';
import { addUserAnnotationTool, explainMembership, getReviewNext, getResourceBriefs, searchResources, submitReviewDecision } from '../agent/tools.js';
import { CodexSdkProvider, type CodexSdkProviderConfig } from '../llm/CodexSdkProvider.js';
import { buildResourceBrief } from '../resources/briefs.js';
import { applyViewPlan, previewView } from '../views/service.js';

const host = '127.0.0.1';
const port = Number(process.env.TABATLAS_PORT ?? 9787);
const db = openDatabase(process.env.TABATLAS_DB);
const app = Fastify({ logger: true });
const indexHtml = new URL('../../web-ui/index.html', import.meta.url);
const codexProviders = new Map<string, CodexSdkProvider>();

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
  const provider = mode === 'codex' ? getCodexProvider({ reasoningEffort }) : 'heuristic';
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

app.post('/api/agent/refine', async (request, reply) => {
  const body = asRecord(request.body);
  const viewId = typeof body.viewId === 'string' ? body.viewId : '';
  const refinement = typeof body.text === 'string' ? body.text : '';
  if (!viewId || !refinement) return reply.status(400).send({ ok: false, error: 'viewId and text are required' });
  const mode = body.mode === 'heuristic' ? 'heuristic' : 'codex';
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = mode === 'codex' ? getCodexProvider({ reasoningEffort }) : 'heuristic';
  const preview = previewView(db, viewId);
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
  };
  const result = await runAgentCommand(db, provider, input);
  return reply.send(result);
});

app.post('/api/agent/scan', async (request, reply) => {
  const body = asRecord(request.body);
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = getCodexProvider({ reasoningEffort });
  const input: RunCodexResourceScanInput = {
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    batchSize: typeof body.batchSize === 'number' ? body.batchSize : undefined,
    resourceIds: Array.isArray(body.resourceIds) ? body.resourceIds.filter((item): item is string => typeof item === 'string') : undefined,
    reasoningEffort,
    force: Boolean(body.force),
  };
  const result = await runCodexResourceScan(db, provider, input);
  return reply.send(result);
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

app.post('/api/views/:viewId/apply', async (request, reply) => {
  const params = request.params as { viewId: string };
  const body = asRecord(request.body);
  const mode = body.mode === 'accepted' ? 'accepted' : 'proposed';
  return reply.send(applyViewPlan(db, params.viewId, mode));
});

app.listen({ host, port }).catch(err => {
  app.log.error(err);
  process.exit(1);
});

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

function getCodexProvider(config: Pick<CodexSdkProviderConfig, 'reasoningEffort'>): CodexSdkProvider {
  const key = config.reasoningEffort ?? 'medium';
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
