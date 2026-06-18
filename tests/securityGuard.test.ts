import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createCapability, revokeCapability } from '../src/security/localCapability.js';
import { createPairingChallenge, exchangePairingChallenge } from '../src/security/pairingChallenge.js';
import { installLocalRequestGuard, requiredScopeFor } from '../src/security/localRequestGuard.js';
import { openDatabase } from '../src/db/index.js';

function guardedApp() {
  const db = openDatabase(':memory:');
  const app = Fastify();
  installLocalRequestGuard(app, db, { host: '127.0.0.1', port: 9787 });
  app.get('/health', async () => ({ ok: true }));
  app.post('/snapshot', async () => ({ ok: true }));
  app.get('/api/status', async () => ({ ok: true }));
  app.post('/api/annotations', async () => ({ ok: true }));
  app.post('/api/jobs/codex-scan', async () => ({ ok: true }));
  app.post('/api/conversations', async () => ({ ok: true }));
  app.post('/api/security/pairing-codes', async request => {
    const body = typeof request.body === 'object' && request.body ? request.body as { ttlMs?: number } : {};
    return createPairingChallenge(db, { ttlMs: body.ttlMs });
  });
  app.post('/api/security/pairing-codes/exchange', async request => {
    const body = typeof request.body === 'object' && request.body ? request.body as { challengeId?: string; secret?: string } : {};
    return exchangePairingChallenge(db, {
      challengeId: body.challengeId ?? '',
      secret: body.secret ?? '',
      label: 'Test extension',
      throttleKey: 'test',
    });
  });
  return { app, db };
}

const localHeaders = { host: '127.0.0.1:9787' };

