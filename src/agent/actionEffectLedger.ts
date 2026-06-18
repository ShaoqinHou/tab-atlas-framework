import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';

export type ActionEffectKind =
  | 'annotation_write'
  | 'scan_job_create'
  | 'view_plan_create'
  | 'view_refinement_create'
  | 'view_accept'
  | 'review_decision';

export interface ActionEffectRecord {
  id: string;
  actionId: string;
  effectKind: ActionEffectKind;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  idempotencyKey: string;
  input: unknown;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  staleAfter?: string;
}

export type ActionEffectClaim =
  | { claimed: true; effect: ActionEffectRecord }
  | { claimed: false; effect: ActionEffectRecord };

export function claimActionEffect(
  db: Database.Database,
  input: {
    actionId: string;
    effectKind: ActionEffectKind;
    idempotencyKey?: string;
    effectInput?: unknown;
    staleMs?: number;
  },
): ActionEffectClaim {
  const key = input.idempotencyKey ?? `${input.actionId}:${input.effectKind}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const staleAfter = new Date(now.getTime() + (input.staleMs ?? 5 * 60 * 1000)).toISOString();
  const tx = db.transaction((): ActionEffectClaim => {
    db.prepare(`
      INSERT INTO action_effects
        (id, action_id, effect_kind, status, idempotency_key, input_json, created_at, updated_at, stale_after)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      `effect_${nanoid()}`,
      input.actionId,
      input.effectKind,
      key,
      JSON.stringify(input.effectInput ?? {}),
      nowIso,
      nowIso,
      staleAfter,
    );
    recoverStaleRunningEffects(db, nowIso);
    const before = getActionEffectByKey(db, key);
    if (before.status === 'succeeded' || before.status === 'cancelled') return { claimed: false, effect: before };
    const changed = db.prepare(`
      UPDATE action_effects
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?, stale_after = ?
      WHERE idempotency_key = ? AND status IN ('pending', 'failed')
    `).run(nowIso, nowIso, staleAfter, key).changes;
    return { claimed: changed === 1, effect: getActionEffectByKey(db, key) };
  });
  return tx();
}

export function completeActionEffect(
  db: Database.Database,
  idempotencyKey: string,
  result: unknown,
): ActionEffectRecord {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE action_effects
    SET status = 'succeeded', result_json = ?, error = NULL, updated_at = ?, completed_at = ?
    WHERE idempotency_key = ?
  `).run(JSON.stringify(result), now, now, idempotencyKey);
  return getActionEffectByKey(db, idempotencyKey);
}

export function failActionEffect(
  db: Database.Database,
  idempotencyKey: string,
  error: unknown,
): ActionEffectRecord {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE action_effects
    SET status = 'failed', error = ?, updated_at = ?
    WHERE idempotency_key = ?
  `).run(error instanceof Error ? error.message : String(error), now, idempotencyKey);
  return getActionEffectByKey(db, idempotencyKey);
}

export function cancelActionEffect(db: Database.Database, idempotencyKey: string): ActionEffectRecord {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE action_effects
    SET status = 'cancelled', updated_at = ?, completed_at = ?
    WHERE idempotency_key = ? AND status IN ('pending', 'running', 'failed')
  `).run(now, now, idempotencyKey);
  return getActionEffectByKey(db, idempotencyKey);
}

export function getActionEffectByKey(db: Database.Database, idempotencyKey: string): ActionEffectRecord {
  const row = db.prepare(`
    SELECT id, action_id, effect_kind, status, idempotency_key, input_json, result_json, error,
           created_at, updated_at, started_at, completed_at, stale_after
    FROM action_effects
    WHERE idempotency_key = ?
  `).get(idempotencyKey) as ActionEffectRow | undefined;
  if (!row) throw new Error(`Action effect not found: ${idempotencyKey}`);
  return effectFromRow(row);
}

export function recoverStaleRunningEffects(db: Database.Database, nowIso = new Date().toISOString()): number {
  return db.prepare(`
    UPDATE action_effects
    SET status = 'failed', error = COALESCE(error, 'stale running effect recovered'), updated_at = ?
    WHERE status = 'running' AND stale_after IS NOT NULL AND stale_after <= ?
  `).run(nowIso, nowIso).changes;
}

type ActionEffectRow = {
  id: string;
  action_id: string;
  effect_kind: ActionEffectKind;
  status: ActionEffectRecord['status'];
  idempotency_key: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  stale_after: string | null;
};

function effectFromRow(row: ActionEffectRow): ActionEffectRecord {
  return {
    id: row.id,
    actionId: row.action_id,
    effectKind: row.effect_kind,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    input: parseJson(row.input_json) ?? {},
    result: row.result_json ? parseJson(row.result_json) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    staleAfter: row.stale_after ?? undefined,
  };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
