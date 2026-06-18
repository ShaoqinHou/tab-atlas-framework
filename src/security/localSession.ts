import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { CapabilityScopes, hashSecret, type CapabilityScope } from './localCapability.js';

export const DASHBOARD_SESSION_COOKIE = 'tabatlas_session';

export interface LocalSessionRecord {
  id: string;
  kind: 'dashboard';
  scopes: CapabilityScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export type LocalSessionVerification =
  | { ok: true; session: LocalSessionRecord }
  | { ok: false; reason: 'missing_token' | 'invalid_token' | 'revoked_token' | 'expired_token' | 'insufficient_scope' };

export function createLocalSession(
  db: Database.Database,
  input: { scopes: CapabilityScope[]; ttlMs?: number },
): { session: LocalSessionRecord; token: string } {
  const token = `tas_${crypto.randomBytes(32).toString('base64url')}`;
  const id = `session_${nanoid()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString();
  const scopes = normalizeScopes(input.scopes);
  db.prepare(`
    INSERT INTO local_sessions (id, token_hash, kind, scopes_json, created_at, expires_at)
    VALUES (?, ?, 'dashboard', ?, ?, ?)
  `).run(id, hashSecret(token), JSON.stringify(scopes), now, expiresAt);
  return { session: getLocalSession(db, id), token };
}

export function verifyLocalSessionToken(
  db: Database.Database,
  token: string | undefined,
  requiredScope: CapabilityScope,
): LocalSessionVerification {
  if (!token) return { ok: false, reason: 'missing_token' };
  const row = db.prepare(`
    SELECT id, kind, scopes_json, created_at, expires_at, last_used_at, revoked_at
    FROM local_sessions
    WHERE token_hash = ?
  `).get(hashSecret(token)) as LocalSessionRow | undefined;
  if (!row) return { ok: false, reason: 'invalid_token' };
  const session = sessionFromRow(row);
  if (session.revokedAt) return { ok: false, reason: 'revoked_token' };
  if (Date.parse(session.expiresAt) <= Date.now()) return { ok: false, reason: 'expired_token' };
  if (!hasScope(session.scopes, requiredScope)) return { ok: false, reason: 'insufficient_scope' };
  db.prepare('UPDATE local_sessions SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
  return { ok: true, session: getLocalSession(db, session.id) };
}

export function getLocalSession(db: Database.Database, id: string): LocalSessionRecord {
  const row = db.prepare(`
    SELECT id, kind, scopes_json, created_at, expires_at, last_used_at, revoked_at
    FROM local_sessions
    WHERE id = ?
  `).get(id) as LocalSessionRow | undefined;
  if (!row) throw new Error(`Local session not found: ${id}`);
  return sessionFromRow(row);
}

export function countActiveDashboardSessions(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM local_sessions
    WHERE kind = 'dashboard'
      AND revoked_at IS NULL
      AND expires_at > ?
  `).get(new Date().toISOString()) as { count: number };
  return row.count;
}

export function readSessionTokenFromCookie(cookieHeader: unknown): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined;
  const cookies = cookieHeader.split(';').map(item => item.trim());
  const prefix = `${DASHBOARD_SESSION_COOKIE}=`;
  const raw = cookies.find(item => item.startsWith(prefix));
  return raw ? decodeURIComponent(raw.slice(prefix.length)) : undefined;
}

export function sessionCookie(token: string, maxAgeSeconds = 24 * 60 * 60): string {
  return `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function hasScope(scopes: CapabilityScope[], required: CapabilityScope): boolean {
  return scopes.includes('admin') || scopes.includes(required);
}

function normalizeScopes(scopes: CapabilityScope[]): CapabilityScope[] {
  const normalized = [...new Set(scopes)];
  for (const scope of normalized) {
    if (!CapabilityScopes.includes(scope)) throw new Error(`Unsupported session scope: ${scope}`);
  }
  return normalized;
}

type LocalSessionRow = {
  id: string;
  kind: 'dashboard';
  scopes_json: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

function sessionFromRow(row: LocalSessionRow): LocalSessionRecord {
  return {
    id: row.id,
    kind: row.kind,
    scopes: parseScopes(row.scopes_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function parseScopes(value: string): CapabilityScope[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is CapabilityScope => CapabilityScopes.includes(item))
      : [];
  } catch {
    return [];
  }
}
