import Fastify from 'fastify';
import { openDatabase } from '../db/index.js';
import { importSnapshot } from '../import/headlessSnapshot.js';
import { addUserAnnotationTool, explainMembership, getReviewNext, getResourceBriefs, searchResources, submitReviewDecision } from '../agent/tools.js';
import { buildResourceBrief } from '../resources/briefs.js';

const host = '127.0.0.1';
const port = Number(process.env.TABATLAS_PORT ?? 9787);
const db = openDatabase(process.env.TABATLAS_DB);
const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true, app: 'tabatlas', time: new Date().toISOString() }));

app.post('/snapshot', async (request, reply) => {
  const result = importSnapshot(db, request.body, 'extension_snapshot');
  return reply.send(result);
});

app.get('/api/status', async () => {
  const snapshots = db.prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number };
  const resources = db.prepare('SELECT COUNT(*) AS c FROM resources').get() as { c: number };
  const observations = db.prepare('SELECT COUNT(*) AS c FROM tab_observations').get() as { c: number };
  return { snapshots: snapshots.c, resources: resources.c, observations: observations.c };
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

app.listen({ host, port }).catch(err => {
  app.log.error(err);
  process.exit(1);
});
