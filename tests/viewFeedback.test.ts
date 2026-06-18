import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { planSemanticViewHeuristic } from '../src/ai/heuristicSemanticView.js';
import { buildResourceBrief } from '../src/resources/briefs.js';
import {
  acceptViewRevision,
  buildPreferenceEvidence,
  createViewRevision,
  getViewRevision,
  recordMembershipFeedback,
  rejectViewRevision,
} from '../src/views/feedbackService.js';

function seed() {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-18T00:00:00.000Z',
    tabs: [{ browser: 'chrome', title: 'Inventory UI reference', url: 'https://example.com/ui' }],
  }, 'test');
  const resource = db.prepare('SELECT id FROM resources LIMIT 1').get() as { id: string };
  db.prepare(`
    INSERT INTO views (id, name, description, query_json, origin, status, created_at)
    VALUES ('view_1', 'Game UI', '', '{}', 'codex', 'proposed', '2026-06-18T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO memberships
      (id, target_kind, target_id, view_id, state, confidence, reason, evidence_refs, accepted_by_user)
    VALUES ('mem_1', 'resource', ?, 'view_1', 'strong_include', 0.8, 'Looks useful for UI.', '["ev_title"]', 0)
  `).run(resource.id);
  return { db, resourceId: resource.id };
}

describe('view revisions and membership feedback', () => {
  it('creates immutable revision lineage for refinements', () => {
    const { db } = seed();
    const first = createViewRevision(db, {
      viewId: 'view_1',
      status: 'accepted',
      snapshot: { goal: 'Game UI inspiration', rules: ['include UI examples'] },
    });
    const second = createViewRevision(db, {
      viewId: 'view_1',
      parentRevisionId: first.id,
      status: 'proposed',
      snapshot: { goal: 'Game UI inspiration', rules: ['exclude implementation tutorials'] },
    });

    expect(first.revisionNumber).toBe(1);
    expect(second.revisionNumber).toBe(2);
    expect(second.lineageId).toBe(first.lineageId);
    expect(second.parentRevisionId).toBe(first.id);
  });

  it('turns explicit user corrections into high-priority future evidence', () => {
    const { db, resourceId } = seed();
    const feedback = recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_exclude',
      reason: 'This is implementation reference, not visual inspiration.',
      correction: { preferredTags: ['project_reference'], removeTags: ['inspiration'] },
    });
    const evidence = buildPreferenceEvidence(db, 'resource', resourceId);

    expect(feedback.decision).toBe('pin_exclude');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].confidence).toBe(1);
    expect(evidence[0].text).toContain('not visual inspiration');
  });

  it('rejects child revisions without changing the accepted parent revision', () => {
    const { db } = seed();
    db.prepare(`
      INSERT INTO views (id, name, description, query_json, origin, status, created_at)
      VALUES ('view_2', 'Game UI refined', '', '{}', 'codex', 'proposed', '2026-06-18T00:00:00.000Z')
    `).run();
    const first = createViewRevision(db, {
      viewId: 'view_1',
      status: 'proposed',
      snapshot: { goal: 'Game UI inspiration' },
    });
    acceptViewRevision(db, first.id);
    const child = createViewRevision(db, {
      viewId: 'view_2',
      parentRevisionId: first.id,
      status: 'proposed',
      snapshot: { goal: 'Only examples, no tutorials' },
    });

    rejectViewRevision(db, child.id);

    expect(getViewRevision(db, first.id).status).toBe('accepted');
    expect(getViewRevision(db, child.id).status).toBe('rejected');
    const parentView = db.prepare('SELECT status FROM views WHERE id = ?').get('view_1') as { status: string };
    expect(parentView.status).toBe('accepted');
  });

  it('adds feedback to ResourceBrief before generated evidence and affects later heuristic grouping', () => {
    const { db, resourceId } = seed();
    recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_exclude',
      reason: 'Not inspiration for this purpose.',
    });

    const brief = buildResourceBrief(db, resourceId);
    expect(brief.evidence[0].kind).toBe('membership_feedback');

    const plan = planSemanticViewHeuristic('Make a strict game UI inspiration group', [brief]);
    expect(plan.views[0].memberships[0].state).toBe('conflict');
    expect(plan.views[0].memberships[0].evidenceRefs[0]).toMatch(/^feedback:/);
  });
});
