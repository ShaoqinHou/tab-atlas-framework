import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';

export const CapabilityKinds = ['ui', 'extension', 'automation'] as const;
export type CapabilityKind = typeof CapabilityKinds[number];

export const CapabilityScopes = [
  'snapshot:write',
  'api:read',
  'api:write',
  'jobs:write',
  'agent:write',
  'admin',
] as const;
export type CapabilityScope = typeof CapabilityScopes[number];

export interface CapabilityRecord {
  id: string;
  kind: CapabilityKind;
  label?: string;
  scopes: CapabilityScope[];
  status: 'active' | 'revoked';
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface PairingCodeRecord {
  id: string;
  kind: CapabilityKind;
  scopes: CapabilityScope[];
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  capabilityId?: string;
}

export type CapabilityVerification =
  | { ok: true; capability: CapabilityRecord }
  | { ok: false; reason: 'missing_token' | 'invalid_token' | 'revoked_token' | 'expired_token' | 'insufficient_scope' };

export function createCapability(
  db: Database.Database,
  input: {
    kind: CapabilityKind;
    scopes: CapabilityScope[];
    label?: string;
    expiresAt?: string;
  },
): { capability: CapabilityRecord; token: string } {
  validateKind(input.kind);
  const scopes = normalizeScopes(input.scopes);
  const token = generateSecret('ta');
  const id = `cap_${nanoid()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO local_capabilities
      (id, kind, label, token_hash, scopes_json, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, input.kind, input.label ?? null, hashSecret(token), JSON.stringify(scopes), now, input.expiresAt ?? null);
  return { capability: getCapability(db, id), token };
}

export function listCapabilities(db: Database.Database): CapabilityRecord[] {
  const rows = db.prepare(`
    SELECT id, kind, label, scopes_json, status, created_at, expires_at, last_used_at, revoked_at
    FROM local_capabilities
    ORDER BY created_at DESC
  `).all() as CapabilityRow[];
  return rows.map(capabilityFromRow);
}

export function getCapability(db: Database.Database, id: string): CapabilityRecord {
  const row = db.prepare(`
    SELECT id, kind, label, scopes_json, status, created_at, expires_at, last_used_at, revoked_at
    FROM local_capabilities
    WHERE id = ?
  `).get(id) as CapabilityRow | undefined;
  if (!row) throw new Error(`Capability not found: ${id}`);
  return capabilityFromRow(row);
}

export function revokeCapability(db: Database.Database, id: string): CapabilityRecord {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE local_capabilities
    SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
    WHERE id = ?
  `).run(now, id);
  return getCapability(db, id);
}

export function rotateCapability(db: Database.Database, id: string): { capability: CapabilityRecord; token: string } {
  const token = generateSecret('ta');
  db.prepare(`
    UPDATE local_capabilities
    SET token_hash = ?, status = 'active', revoked_at = NULL
    WHERE id = ?
  `).run(hashSecret(token), id);
  return { capability: getCapability(db, id), token };
}

