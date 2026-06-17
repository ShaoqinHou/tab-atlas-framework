import Fastify from 'fastify';
import { openDatabase } from '../db/index.js';
import { importSnapshot } from '../import/headlessSnapshot.js';

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

app.listen({ host, port }).catch(err => {
  app.log.error(err);
  process.exit(1);
});
