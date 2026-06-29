import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_TITLES,
  OnboardingStepId,
  type OnboardingSnapshot,
  type OnboardingStep,
} from './contracts.js';
import { countActiveAdminCapabilities } from '../security/localCapability.js';
import { createLocalSession, countActiveDashboardSessions } from '../security/localSession.js';
import { hashSecret, type CapabilityScope } from '../security/localCapability.js';

export interface BootstrapSecretDescriptor {
  id: string;
  filePath: string;
  expiresAt: string;
  created: boolean;
}

const DASHBOARD_SCOPES: CapabilityScope[] = ['admin', 'api:read', 'api:write', 'jobs:write', 'agent:write'];

export function ensureBootstrapSecret(
  db: Database.Database,
  input: { directory: string; ttlMs?: number },
): BootstrapSecretDescriptor {
  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT id, file_path, expires_at
    FROM onboarding_bootstrap_secrets
    WHERE status = 'active' AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(now) as { id: string; file_path: string | null; expires_at: string } | undefined;
  if (existing?.file_path && fs.existsSync(existing.file_path)) {
    return { id: existing.id, filePath: existing.file_path, expiresAt: existing.expires_at, created: false };
  }

  fs.mkdirSync(input.directory, { recursive: true });
  const secret = `boot_${crypto.randomBytes(32).toString('base64url')}`;
  const id = `boot_${nanoid()}`;
  const filePath = path.join(input.directory, 'tabatlas-bootstrap-secret.txt');
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString();
  fs.writeFileSync(filePath, [
    'TabAtlas one-time bootstrap secret',
    '',
    'Paste this value into the local dashboard bootstrap screen.',
    'It is consumed once and then invalidated.',
    '',
    secret,
    '',
  ].join('\n'), { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows */ }
  db.prepare(`
    INSERT INTO onboarding_bootstrap_secrets (id, secret_hash, file_path, status, created_at, expires_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(id, hashSecret(secret), filePath, now, expiresAt);
  return { id, filePath, expiresAt, created: true };
}

export function consumeBootstrapSecret(
  db: Database.Database,
  secret: string,
): { token: string; sessionId: string; expiresAt: string } {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const row = db.prepare(`
      SELECT id, file_path, expires_at, status, consumed_at
      FROM onboarding_bootstrap_secrets
      WHERE secret_hash = ?
    `).get(hashSecret(secret.trim())) as { id: string; file_path: string | null; expires_at: string; status: string; consumed_at: string | null } | undefined;
    if (!row || row.status !== 'active' || row.consumed_at) throw new Error('invalid bootstrap secret');
    if (Date.parse(row.expires_at) <= Date.now()) {
      db.prepare(`UPDATE onboarding_bootstrap_secrets SET status = 'expired' WHERE id = ?`).run(row.id);
      throw new Error('expired bootstrap secret');
    }
    db.prepare(`
      UPDATE onboarding_bootstrap_secrets
      SET status = 'consumed', consumed_at = ?
      WHERE id = ? AND status = 'active' AND consumed_at IS NULL
    `).run(now, row.id);
    if (row.file_path) {
      try { fs.rmSync(row.file_path, { force: true }); } catch { /* best effort */ }
    }
    const session = createLocalSession(db, { scopes: DASHBOARD_SCOPES });
    completeOnboardingStep(db, 'dashboard_session_ready', { sessionId: session.session.id });
    return { token: session.token, sessionId: session.session.id, expiresAt: session.session.expiresAt };
  });
  return tx();
}

export function recoverAdminSession(
  db: Database.Database,
  secret: string,
): { token: string; sessionId: string; expiresAt: string } {
  if (countActiveAdminCapabilities(db) > 0 || countActiveDashboardSessions(db) > 0) {
    throw new Error('recovery is only available when no active admin authority remains');
  }
  return consumeBootstrapSecret(db, secret);
}

export function completeOnboardingStep(
  db: Database.Database,
  stepId: OnboardingStepId,
  data: Record<string, unknown> = {},
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO onboarding_state (step_id, status, data_json, completed_at, updated_at)
    VALUES (?, 'completed', ?, ?, ?)
    ON CONFLICT(step_id) DO UPDATE SET
      status = 'completed',
      data_json = excluded.data_json,
      completed_at = COALESCE(onboarding_state.completed_at, excluded.completed_at),
      updated_at = excluded.updated_at
  `).run(stepId, JSON.stringify(data), now, now);
}

export function getOnboardingSnapshot(db: Database.Database): OnboardingSnapshot {
  const explicit = new Map((db.prepare(`
    SELECT step_id, status, data_json, completed_at
    FROM onboarding_state
  `).all() as Array<{ step_id: OnboardingStepId; status: string; data_json: string; completed_at: string | null }>)
    .map(row => [row.step_id, row]));

  const computed = computeCompletedSteps(db);
  const steps: OnboardingStep[] = ONBOARDING_STEPS.map(id => {
    const row = explicit.get(id);
    const completed = row?.status === 'completed' || computed.has(id);
    return {
      id,
      title: ONBOARDING_STEP_TITLES[id],
      status: completed ? 'completed' : 'pending',
      completedAt: row?.completed_at ?? undefined,
      data: row ? parseRecord(row.data_json) : {},
    };
  });
  const next = steps.find(step => step.status !== 'completed');
  return {
    steps,
    nextStepId: next?.id,
    recoveryAvailable: countActiveAdminCapabilities(db) === 0 && countActiveDashboardSessions(db) === 0,
  };
}

function computeCompletedSteps(db: Database.Database): Set<OnboardingStepId> {
  const done = new Set<OnboardingStepId>(['receiver_running']);
  if ((process.env.TABATLAS_CAPTURE_ROOTS ?? '').trim()) done.add('capture_roots_configured');
  if (countActiveDashboardSessions(db) > 0) done.add('dashboard_session_ready');
  if ((db.prepare(`SELECT COUNT(*) AS count FROM snapshots`).get() as { count: number }).count > 0) done.add('snapshot_captured');
  if ((db.prepare(`SELECT COUNT(*) AS count FROM extraction_artifacts`).get() as { count: number }).count > 0) done.add('extraction_ready');
  if ((db.prepare(`SELECT COUNT(*) AS count FROM agent_runs`).get() as { count: number }).count > 0) done.add('codex_ready');
  if ((db.prepare(`SELECT COUNT(*) AS count FROM user_annotations`).get() as { count: number }).count > 0) done.add('first_review_completed');
  if ((db.prepare(`SELECT COUNT(*) AS count FROM views`).get() as { count: number }).count > 0) done.add('first_view_created');
  const extensionCaps = db.prepare(`
    SELECT COUNT(*) AS count
    FROM local_capabilities
    WHERE kind = 'extension' AND status = 'active'
  `).get() as { count: number };
  if (extensionCaps.count > 0) done.add('browsers_paired');
  return done;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