describe('local request guard', () => {
  it('keeps route scope classification centralized', () => {
    expect(requiredScopeFor('GET', '/health')).toBe('local_only');
    expect(requiredScopeFor('POST', '/snapshot')).toBe('snapshot:write');
    expect(requiredScopeFor('GET', '/api/status')).toBe('api:read');
    expect(requiredScopeFor('POST', '/api/annotations')).toBe('api:write');
    expect(requiredScopeFor('POST', '/api/jobs/codex-scan')).toBe('jobs:write');
    expect(requiredScopeFor('POST', '/api/conversations')).toBe('agent:write');
    expect(requiredScopeFor('POST', '/api/security/capabilities')).toBe('bootstrap_admin');
  });

  it('allows local health without a token but rejects untrusted Host', async () => {
    const { app } = guardedApp();
    const ok = await app.inject({ method: 'GET', url: '/health', headers: localHeaders });
    const bad = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.test:9787' } });

    expect(ok.statusCode).toBe(200);
    expect(bad.statusCode).toBe(403);
  });

  it('denies missing, wrong-scope, and revoked tokens', async () => {
    const { app, db } = guardedApp();
    const extension = createCapability(db, { kind: 'extension', scopes: ['snapshot:write'] });
    const ui = createCapability(db, { kind: 'ui', scopes: ['api:write'] });

    const missing = await app.inject({ method: 'POST', url: '/snapshot', headers: localHeaders });
    const wrongScope = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: { ...localHeaders, 'x-tab-atlas-token': extension.token },
    });
    revokeCapability(db, ui.capability.id);
    const revoked = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: { ...localHeaders, 'x-tab-atlas-token': ui.token },
    });

    expect(missing.statusCode).toBe(401);
    expect(wrongScope.statusCode).toBe(401);
    expect(revoked.statusCode).toBe(401);
  });

  it('allows extension snapshots but denies extension access to general APIs', async () => {
    const { app, db } = guardedApp();
    const extension = createCapability(db, { kind: 'extension', scopes: ['snapshot:write'] });

    const snapshot = await app.inject({
      method: 'POST',
      url: '/snapshot',
      headers: {
        ...localHeaders,
        origin: 'chrome-extension://abc',
        'x-tab-atlas-token': extension.token,
      },
    });
    const generalApi = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: {
        ...localHeaders,
        origin: 'chrome-extension://abc',
        'x-tab-atlas-token': extension.token,
      },
    });

    expect(snapshot.statusCode).toBe(200);
    expect(generalApi.statusCode).toBe(401);
  });

  it('pairs extensions with short-lived single-use snapshot tokens', async () => {
    const { app, db } = guardedApp();
    const admin = createCapability(db, { kind: 'ui', scopes: ['admin'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/security/pairing-codes',
      headers: { ...localHeaders, 'x-tab-atlas-token': admin.token },
      payload: { ttlMs: 60_000 },
    });
    const challenge = created.json() as { challenge: { id: string }; secret: string };

    const paired = await app.inject({
      method: 'POST',
      url: '/api/security/pairing-codes/exchange',
      headers: { ...localHeaders, origin: 'chrome-extension://abc' },
      payload: { challengeId: challenge.challenge.id, secret: challenge.secret },
    });
    const payload = paired.json() as { token: string; capability: { scopes: string[] } };
    const replay = await app.inject({
      method: 'POST',
      url: '/api/security/pairing-codes/exchange',
      headers: { ...localHeaders, origin: 'chrome-extension://abc' },
      payload: { challengeId: challenge.challenge.id, secret: challenge.secret },
    });
    const snapshot = await app.inject({
      method: 'POST',
      url: '/snapshot',
      headers: { ...localHeaders, 'x-tab-atlas-token': payload.token },
      payload: { capturedAt: '2026-06-18T00:00:00.000Z', tabs: [] },
    });
    const generalApi = await app.inject({
      method: 'POST',
      url: '/api/jobs/codex-scan',
      headers: { ...localHeaders, 'x-tab-atlas-token': payload.token },
    });

    expect(created.statusCode).toBe(200);
    expect(paired.statusCode).toBe(200);
    expect(payload.capability.scopes).toEqual(['snapshot:write']);
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    expect(snapshot.statusCode).toBe(200);
    expect(generalApi.statusCode).toBe(401);
    expect(JSON.stringify(db.prepare('SELECT * FROM snapshots').all())).not.toContain(payload.token);
  });

  it('locks pairing challenges after bounded wrong attempts', async () => {
    const { app, db } = guardedApp();
    const challenge = createPairingChallenge(db, { ttlMs: 60_000, maxAttempts: 2 });

    const first = await app.inject({
      method: 'POST',
      url: '/api/security/pairing-codes/exchange',
      headers: localHeaders,
      payload: { challengeId: challenge.challenge.id, secret: 'wrong' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/security/pairing-codes/exchange',
      headers: localHeaders,
      payload: { challengeId: challenge.challenge.id, secret: 'wrong-again' },
    });
    const row = db.prepare('SELECT status, attempts FROM pairing_challenges WHERE id = ?').get(challenge.challenge.id) as { status: string; attempts: number };

    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(row).toEqual({ status: 'locked', attempts: 2 });
  });

  it('rejects expired pairing challenges', async () => {
    const { app, db } = guardedApp();
    const expired = createPairingChallenge(db, { ttlMs: -1 });
    const response = await app.inject({
      method: 'POST',
      url: '/api/security/pairing-codes/exchange',
      headers: localHeaders,
      payload: { challengeId: expired.challenge.id, secret: expired.secret },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('denies cross-site mutation and writes a redacted audit row', async () => {
    const { app, db } = guardedApp();
    const admin = createCapability(db, { kind: 'ui', scopes: ['admin'] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: {
        ...localHeaders,
        origin: 'https://evil.test',
        'sec-fetch-site': 'cross-site',
        'x-tab-atlas-token': admin.token,
      },
    });
    const audit = db.prepare('SELECT reason, details_json FROM security_audit_events ORDER BY created_at DESC LIMIT 1').get() as {
      reason: string;
      details_json: string | null;
    };

    expect(response.statusCode).toBe(403);
    expect(audit.reason).toBe('cross_site_fetch');
    expect(JSON.stringify(audit)).not.toContain(admin.token);
  });
});
