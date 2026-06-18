import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
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

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

const results: EvalResult[] = [];
results.push(bootstrapSingleUse());
results.push(await sessionCookieAuthorizesDashboard());
results.push(onboardingSurvivesRestart());
results.push(recoveryWhenAdminAuthorityLost());

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Onboarding evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Onboarding evaluation passed: ${results.length}/${results.length} cases.`);

function bootstrapSingleUse(): EvalResult {
  const fx = fixture();
  try {
    const boot = ensureBootstrapSecret(fx.db, { directory: fx.secrets });
    const secret = readBootstrapSecret(boot.filePath);
    const first = consumeBootstrapSecret(fx.db, secret);
    let replay = 'unexpected-success';
    try { consumeBootstrapSecret(fx.db, secret); } catch (error) { replay = error instanceof Error ? error.message : String(error); }
    const dbRows = JSON.stringify(fx.db.prepare('SELECT * FROM onboarding_bootstrap_secrets').all());
    return result(
      'Bootstrap single use',
      'secret creates one session, replay fails, plaintext is not stored',
      `session=${first.sessionId}; replay=${replay}; plaintextStored=${dbRows.includes(secret)}`,
      first.token.startsWith('tas_') && replay.includes('invalid') && !dbRows.includes(secret),
    );
  } finally {
    cleanup(fx);
  }
}

async function sessionCookieAuthorizesDashboard(): Promise<EvalResult> {
  const fx = fixture();
  const app = Fastify();
  try {
    const boot = ensureBootstrapSecret(fx.db, { directory: fx.secrets });
    const session = consumeBootstrapSecret(fx.db, readBootstrapSecret(boot.filePath));
    installLocalRequestGuard(app, fx.db, { host: '127.0.0.1', port: 9787 });
    app.get('/api/status', async () => ({ ok: true }));
    const missing = await app.inject({ method: 'GET', url: '/api/status', headers: { host: '127.0.0.1:9787' } });
    const authed = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: '127.0.0.1:9787', cookie: sessionCookie(session.token) },
    });
    return result(
      'Dashboard session cookie auth',
      'API denies missing authority and accepts HttpOnly local session cookie',
      `missing=${missing.statusCode}; authed=${authed.statusCode}`,
      missing.statusCode === 401 && authed.statusCode === 200,
    );
  } finally {
    await app.close();
    cleanup(fx);
  }
}

function onboardingSurvivesRestart(): EvalResult {
  const fx = fixture();
  completeOnboardingStep(fx.db, 'first_review_completed', { resourceId: 'res_1' });
  fx.db.close();
  const reopened = openDatabase(fx.dbPath);
  try {
    const snapshot = getOnboardingSnapshot(reopened);
    const step = snapshot.steps.find(item => item.id === 'first_review_completed');
    return result(
      'Completed setup survives restart',
      'completed onboarding step is read after reopening SQLite',
      `status=${step?.status ?? '(missing)'}`,
      step?.status === 'completed',
    );
  } finally {
    cleanup({ ...fx, db: reopened });
  }
}

function recoveryWhenAdminAuthorityLost(): EvalResult {
  const fx = fixture();
  try {
    const boot = ensureBootstrapSecret(fx.db, { directory: fx.secrets });
    const session = consumeBootstrapSecret(fx.db, readBootstrapSecret(boot.filePath));
    fx.db.prepare(`UPDATE local_sessions SET revoked_at = ? WHERE id = ?`).run(new Date().toISOString(), session.sessionId);
    const recovery = ensureBootstrapSecret(fx.db, { directory: fx.secrets });
    const recovered = recoverAdminSession(fx.db, readBootstrapSecret(recovery.filePath));
    return result(
      'Explicit admin recovery',
      'new bootstrap secret recovers a dashboard session after all admin authority is lost',
      `session=${recovered.sessionId}; recoveryAvailable=${getOnboardingSnapshot(fx.db).recoveryAvailable}`,
      recovered.token.startsWith('tas_') && !getOnboardingSnapshot(fx.db).recoveryAvailable,
    );
  } finally {
    cleanup(fx);
  }
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-onboarding-eval-'));
  const dbPath = path.join(base, 'tabatlas.sqlite');
  const secrets = path.join(base, 'secrets');
  return { base, dbPath, secrets, db: openDatabase(dbPath) };
}

function readBootstrapSecret(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).find(line => line.startsWith('boot_')) ?? '';
}

function cleanup(fx: { base: string; db: ReturnType<typeof openDatabase> }): void {
  fx.db.close();
  fs.rmSync(fx.base, { recursive: true, force: true });
}

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}