export function verifyCapabilityToken(
  db: Database.Database,
  token: string | undefined,
  requiredScope: CapabilityScope,
): CapabilityVerification {
  if (!token) return { ok: false, reason: 'missing_token' };
  const row = db.prepare(`
    SELECT id, kind, label, scopes_json, status, created_at, expires_at, last_used_at, revoked_at
    FROM local_capabilities
    WHERE token_hash = ?
  `).get(hashSecret(token)) as CapabilityRow | undefined;
  if (!row) return { ok: false, reason: 'invalid_token' };
  const capability = capabilityFromRow(row);
  if (capability.status !== 'active') return { ok: false, reason: 'revoked_token' };
  if (capability.expiresAt && Date.parse(capability.expiresAt) <= Date.now()) {
    return { ok: false, reason: 'expired_token' };
  }
  if (!hasScope(capability.scopes, requiredScope)) return { ok: false, reason: 'insufficient_scope' };
  db.prepare('UPDATE local_capabilities SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), capability.id);
  return { ok: true, capability: getCapability(db, capability.id) };
}

export function createPairingCode(
  db: Database.Database,
  input: {
    kind?: CapabilityKind;
    scopes?: CapabilityScope[];
    ttlMs?: number;
  } = {},
): { pairing: PairingCodeRecord; code: string } {
  const kind = input.kind ?? 'extension';
  validateKind(kind);
  const scopes = normalizeScopes(input.scopes ?? ['snapshot:write']);
  const code = generatePairingCode();
  const id = `pair_${nanoid()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 5 * 60 * 1000)).toISOString();
  db.prepare(`
    INSERT INTO local_pairing_codes
      (id, code_hash, kind, scopes_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, hashSecret(code), kind, JSON.stringify(scopes), now, expiresAt);
  return { pairing: getPairingCode(db, id), code };
}

export function exchangePairingCode(
  db: Database.Database,
  code: string,
  label = 'Browser extension',
): { capability: CapabilityRecord; token: string } {
  const tx = db.transaction(() => {
    const row = db.prepare(`
      SELECT id, kind, scopes_json, created_at, expires_at, used_at, capability_id
      FROM local_pairing_codes
      WHERE code_hash = ?
    `).get(hashSecret(code)) as PairingRow | undefined;
    if (!row) throw new Error('Invalid pairing code');
    const pairing = pairingFromRow(row);
    if (pairing.usedAt) throw new Error('Pairing code already used');
    if (Date.parse(pairing.expiresAt) <= Date.now()) throw new Error('Pairing code expired');
    const created = createCapability(db, {
      kind: pairing.kind,
      scopes: pairing.scopes,
      label,
    });
    db.prepare(`
      UPDATE local_pairing_codes
      SET used_at = ?, capability_id = ?
      WHERE id = ? AND used_at IS NULL
    `).run(new Date().toISOString(), created.capability.id, pairing.id);
    return created;
  });
  return tx();
}

export function listPairingCodes(db: Database.Database): PairingCodeRecord[] {
  const rows = db.prepare(`
    SELECT id, kind, scopes_json, created_at, expires_at, used_at, capability_id
    FROM local_pairing_codes
    ORDER BY created_at DESC
  `).all() as PairingRow[];
  return rows.map(pairingFromRow);
}

export function getPairingCode(db: Database.Database, id: string): PairingCodeRecord {
  const row = db.prepare(`
    SELECT id, kind, scopes_json, created_at, expires_at, used_at, capability_id
    FROM local_pairing_codes
    WHERE id = ?
  `).get(id) as PairingRow | undefined;
  if (!row) throw new Error(`Pairing code not found: ${id}`);
  return pairingFromRow(row);
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function hasScope(scopes: CapabilityScope[], required: CapabilityScope): boolean {
  return scopes.includes('admin') || scopes.includes(required);
}

function generateSecret(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function generatePairingCode(): string {
  const raw = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  return `${raw.slice(0, 3)}-${raw.slice(3)}`;
}

function normalizeScopes(scopes: CapabilityScope[]): CapabilityScope[] {
  const normalized = [...new Set(scopes)];
  for (const scope of normalized) {
    if (!CapabilityScopes.includes(scope)) throw new Error(`Unsupported capability scope: ${scope}`);
  }
  return normalized;
}

function validateKind(kind: CapabilityKind): void {
  if (!CapabilityKinds.includes(kind)) throw new Error(`Unsupported capability kind: ${kind}`);
}

type CapabilityRow = {
  id: string;
  kind: CapabilityKind;
  label: string | null;
  scopes_json: string;
  status: 'active' | 'revoked';
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

type PairingRow = {
  id: string;
  kind: CapabilityKind;
  scopes_json: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  capability_id: string | null;
};

function capabilityFromRow(row: CapabilityRow): CapabilityRecord {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label ?? undefined,
    scopes: parseScopes(row.scopes_json),
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function pairingFromRow(row: PairingRow): PairingCodeRecord {
  return {
    id: row.id,
    kind: row.kind,
    scopes: parseScopes(row.scopes_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? undefined,
    capabilityId: row.capability_id ?? undefined,
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
