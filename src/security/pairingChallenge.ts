import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import {
  createCapability,
  hashSecret,
  type CapabilityKind,
  type CapabilityRecord,
  type CapabilityScope,
} from './localCapability.js';

export interface PairingChallengeRecord {
  id: string;
  kind: CapabilityKind;
  browser: string;
  label?: string;
  scopes: CapabilityScope[];
  status: 'pending' | 'used' | 'expired' | 'locked' | 'revoked';
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  lockedAt?: string;
  capabilityId?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface PairingChallengeCreateResult {
  challenge: PairingChallengeRecord;
  secret: string;
}

export interface PairingChallengeExchangeResult {
  challenge: PairingChallengeRecord;
  capability: CapabilityRecord;
  token: string;
}

export type PairingExchangeFailure =
  | 'missing_challenge'
  | 'global_rate_limited'
  | 'invalid_challenge'
  | 'expired_challenge'
  | 'locked_challenge'
  | 'used_challenge'
  | 'revoked_challenge'
  | 'invalid_secret';

export class PairingChallengeError extends Error {
  constructor(readonly reason: PairingExchangeFailure) {
    super(reason);
  }
}

export function createPairingChallenge(
  db: Database.Database,
  input: {
    kind?: CapabilityKind;
    scopes?: CapabilityScope[];
    browser?: string;
    label?: string;
    ttlMs?: number;
    maxAttempts?: number;
  } = {},
): PairingChallengeCreateResult {
  const now = new Date().toISOString();
  const secret = generatePairingSecret();
  const id = `pair_${nanoid()}`;
  const scopes = normalizeScopes(input.scopes ?? ['snapshot:write']);
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 5 * 60 * 1000)).toISOString();
  db.prepare(`
    INSERT INTO pairing_challenges
      (id, secret_hash, kind, browser, label, scopes_json, status, attempts, max_attempts, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    id,
    hashSecret(secret),
    input.kind ?? 'extension',
    normalizeBrowser(input.browser),
    input.label ?? null,
    JSON.stringify(scopes),
    Math.max(1, Math.min(20, input.maxAttempts ?? 5)),
    now,
    expiresAt,
  );
  return { challenge: getPairingChallenge(db, id), secret };
}

export function exchangePairingChallenge(
  db: Database.Database,
  input: {
    challengeId: string;
    secret: string;
    label?: string;
    browser?: string;
    throttleKey?: string;
  },
): PairingChallengeExchangeResult {
  const now = new Date().toISOString();
  assertGlobalExchangeAllowed(db, input.throttleKey ?? 'local', now);
  const row = db.prepare(`
    SELECT id, secret_hash, kind, browser, label, scopes_json, status, attempts, max_attempts, created_at, expires_at,
           used_at, locked_at, capability_id, last_attempt_at, last_error
    FROM pairing_challenges
    WHERE id = ?
  `).get(input.challengeId) as PairingChallengeRow | undefined;
  if (!row) throw new PairingChallengeError('invalid_challenge');
  const challenge = challengeFromRow(row);
  if (challenge.status === 'used') throw new PairingChallengeError('used_challenge');
  if (challenge.status === 'locked') throw new PairingChallengeError('locked_challenge');
  if (challenge.status === 'revoked') throw new PairingChallengeError('revoked_challenge');
  if (challenge.status !== 'pending') throw new PairingChallengeError('invalid_challenge');
  if (Date.parse(challenge.expiresAt) <= Date.now()) {
    markChallenge(db, challenge.id, 'expired', now, 'expired_challenge');
    throw new PairingChallengeError('expired_challenge');
  }

  const attempts = challenge.attempts + 1;
  const hashMatches = hashSecret(input.secret.trim()) === row.secret_hash;
  if (!hashMatches) {
    const locked = attempts >= challenge.maxAttempts;
    db.prepare(`
      UPDATE pairing_challenges
      SET attempts = ?,
          status = CASE WHEN ? THEN 'locked' ELSE status END,
          locked_at = CASE WHEN ? THEN ? ELSE locked_at END,
          last_attempt_at = ?,
          last_error = 'invalid_secret'
      WHERE id = ?
    `).run(attempts, locked ? 1 : 0, locked ? 1 : 0, now, now, challenge.id);
    throw new PairingChallengeError(locked ? 'locked_challenge' : 'invalid_secret');
  }

  const tx = db.transaction(() => {
    const capability = createCapability(db, {
      kind: challenge.kind,
      scopes: challenge.scopes,
      label: input.label ?? `${normalizeBrowser(input.browser ?? challenge.browser)} extension`,
    });
    db.prepare(`
      UPDATE pairing_challenges
      SET attempts = ?,
          status = 'used',
          used_at = ?,
          capability_id = ?,
          last_attempt_at = ?,
          last_error = NULL
      WHERE id = ? AND status = 'pending'
    `).run(attempts, now, capability.capability.id, now, challenge.id);
    return {
      challenge: getPairingChallenge(db, challenge.id),
      capability: capability.capability,
      token: capability.token,
    };
  });
  return tx();
}

export function revokePairingChallenge(db: Database.Database, id: string): PairingChallengeRecord {
  markChallenge(db, id, 'revoked', new Date().toISOString(), 'revoked');
  return getPairingChallenge(db, id);
}

export function listPairingChallenges(db: Database.Database, limit = 20): PairingChallengeRecord[] {
  const rows = db.prepare(`
    SELECT id, kind, browser, label, scopes_json, status, attempts, max_attempts, created_at, expires_at,
           used_at, locked_at, capability_id, last_attempt_at, last_error
    FROM pairing_challenges
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as PairingChallengeListRow[];
  return rows.map(challengeFromRow);
}

