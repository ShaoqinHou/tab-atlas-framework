import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import {
  createCapability,
  createPairingCode,
  exchangePairingCode,
  hashSecret,
  listCapabilities,
  listPairingCodes,
  revokeCapability,
  rotateCapability,
  verifyCapabilityToken,
} from '../src/security/localCapability.js';
import { exchangePairingChallenge, createPairingChallenge } from '../src/security/pairingChallenge.js';
import { rePairExtensionCapability } from '../src/security/extensionRepair.js';

describe('local trust capability scaffold', () => {
  it('loads v4 local trust schema', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('local_capabilities', 'local_pairing_codes', 'security_audit_events')
      ORDER BY name
    `).all() as Array<{ name: string }>;

    expect(tables.map(row => row.name)).toEqual([
      'local_capabilities',
      'local_pairing_codes',
      'security_audit_events',
    ]);
  });

  it('stores only token hashes and verifies scopes', () => {
    const db = openDatabase(':memory:');
    const { capability, token } = createCapability(db, {
      kind: 'extension',
      scopes: ['snapshot:write'],
      label: 'Chrome',
    });
    const row = db.prepare('SELECT token_hash FROM local_capabilities WHERE id = ?').get(capability.id) as { token_hash: string };

    expect(row.token_hash).toBe(hashSecret(token));
    expect(row.token_hash).not.toContain(token);
    expect(verifyCapabilityToken(db, token, 'snapshot:write')).toMatchObject({ ok: true });
    expect(verifyCapabilityToken(db, token, 'api:write')).toEqual({ ok: false, reason: 'insufficient_scope' });
  });

  it('revokes and rotates capabilities without exposing old tokens', () => {
    const db = openDatabase(':memory:');
    const created = createCapability(db, { kind: 'ui', scopes: ['admin'] });

    revokeCapability(db, created.capability.id);
    expect(verifyCapabilityToken(db, created.token, 'admin')).toEqual({ ok: false, reason: 'revoked_token' });

    const rotated = rotateCapability(db, created.capability.id);
    expect(rotated.token).not.toBe(created.token);
    expect(verifyCapabilityToken(db, created.token, 'admin')).toEqual({ ok: false, reason: 'invalid_token' });
    expect(verifyCapabilityToken(db, rotated.token, 'jobs:write')).toMatchObject({ ok: true });
    expect(listCapabilities(db)[0]).not.toHaveProperty('token');
  });

  it('exchanges pairing codes once and honors expiry', () => {
    const db = openDatabase(':memory:');
    const active = createPairingCode(db, { ttlMs: 60_000 });
    const paired = exchangePairingCode(db, active.code, 'Edge extension');

    expect(paired.capability.kind).toBe('extension');
    expect(paired.capability.scopes).toEqual(['snapshot:write']);
    expect(verifyCapabilityToken(db, paired.token, 'snapshot:write')).toMatchObject({ ok: true });
    expect(() => exchangePairingCode(db, active.code)).toThrow(/already used/);
    expect(listPairingCodes(db)[0].usedAt).toBeTruthy();

    const expired = createPairingCode(db, { ttlMs: -1 });
    expect(() => exchangePairingCode(db, expired.code)).toThrow(/expired/);
  });

  it('re-pairs extension capabilities with browser-specific one-time challenges', () => {
    const db = openDatabase(':memory:');
    const chromeChallenge = createPairingChallenge(db, { browser: 'chrome', ttlMs: 60_000 });
    const chrome = exchangePairingChallenge(db, {
      challengeId: chromeChallenge.challenge.id,
      secret: chromeChallenge.secret,
      browser: 'chrome',
      label: 'chrome extension',
    });
    const edge = createCapability(db, {
      kind: 'extension',
      scopes: ['snapshot:write'],
      label: 'edge extension',
    });

    const repairedChrome = rePairExtensionCapability(db, chrome.capability.id);
    const repairedEdge = rePairExtensionCapability(db, edge.capability.id);
    const exchanged = exchangePairingChallenge(db, {
      challengeId: repairedChrome.challenge.id,
      secret: repairedChrome.secret,
      browser: 'chrome',
      label: 'chrome extension repaired',
    });

    expect(repairedChrome.browser).toBe('chrome');
    expect(repairedChrome.challenge.browser).toBe('chrome');
    expect(repairedEdge.browser).toBe('edge');
    expect(repairedEdge.challenge.browser).toBe('edge');
    expect(verifyCapabilityToken(db, chrome.token, 'snapshot:write')).toEqual({ ok: false, reason: 'revoked_token' });
    expect(verifyCapabilityToken(db, exchanged.token, 'snapshot:write')).toMatchObject({ ok: true });
    expect(JSON.stringify(db.prepare('SELECT * FROM pairing_challenges').all())).not.toContain(repairedChrome.secret);
  });
});
