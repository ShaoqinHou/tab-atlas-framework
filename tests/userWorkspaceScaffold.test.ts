import { describe, expect, it } from 'vitest';
import { claimActionEffect, completeActionEffect } from '../src/agent/actionEffectLedger.js';
import { openDatabase } from '../src/db/index.js';
import { ONBOARDING_STEPS } from '../src/onboarding/contracts.js';
import { fallbackRetrievalPlan } from '../src/retrieval/queryPlan.js';
import { REVIEW_KEYBOARD_SHORTCUTS } from '../src/review/sessionContracts.js';
import {
  createPairingChallenge,
  exchangePairingChallenge,
  PairingChallengeError,
} from '../src/security/pairingChallenge.js';

describe('user-ready workspace scaffold', () => {
  it('loads v5 workspace tables and contracts', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
    `).all() as Array<{ name: string }>;
    const names = new Set(tables.map(row => row.name));

    expect(names.has('pairing_challenges')).toBe(true);
    expect(names.has('onboarding_state')).toBe(true);
    expect(names.has('action_effects')).toBe(true);
    expect(names.has('retrieval_runs')).toBe(true);
    expect(names.has('review_sessions')).toBe(true);
    expect(ONBOARDING_STEPS).toContain('first_view_created');
    expect(REVIEW_KEYBOARD_SHORTCUTS.skip).toBe('S');
  });

  it('creates high-entropy single-use pairing challenges with bounded attempts', () => {
    const db = openDatabase(':memory:');
    const created = createPairingChallenge(db, { browser: 'chrome', maxAttempts: 2, ttlMs: 60_000 });

    expect(created.secret).toMatch(/^TA-/);
    expect(created.secret.replace(/[^A-Z0-9]/g, '').length).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(db.prepare('SELECT * FROM pairing_challenges').all())).not.toContain(created.secret);

    expect(() => exchangePairingChallenge(db, {
      challengeId: created.challenge.id,
      secret: 'wrong',
      browser: 'chrome',
      throttleKey: 'test',
    })).toThrow(PairingChallengeError);
    expect(() => exchangePairingChallenge(db, {
      challengeId: created.challenge.id,
      secret: 'wrong-again',
      browser: 'chrome',
      throttleKey: 'test',
    })).toThrow(PairingChallengeError);

    const locked = db.prepare('SELECT status, attempts FROM pairing_challenges WHERE id = ?').get(created.challenge.id) as { status: string; attempts: number };
    expect(locked).toEqual({ status: 'locked', attempts: 2 });
  });

  it('exchanges a pairing challenge once for a snapshot-only extension capability', () => {
    const db = openDatabase(':memory:');
    const created = createPairingChallenge(db, { browser: 'edge', ttlMs: 60_000 });
    const exchanged = exchangePairingChallenge(db, {
      challengeId: created.challenge.id,
      secret: created.secret,
      browser: 'edge',
      throttleKey: 'edge',
    });

    expect(exchanged.capability.kind).toBe('extension');
    expect(exchanged.capability.scopes).toEqual(['snapshot:write']);
    expect(exchanged.token).toMatch(/^ta_/);
    expect(() => exchangePairingChallenge(db, {
      challengeId: created.challenge.id,
      secret: created.secret,
      browser: 'edge',
      throttleKey: 'edge',
    })).toThrow(/used_challenge/);
  });

  it('claims and replays action effects by idempotency key', () => {
    const db = openDatabase(':memory:');
    const first = claimActionEffect(db, {
      actionId: 'action_1',
      effectKind: 'view_plan_create',
      idempotencyKey: 'action_1:view',
      effectInput: { command: 'make view' },
    });
    expect(first.claimed).toBe(true);
    const completed = completeActionEffect(db, 'action_1:view', { viewIds: ['view_1'] });
    expect(completed.status).toBe('succeeded');

    const replay = claimActionEffect(db, {
      actionId: 'action_1',
      effectKind: 'view_plan_create',
      idempotencyKey: 'action_1:view',
    });
    expect(replay.claimed).toBe(false);
    expect(replay.effect.result).toEqual({ viewIds: ['view_1'] });
  });

  it('builds a multi-source fallback retrieval plan for complex commands', () => {
    const plan = fallbackRetrievalPlan('Make a tab-manager project reference group with videos and SQLite notes');
    expect(plan.includeUserMarkedForTaste).toBe(true);
    expect(plan.queries.map(query => query.source)).toEqual(expect.arrayContaining([
      'user_annotations',
      'membership_feedback',
      'atomic_items',
      'extracted_evidence',
      'codex_scan',
      'browser_groups',
      'fts',
      'recent',
    ]));
  });
});