export function getPairingChallenge(db: Database.Database, id: string): PairingChallengeRecord {
  const row = db.prepare(`
    SELECT id, kind, browser, label, scopes_json, status, attempts, max_attempts, created_at, expires_at,
           used_at, locked_at, capability_id, last_attempt_at, last_error
    FROM pairing_challenges
    WHERE id = ?
  `).get(id) as PairingChallengeListRow | undefined;
  if (!row) throw new Error(`Pairing challenge not found: ${id}`);
  return challengeFromRow(row);
}

function assertGlobalExchangeAllowed(db: Database.Database, bucketKey: string, nowIso: string): void {
  const windowMs = 60_000;
  const maxAttempts = 30;
  const nowMs = Date.parse(nowIso);
  const row = db.prepare(`
    SELECT bucket_key, window_started_at, attempts, locked_until
    FROM pairing_exchange_limits
    WHERE bucket_key = ?
  `).get(bucketKey) as { window_started_at: string; attempts: number; locked_until: string | null } | undefined;
  if (row?.locked_until && Date.parse(row.locked_until) > nowMs) {
    throw new PairingChallengeError('global_rate_limited');
  }
  if (!row || Date.parse(row.window_started_at) + windowMs <= nowMs) {
    db.prepare(`
      INSERT INTO pairing_exchange_limits (bucket_key, window_started_at, attempts, locked_until)
      VALUES (?, ?, 1, NULL)
      ON CONFLICT(bucket_key) DO UPDATE SET window_started_at = excluded.window_started_at, attempts = 1, locked_until = NULL
    `).run(bucketKey, nowIso);
    return;
  }
  const attempts = row.attempts + 1;
  const lockedUntil = attempts > maxAttempts ? new Date(nowMs + windowMs).toISOString() : null;
  db.prepare(`
    UPDATE pairing_exchange_limits
    SET attempts = ?, locked_until = ?
    WHERE bucket_key = ?
  `).run(attempts, lockedUntil, bucketKey);
  if (lockedUntil) throw new PairingChallengeError('global_rate_limited');
}

function markChallenge(
  db: Database.Database,
  id: string,
  status: PairingChallengeRecord['status'],
  now: string,
  error: string,
): void {
  db.prepare(`
    UPDATE pairing_challenges
    SET status = ?,
        locked_at = CASE WHEN ? = 'locked' THEN ? ELSE locked_at END,
        last_attempt_at = ?,
        last_error = ?
    WHERE id = ?
  `).run(status, status, now, now, error, id);
}

function generatePairingSecret(): string {
  const raw = crypto.randomBytes(16).toString('base64url').toUpperCase();
  return `TA-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16)}`;
}

function normalizeScopes(scopes: CapabilityScope[]): CapabilityScope[] {
  return [...new Set(scopes)];
}

function normalizeBrowser(value: unknown): string {
  return value === 'chrome' || value === 'edge' ? value : 'unknown';
}

type PairingChallengeRow = PairingChallengeListRow & {
  secret_hash: string;
};

type PairingChallengeListRow = {
  id: string;
  kind: CapabilityKind;
  browser: string;
  label: string | null;
  scopes_json: string;
  status: PairingChallengeRecord['status'];
  attempts: number;
  max_attempts: number;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  locked_at: string | null;
  capability_id: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
};

function challengeFromRow(row: PairingChallengeListRow): PairingChallengeRecord {
  return {
    id: row.id,
    kind: row.kind,
    browser: row.browser,
    label: row.label ?? undefined,
    scopes: parseScopes(row.scopes_json),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? undefined,
    lockedAt: row.locked_at ?? undefined,
    capabilityId: row.capability_id ?? undefined,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

function parseScopes(value: string): CapabilityScope[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is CapabilityScope => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
