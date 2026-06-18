import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import {
  completeOnboardingStep,
  consumeBootstrapSecret,
  ensureBootstrapSecret,
  getOnboardingSnapshot,
  recoverAdminSession,
} from '../src/onboarding/service.js';
import { installLocalRequestGuard } from '../src/security/localRequestGuard.js';
import { sessionCookie } from '../src/security/localSession.js';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-onboarding-'));
  const dbPath = path.join(base, 'tabatlas.sqlite');
  const secrets = path.join(base, 'secrets');
  const db = openDatabase(dbPath);
  return { base, dbPath, secrets, db };
}

describe('guided first-run onboarding', () => {
  it('creates a restrictive one-time bootstrap file and stores only a hash', () => {
    const fx = fixture();
    const bootstrap = ensureBootstrapSecret(fx.db, { directory: fx.secrets });
    const fileText = fs.readFileSync(bootstrap.filePath, 'utf8');
    const secret = fileText.split(/\r?\n/).find(line => line.startsWith('boot_')) ?? '';
    const rowsJson = JSON.stringify(fx.db.prepare('SELECT * FROM onboarding_bootstrap_secrets').all());

    expect(secret).toMatch(/^boot_/);
    expect(rowsJson).not.toContain(secret);
    expect(fs.statSync(bootstrap.filePath).isFile()).toBe(true);

    cleanup(fx);
  });

  it('consumes bootstrap once and rejects replay', () => {
    const fx = fixture();
    const bootstrap = ensureBootstrapSecret(fx.db, { directory: fx.secrets });
    const secret = readBootstrapSecret(bootstrap.filePath);
    const first = consumeBootstrapSecret(fx.db, secret);

    expect(first.token).toMatch(/^tas_/);
    expect(fs.existsSync(bootstrap.filePath)).toBe(false);
    expect(() => consumeBootstrapSecret(fx.db, secret)).toThrow(/invalid bootstrap secret/);

    cleanup(fx);
  });

  it('session cookie authorizes dashboard API without exposing a bearer token', async () => {
    const fx = fixture();
    const bootstrap = ensureBootstrapSecret(fx.db, { directory: fx.secrets });
    const session = consumeBootstrapSecret(fx.db, readBootstrapSecret(bootstrap.filePath));
    const app = Fastify();
    installLocalRequestGuard(app, fx.db, { host: '127.0.0.1', port: 9787 });
    app.get('/api/status', async () => ({ ok: true }));

    const missing = await app.inject({ method: 'GET', url: '/api/status', headers: { host: '127.0.0.1:9787' } });
    const authed = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: '127.0.0.1:9787', cookie: sessionCookie(session.token) },
    });

    expect(missing.statusCode).toBe(401);
    expect(authed.statusCode).toBe(200);
    await app.close();
    cleanup(fx);
  });

  it('completed onboarding steps survive database restart', () => {
    const fx = fixture();
    completeOnboardingStep(fx.db, 'capture_roots_configured', { roots: ['C:/captures'] });
    fx.db.close();

    const reopened = openDatabase(fx.dbPath);
    const snapshot = getOnboardingSnapshot(reopened);

    expect(snapshot.steps.find(step => step.id === 'capture_roots_configured')?.status).toBe('completed');
    reopened.close();
    cleanup({ ...fx, db: reopened });
  });

  it('recovery is explicit when no active admin authority remains', () => {
    const fx = fixture();
    const first = ensureBootstrapSecret(fx.db, { directory: fx.secrets });
    const session = consumeBootstrapSecret(fx.db, readBootstrapSecret(first.filePath));
    fx.db.prepare(`UPDATE local_sessions SET revoked_at = ? WHERE id = ?`).run(new Date().toISOString(), session.sessionId);
    const recovery = ensureBootstrapSecret(fx.db, { directory: fx.secrets });
    const recovered = recoverAdminSession(fx.db, readBootstrapSecret(recovery.filePath));

    expect(recovered.token).toMatch(/^tas_/);
    expect(getOnboardingSnapshot(fx.db).recoveryAvailable).toBe(false);
    cleanup(fx);
  });
});

function readBootstrapSecret(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).find(line => line.startsWith('boot_')) ?? '';
}

function cleanup(fx: { base: string; db: ReturnType<typeof openDatabase> }): void {
  fx.db.close();
  fs.rmSync(fx.base, { recursive: true, force: true });
}
