import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createCapability, createPairingCode, exchangePairingCode, type CapabilityScope } from '../src/security/localCapability.js';
import { installLocalRequestGuard } from '../src/security/localRequestGuard.js';
import { validateImportPath } from '../src/security/importPathPolicy.js';
import { openDatabase } from '../src/db/index.js';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

const results: EvalResult[] = [];
results.push(await bootstrapAdminCapability());
results.push(await extensionPairingIsSnapshotOnly());
results.push(await crossSiteDenialIsAuditedWithoutSecrets());
results.push(importPathPolicyDeniesEscapes());

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Security evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Security evaluation passed: ${results.length}/${results.length} cases.`);

async function bootstrapAdminCapability(): Promise<EvalResult> {
  const { app } = guardedApp();
  const created = await app.inject({
    method: 'POST',
    url: '/api/security/capabilities',
    headers: localHeaders(),
    payload: {
      kind: 'ui',
      label: 'Eval dashboard',
      scopes: ['admin', 'api:read', 'api:write'],
    },
  });
  const payload = created.json() as { token?: string; capability?: { scopes?: string[] } };
  const missing = await app.inject({ method: 'GET', url: '/api/status', headers: localHeaders() });
  const authed = await app.inject({
    method: 'GET',
    url: '/api/status',
    headers: { ...localHeaders(), 'x-tab-atlas-token': payload.token ?? '' },
  });
  await app.close();
  return result(
    'Bootstrap admin capability',
    'first local admin token can be created; API then requires that token',
    `create=${created.statusCode}; missing=${missing.statusCode}; authed=${authed.statusCode}; scopes=${payload.capability?.scopes?.join(',') ?? '(none)'}`,
    created.statusCode === 201 && Boolean(payload.token) && missing.statusCode === 401 && authed.statusCode === 200,
  );
}

async function extensionPairingIsSnapshotOnly(): Promise<EvalResult> {
  const { app, db } = guardedApp();
  const admin = createCapability(db, { kind: 'ui', scopes: ['admin'] });
  const created = await app.inject({
    method: 'POST',
    url: '/api/security/pairing-codes',
    headers: { ...localHeaders(), 'x-tab-atlas-token': admin.token },
    payload: { ttlMs: 60_000 },
  });
  const code = (created.json() as { code: string }).code;
  const paired = await app.inject({
    method: 'POST',
    url: '/api/security/pairing-codes/exchange',
    headers: { ...localHeaders(), origin: 'chrome-extension://tabatlas' },
    payload: { code },
  });
  const pairedBody = paired.json() as { token?: string };
  const snapshot = await app.inject({
    method: 'POST',
    url: '/snapshot',
    headers: { ...localHeaders(), 'x-tab-atlas-token': pairedBody.token ?? '' },
    payload: { capturedAt: '2026-06-18T00:00:00.000Z', tabs: [] },
  });
  const job = await app.inject({
    method: 'POST',
    url: '/api/jobs/codex-scan',
    headers: { ...localHeaders(), 'x-tab-atlas-token': pairedBody.token ?? '' },
  });
  await app.close();
  return result(
    'Extension pairing is snapshot-only',
    'paired extension token can write snapshots and cannot access jobs',
    `pair=${paired.statusCode}; snapshot=${snapshot.statusCode}; job=${job.statusCode}`,
    paired.statusCode === 200 && snapshot.statusCode === 200 && job.statusCode === 401,
  );
}

async function crossSiteDenialIsAuditedWithoutSecrets(): Promise<EvalResult> {
  const { app, db } = guardedApp();
  const admin = createCapability(db, { kind: 'ui', scopes: ['admin'] });
  const denied = await app.inject({
    method: 'POST',
    url: '/api/annotations',
    headers: {
      ...localHeaders(),
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'x-tab-atlas-token': admin.token,
    },
  });
  const auditRows = JSON.stringify(db.prepare('SELECT * FROM security_audit_events').all());
  await app.close();
  return result(
    'Cross-site denial audit redacts secrets',
    'cross-site mutation is denied and audit storage does not contain the token',
    `status=${denied.statusCode}; auditRows=${auditRows.length}`,
    denied.statusCode === 403 && !auditRows.includes(admin.token),
  );
}

function importPathPolicyDeniesEscapes(): EvalResult {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-security-eval-'));
  const root = path.join(base, 'captures');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const allowed = path.join(root, 'latest-all.json');
  const outsideJson = path.join(outside, 'secret.json');
  const tooLarge = path.join(root, 'too-large.json');
  fs.writeFileSync(allowed, '{"tabs":[]}');
  fs.writeFileSync(outsideJson, '{"secret":true}');
  fs.writeFileSync(tooLarge, '{"padding":"' + 'x'.repeat(64) + '"}');
  const policy = { captureRoots: [root], maxImportBytes: 20 };
  const checks: string[] = [];
  try {
    checks.push(validateImportPath(allowed, { ...policy, maxImportBytes: 1024 }).path.endsWith('latest-all.json') ? 'allowed-pass' : 'allowed-fail');
    try { validateImportPath(outsideJson, policy); checks.push('outside-fail'); } catch { checks.push('outside-pass'); }
    try { validateImportPath(tooLarge, policy); checks.push('size-fail'); } catch { checks.push('size-pass'); }
    const link = path.join(root, 'linked-secret.json');
    try {
      fs.symlinkSync(outsideJson, link, 'file');
      try { validateImportPath(link, { ...policy, maxImportBytes: 1024 }); checks.push('symlink-fail'); } catch { checks.push('symlink-pass'); }
    } catch {
      checks.push('symlink-skipped');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  const pass = checks.includes('allowed-pass')
    && checks.includes('outside-pass')
    && checks.includes('size-pass')
    && !checks.includes('symlink-fail');
  return result(
    'Import path policy denies escapes',
    'only regular JSON under configured roots is accepted',
    checks.join(', '),
    pass,
  );
}

function guardedApp() {
  const db = openDatabase(':memory:');
  const app = Fastify();
  installLocalRequestGuard(app, db, { host: '127.0.0.1', port: 9787 });
  app.get('/api/status', async () => ({ ok: true }));
  app.post('/snapshot', async () => ({ ok: true }));
  app.post('/api/jobs/codex-scan', async () => ({ ok: true }));
  app.post('/api/annotations', async () => ({ ok: true }));
  app.post('/api/security/capabilities', async (request, reply) => {
    const body = asRecord(request.body);
    const scopes: CapabilityScope[] = Array.isArray(body.scopes)
      ? body.scopes.filter((item): item is CapabilityScope => item === 'admin' || item === 'api:read' || item === 'api:write')
      : ['api:read'];
    return reply.code(201).send(createCapability(db, {
      kind: body.kind === 'ui' ? 'ui' : 'automation',
      label: typeof body.label === 'string' ? body.label : undefined,
      scopes,
    }));
  });
  app.post('/api/security/pairing-codes', async request => {
    const body = asRecord(request.body);
    return createPairingCode(db, { kind: 'extension', scopes: ['snapshot:write'], ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined });
  });
  app.post('/api/security/pairing-codes/exchange', async request => {
    const body = asRecord(request.body);
    return exchangePairingCode(db, typeof body.code === 'string' ? body.code : '', 'Eval extension');
  });
  return { app, db };
}

function localHeaders() {
  return { host: '127.0.0.1:9787' };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}
