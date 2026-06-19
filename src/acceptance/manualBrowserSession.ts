import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createPairingChallenge } from '../security/pairingChallenge.js';

export const ProductBrowser = z.enum(['chrome', 'edge']);
export type ProductBrowser = z.infer<typeof ProductBrowser>;

export const ManualBrowserAcceptanceStatus = z.enum([
  'created',
  'challenge_issued',
  'paired',
  'snapshot_received',
  'revoked',
  'revocation_observed',
  'passed',
  'failed',
  'expired',
  'cancelled',
]);
export type ManualBrowserAcceptanceStatus = z.infer<typeof ManualBrowserAcceptanceStatus>;

export interface ManualBrowserAcceptanceRecord {
  id: string;
  browser: ProductBrowser;
  status: ManualBrowserAcceptanceStatus;
  receiverUrl: string;
  challengeId?: string;
  capabilityId?: string;
  baselineSnapshotCount: number;
  pairedAt?: string;
  snapshotId?: string;
  snapshotObservedAt?: string;
  revokedAt?: string;
  revocationObservedAt?: string;
  popupOpenedConfirmedAt?: string;
  tokenAbsentVerifiedAt?: string;
  failureCode?: string;
  failureSummary?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Starts a manual Chrome/Edge acceptance session. The secret is returned once
 * to the local operator and is never stored in the session or acceptance report.
 */
export function createManualBrowserAcceptanceSession(
  db: Database.Database,
  input: {
    browser: ProductBrowser;
    receiverUrl: string;
    ttlMs?: number;
  },
): { session: ManualBrowserAcceptanceRecord; challengeSecret: string } {
  const browser = ProductBrowser.parse(input.browser);
  const now = new Date().toISOString();
  const id = `browser_accept_${nanoid()}`;
  const baselineSnapshotCount = snapshotCount(db);
  const challenge = createPairingChallenge(db, {
    kind: 'extension',
    scopes: ['snapshot:write'],
    browser,
    label: `${browser} manual acceptance`,
    ttlMs: input.ttlMs ?? 15 * 60_000,
    maxAttempts: 5,
  });
  db.prepare(`
    INSERT INTO manual_browser_acceptance_sessions
      (id, browser, status, receiver_url, challenge_id, baseline_snapshot_count, created_at, updated_at)
    VALUES (?, ?, 'challenge_issued', ?, ?, ?, ?, ?)
  `).run(id, browser, input.receiverUrl, challenge.challenge.id, baselineSnapshotCount, now, now);
  return {
    session: getManualBrowserAcceptanceSession(db, id),
    challengeSecret: challenge.secret,
  };
}

export function getManualBrowserAcceptanceSession(
  db: Database.Database,
  sessionId: string,
): ManualBrowserAcceptanceRecord {
  const row = db.prepare(`
    SELECT id, browser, status, receiver_url, challenge_id, capability_id,
           baseline_snapshot_count, paired_at, snapshot_id, snapshot_observed_at,
           revoked_at, revocation_observed_at, popup_opened_confirmed_at,
           token_absent_verified_at, failure_code, failure_summary, created_at, updated_at
    FROM manual_browser_acceptance_sessions
    WHERE id = ?
  `).get(sessionId) as ManualBrowserAcceptanceRow | undefined;
  if (!row) throw new Error(`Manual browser acceptance session not found: ${sessionId}`);
  return fromRow(row);
}

/**
 * Refreshes acceptance state from server-side evidence only. It never trusts
 * a hand-edited pass flag for pairing, snapshot arrival, or revocation.
 */
export function refreshManualBrowserAcceptanceEvidence(
  db: Database.Database,
  sessionId: string,
): ManualBrowserAcceptanceRecord {
  const session = getManualBrowserAcceptanceSession(db, sessionId);
  const challenge = session.challengeId
    ? db.prepare(`
        SELECT status, capability_id, used_at, expires_at
        FROM pairing_challenges
        WHERE id = ?
      `).get(session.challengeId) as {
        status: string;
        capability_id: string | null;
        used_at: string | null;
        expires_at: string;
      } | undefined
    : undefined;

  const now = new Date().toISOString();
  if (!challenge) return failSession(db, sessionId, 'challenge_missing', 'Pairing challenge no longer exists.');
  if (challenge.status === 'expired' || Date.parse(challenge.expires_at) <= Date.now()) {
    updateSession(db, sessionId, { status: 'expired', updatedAt: now });
    return getManualBrowserAcceptanceSession(db, sessionId);
  }

  if (challenge.capability_id && !session.capabilityId) {
    updateSession(db, sessionId, {
      status: 'paired',
      capabilityId: challenge.capability_id,
      pairedAt: challenge.used_at ?? now,
      updatedAt: now,
    });
  }

  const current = getManualBrowserAcceptanceSession(db, sessionId);
  const snapshot = latestSnapshotAfterBaseline(db, current.baselineSnapshotCount, current.browser);
  if (snapshot && !current.snapshotId) {
    updateSession(db, sessionId, {
      status: 'snapshot_received',
      snapshotId: snapshot.id,
      snapshotObservedAt: now,
      updatedAt: now,
    });
  }

  const afterSnapshot = getManualBrowserAcceptanceSession(db, sessionId);
  if (afterSnapshot.capabilityId) {
    const capability = db.prepare(`
      SELECT status, revoked_at
      FROM local_capabilities
      WHERE id = ?
    `).get(afterSnapshot.capabilityId) as { status: string; revoked_at: string | null } | undefined;
    if (capability?.status === 'revoked' && !afterSnapshot.revokedAt) {
      updateSession(db, sessionId, {
        status: 'revoked',
        revokedAt: capability.revoked_at ?? now,
        updatedAt: now,
      });
    }
    const deniedAfterRevoke = db.prepare(`
      SELECT id, created_at
      FROM security_audit_events
      WHERE capability_id = ?
        AND outcome = 'denied'
        AND route = '/snapshot'
        AND created_at >= COALESCE(?, created_at)
      ORDER BY created_at DESC
      LIMIT 1
    `).get(afterSnapshot.capabilityId, afterSnapshot.revokedAt ?? null) as { id: string; created_at: string } | undefined;
    if (deniedAfterRevoke && !afterSnapshot.revocationObservedAt) {
      updateSession(db, sessionId, {
        status: 'revocation_observed',
        revocationObservedAt: deniedAfterRevoke.created_at,
        updatedAt: now,
      });
    }
  }

  return finalizeManualBrowserAcceptance(db, sessionId);
}

export function confirmPopupOpened(
  db: Database.Database,
  sessionId: string,
  confirmed = true,
): ManualBrowserAcceptanceRecord {
  updateSession(db, sessionId, {
    popupOpenedConfirmedAt: confirmed ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  });
  return finalizeManualBrowserAcceptance(db, sessionId);
}

export function verifySnapshotDoesNotContainToken(
  db: Database.Database,
  sessionId: string,
  token: string,
): ManualBrowserAcceptanceRecord {
  const session = getManualBrowserAcceptanceSession(db, sessionId);
  if (!session.snapshotId) throw new Error('Cannot verify token absence before snapshot arrival');
  const row = db.prepare('SELECT raw_json FROM snapshots WHERE id = ?').get(session.snapshotId) as { raw_json: string | null } | undefined;
  if (!row) throw new Error(`Snapshot not found: ${session.snapshotId}`);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const raw = row.raw_json ?? '';
  if (raw.includes(token) || raw.includes(tokenHash)) {
    return failSession(db, sessionId, 'token_leak', 'Extension capability token appeared in snapshot data.');
  }
  updateSession(db, sessionId, {
    tokenAbsentVerifiedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return finalizeManualBrowserAcceptance(db, sessionId);
}

function finalizeManualBrowserAcceptance(db: Database.Database, sessionId: string): ManualBrowserAcceptanceRecord {
  const session = getManualBrowserAcceptanceSession(db, sessionId);
  const passed = Boolean(
    session.popupOpenedConfirmedAt
    && session.capabilityId
    && session.snapshotId
    && session.revokedAt
    && session.revocationObservedAt
    && session.tokenAbsentVerifiedAt,
  );
  if (passed && session.status !== 'passed') {
    updateSession(db, sessionId, { status: 'passed', updatedAt: new Date().toISOString() });
  }
  return getManualBrowserAcceptanceSession(db, sessionId);
}

function latestSnapshotAfterBaseline(
  db: Database.Database,
  baselineCount: number,
  browser: ProductBrowser,
): { id: string } | undefined {
  const currentCount = snapshotCount(db);
  if (currentCount <= baselineCount) return undefined;
  return db.prepare(`
    SELECT DISTINCT s.id
    FROM snapshots s
    JOIN tab_observations t ON t.snapshot_id = s.id
    WHERE t.browser = ?
    ORDER BY s.captured_at DESC
    LIMIT 1
  `).get(browser) as { id: string } | undefined;
}

function snapshotCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM snapshots').get() as { count: number }).count;
}

function failSession(db: Database.Database, sessionId: string, code: string, summary: string): ManualBrowserAcceptanceRecord {
  updateSession(db, sessionId, {
    status: 'failed',
    failureCode: code,
    failureSummary: summary,
    updatedAt: new Date().toISOString(),
  });
  return getManualBrowserAcceptanceSession(db, sessionId);
}

function updateSession(
  db: Database.Database,
  sessionId: string,
  patch: Record<string, unknown>,
): void {
  const columns: Record<string, string> = {
    status: 'status',
    capabilityId: 'capability_id',
    pairedAt: 'paired_at',
    snapshotId: 'snapshot_id',
    snapshotObservedAt: 'snapshot_observed_at',
    revokedAt: 'revoked_at',
    revocationObservedAt: 'revocation_observed_at',
    popupOpenedConfirmedAt: 'popup_opened_confirmed_at',
    tokenAbsentVerifiedAt: 'token_absent_verified_at',
    failureCode: 'failure_code',
    failureSummary: 'failure_summary',
    updatedAt: 'updated_at',
  };
  const entries = Object.entries(patch).filter(([key]) => key in columns);
  if (!entries.length) return;
  db.prepare(`
    UPDATE manual_browser_acceptance_sessions
    SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')}
    WHERE id = ?
  `).run(...entries.map(([, value]) => value), sessionId);
}

type ManualBrowserAcceptanceRow = {
  id: string;
  browser: ProductBrowser;
  status: ManualBrowserAcceptanceStatus;
  receiver_url: string;
  challenge_id: string | null;
  capability_id: string | null;
  baseline_snapshot_count: number;
  paired_at: string | null;
  snapshot_id: string | null;
  snapshot_observed_at: string | null;
  revoked_at: string | null;
  revocation_observed_at: string | null;
  popup_opened_confirmed_at: string | null;
  token_absent_verified_at: string | null;
  failure_code: string | null;
  failure_summary: string | null;
  created_at: string;
  updated_at: string;
};

function fromRow(row: ManualBrowserAcceptanceRow): ManualBrowserAcceptanceRecord {
  return {
    id: row.id,
    browser: ProductBrowser.parse(row.browser),
    status: ManualBrowserAcceptanceStatus.parse(row.status),
    receiverUrl: row.receiver_url,
    challengeId: row.challenge_id ?? undefined,
    capabilityId: row.capability_id ?? undefined,
    baselineSnapshotCount: row.baseline_snapshot_count,
    pairedAt: row.paired_at ?? undefined,
    snapshotId: row.snapshot_id ?? undefined,
    snapshotObservedAt: row.snapshot_observed_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revocationObservedAt: row.revocation_observed_at ?? undefined,
    popupOpenedConfirmedAt: row.popup_opened_confirmed_at ?? undefined,
    tokenAbsentVerifiedAt: row.token_absent_verified_at ?? undefined,
    failureCode: row.failure_code ?? undefined,
    failureSummary: row.failure_summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
