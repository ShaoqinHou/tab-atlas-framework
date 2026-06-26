import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { planSemanticViewHeuristic } from '../src/ai/heuristicSemanticView.js';
import { buildResourceBrief } from '../src/resources/briefs.js';
import { buildResourceBriefForIntent } from '../src/resources/briefs.js';
import {
  acceptViewRevision,
  buildPreferenceEvidence,
  compareViewRevisions,
  createViewRevision,
  getViewRevision,
  listViewRevisions,
  recordMembershipFeedback,
  rejectViewRevision,
  undoMembershipFeedback,
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
      (id, target_kind, target_id, view_id, state, section, confidence, reason, evidence_refs, accepted_by_user)
    VALUES ('mem_1', 'resource', ?, 'view_1', 'strong_include', 'Inventory', 0.8, 'Looks useful for UI.', '["ev_title"]', 0)
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

  it('applies visible correction consequence and supports undo', () => {
    const { db, resourceId } = seed();
    const feedback = recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_exclude',
      reason: 'This is a framework note, not a visual UI reference.',
      correction: {
        previousMembership: {
          state: 'strong_include',
          section: 'Inventory',
          reason: 'Looks useful for UI.',
        },
      },
    });

    const afterCorrection = db.prepare(`
      SELECT state, conflict_note
      FROM memberships
      WHERE id = 'mem_1'
    `).get() as { state: string; conflict_note: string | null };
    expect(feedback.consequence?.scope).toBe('intent');
    expect(feedback.consequence?.message).toContain('scoped to this intent');
    expect(afterCorrection.state).toBe('conflict');
    expect(afterCorrection.conflict_note).toContain('User excluded');

    const undone = undoMembershipFeedback(db, feedback.id);
    const afterUndo = db.prepare(`
      SELECT state, section, reason, conflict_note
      FROM memberships
      WHERE id = 'mem_1'
    `).get() as { state: string; section: string | null; reason: string | null; conflict_note: string | null };
    const feedbackRows = db.prepare('SELECT COUNT(*) AS count FROM membership_feedback WHERE id = ?').get(feedback.id) as { count: number };

    expect(undone.restoredState).toBe('strong_include');
    expect(afterUndo.state).toBe('strong_include');
    expect(afterUndo.section).toBe('Inventory');
    expect(afterUndo.reason).toBe('Looks useful for UI.');
    expect(afterUndo.conflict_note).toBeNull();
    expect(feedbackRows.count).toBe(0);
  });

  it('ignores tampered browser previous state and stores undo internally', () => {
    const { db, resourceId } = seed();
    const feedback = recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_exclude',
      correction: {
        previousMembership: {
          state: 'exclude',
          section: 'Forged',
          reason: 'Browser supplied this.',
        },
      },
    });

    const stored = db.prepare('SELECT correction_json FROM membership_feedback WHERE id = ?').get(feedback.id) as { correction_json: string | null };
    const undo = db.prepare('SELECT previous_state, previous_section FROM membership_feedback_undo WHERE feedback_id = ?').get(feedback.id) as {
      previous_state: string;
      previous_section: string | null;
    };
    const undone = undoMembershipFeedback(db, feedback.id);
    const restored = db.prepare('SELECT state, section, reason FROM memberships WHERE id = ?').get('mem_1') as {
      state: string;
      section: string | null;
      reason: string | null;
    };

    expect(stored.correction_json).not.toContain('previousMembership');
    expect(undo).toEqual({ previous_state: 'strong_include', previous_section: 'Inventory' });
    expect(undone.restoredState).toBe('strong_include');
    expect(restored).toEqual({ state: 'strong_include', section: 'Inventory', reason: 'Looks useful for UI.' });
  });

  it('rejects invalid membership view and target combinations', () => {
    const { db } = seed();

    expect(() => recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: 'wrong_resource',
      decision: 'pin_exclude',
    })).toThrow(/Membership does not match/);
  });

  it('does not let stale undo clobber a newer correction', () => {
    const { db, resourceId } = seed();
    const first = recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_exclude',
    });
    recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'correct',
      correction: { sectionSuggestion: 'Implementation' },
    });

    expect(() => undoMembershipFeedback(db, first.id)).toThrow(/stale correction/);
    const current = db.prepare('SELECT state, section FROM memberships WHERE id = ?').get('mem_1') as {
      state: string;
      section: string | null;
    };
    expect(current).toEqual({ state: 'needs_review', section: 'Implementation' });
  });

  it('keeps internal undo data out of prompt-facing resource briefs', () => {
    const { db, resourceId } = seed();
    recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_exclude',
      correction: {
        previousMembership: { state: 'forged_state' },
        correctedMeaning: 'Use elsewhere',
      },
    });

    const brief = buildResourceBrief(db, resourceId);
    const serialized = JSON.stringify(brief);
    expect(serialized).not.toContain('previousMembership');
    expect(serialized).not.toContain('forged_state');
    expect(serialized).toContain('Use elsewhere');
  });

  it('stores corrected meaning as pending refinement consequence', () => {
    const { db, resourceId } = seed();
    const feedback = recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'correct',
      reason: 'Use as implementation reference instead.',
      correction: {
        correctedMeaning: 'Implementation reference',
        preferredTags: ['project-reference'],
        sectionSuggestion: 'Implementation',
      },
    });

    const membership = db.prepare(`
      SELECT state, section, reason, conflict_note
      FROM memberships
      WHERE id = 'mem_1'
    `).get() as { state: string; section: string | null; reason: string | null; conflict_note: string | null };

    expect(feedback.consequence?.currentState).toBe('needs_review');
    expect(feedback.consequence?.message).toContain('pending refinement');
    expect(membership.state).toBe('needs_review');
    expect(membership.section).toBe('Implementation');
    expect(membership.reason).toContain('Implementation');
    expect(membership.conflict_note).toContain('User supplied a correction');
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

  it('compares semantic revision membership, goal, and rule changes across lineage views', () => {
    const { db, resourceId } = seed();
    db.prepare(`
      INSERT INTO views (id, name, description, query_json, origin, status, created_at)
      VALUES ('view_2', 'Game UI refined', '', '{}', 'codex', 'proposed', '2026-06-18T00:00:01.000Z')
    `).run();
    const parent = createViewRevision(db, {
      viewId: 'view_1',
      status: 'accepted',
      snapshot: {
        view: {
          goal: 'Game UI inspiration',
          inclusionRules: ['include UI examples'],
          exclusionRules: [],
          memberships: [{
            targetKind: 'resource',
            targetId: resourceId,
            state: 'weak_include',
            section: 'Inventory',
            confidence: 0.45,
          }],
        },
      },
    });
    const child = createViewRevision(db, {
      viewId: 'view_2',
      parentRevisionId: parent.id,
      status: 'proposed',
      snapshot: {
        view: {
          goal: 'Strict game UI inspiration',
          inclusionRules: ['include UI examples'],
          exclusionRules: ['exclude pure tutorials'],
          memberships: [{
            targetKind: 'resource',
            targetId: resourceId,
            state: 'strong_include',
            section: 'Practical tools',
            confidence: 0.91,
          }],
        },
      },
    });

    const comparison = compareViewRevisions(db, child.id, parent.id);
    const lineage = listViewRevisions(db, 'view_2');

    expect(lineage.map(revision => revision.id)).toEqual([child.id, parent.id]);
    expect(comparison.comparable).toBe(true);
    expect(comparison.summary.changed).toBe(1);
    expect(comparison.changes.membershipChanges[0]).toMatchObject({
      targetKind: 'resource',
      targetId: resourceId,
      before: { state: 'weak_include', section: 'Inventory', confidence: 0.45 },
      after: { state: 'strong_include', section: 'Practical tools', confidence: 0.91 },
    });
    expect(comparison.changes.goalChange).toEqual({
      from: 'Game UI inspiration',
      to: 'Strict game UI inspiration',
    });
    expect(comparison.changes.ruleChanges).toContainEqual({ kind: 'added', rule: 'exclude pure tutorials' });
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

  it('does not apply painting-tutorial rejection to game-art inspiration', () => {
    const { db, resourceId } = seed();
    recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'reject',
      reason: 'Not a painting tutorial.',
      sourceCommandText: 'Collect painting tutorials I should follow step by step',
      sourceGoal: 'Practical painting lessons',
      sourceRules: ['Exclude moodboards and inspiration-only videos'],
    });

    const brief = buildResourceBriefForIntent(db, resourceId, {
      commandText: 'Make a game environment inspiration moodboard',
    });
    const plan = planSemanticViewHeuristic('Make a game environment inspiration moodboard', [brief]);

    expect(brief.evidence.some(item => item.kind === 'membership_feedback')).toBe(false);
    expect(plan.views[0].memberships[0].evidenceRefs.some(ref => ref.startsWith('feedback:'))).toBe(false);
  });

  it('does not apply project-board correction to an unrelated practical tutorial view', () => {
    const { db, resourceId } = seed();
    recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_exclude',
      reason: 'Keep this excluded only for this intent.',
      sourceCommandText: 'Plan a board view named TabAtlas Project Board with sections extension, receiver, Codex, storage, extraction, transcripts, security, UX, installation, packaging, and testing.',
      sourceGoal: 'Organize supplied TabAtlas project resources into implementation-oriented board sections.',
      sourceRules: [
        'Preserve sections: extension, receiver, Codex, storage, extraction, transcripts, security, UX, installation, packaging, and testing.',
        'Treat YouTube titles and URL kinds as metadata-level evidence only.',
      ],
    });

    const commandText = 'Plan a separate view named Practical Painting Tutorials for painting-learning resources, keeping it separate from the TabAtlas Project Board.';
    const brief = buildResourceBriefForIntent(db, resourceId, { commandText });
    const plan = planSemanticViewHeuristic(commandText, [brief]);

    expect(brief.evidence.some(item => item.kind === 'membership_feedback')).toBe(false);
    expect(plan.views[0].memberships[0].evidenceRefs.some(ref => ref.startsWith('feedback:'))).toBe(false);
    expect(plan.views[0].memberships[0].reason).not.toMatch(/feedback|previously pinned|prior correction/i);
  });

  it('applies game UI pin to a related game interface command', () => {
    const { db, resourceId } = seed();
    recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_include',
      reason: 'Strong inventory design reference.',
      sourceCommandText: 'Make a game UI inspiration board',
      sourceGoal: 'Collect inventory and interface design ideas for games',
      sourceRules: ['Include game interface examples'],
    });

    const brief = buildResourceBriefForIntent(db, resourceId, {
      commandText: 'Show game interface reference links',
    });
    const plan = planSemanticViewHeuristic('Show game interface reference links', [brief]);

    expect(brief.evidence[0].kind).toBe('membership_feedback');
    expect(plan.views[0].memberships[0].state).toBe('strong_include');
    expect(plan.views[0].memberships[0].evidenceRefs[0]).toMatch(/^feedback:/);
  });

  it('applies explicit global feedback to unrelated commands', () => {
    const { db, resourceId } = seed();
    recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_exclude',
      reason: 'Never use this stale duplicate.',
      scopeMode: 'global',
      sourceCommandText: 'Any command',
    });

    const brief = buildResourceBriefForIntent(db, resourceId, {
      commandText: 'Collect project architecture references',
    });

    expect(brief.evidence[0].kind).toBe('membership_feedback');
  });

  it('places relevant feedback before Codex scan evidence', () => {
    const { db, resourceId } = seed();
    db.prepare(`
      INSERT INTO extraction_artifacts
        (id, resource_id, recipe_id, artifact_kind, text_excerpt, json_payload, source_url, provenance, confidence, status, extracted_at)
      VALUES
        ('art_codex_1', ?, 'codex_resource_analysis.v1', 'codex_resource_analysis', 'Codex scan says UI reference.', '{}', 'https://example.com/ui', 'codex', 0.8, 'complete', '2026-06-18T00:00:00.000Z')
    `).run(resourceId);
    recordMembershipFeedback(db, {
      viewId: 'view_1',
      membershipId: 'mem_1',
      targetKind: 'resource',
      targetId: resourceId,
      decision: 'pin_include',
      reason: 'Inventory UI reference.',
      sourceCommandText: 'Make a game UI inspiration board',
      sourceGoal: 'Collect inventory and interface design ideas for games',
      sourceRules: ['Include game interface examples'],
    });

    const brief = buildResourceBriefForIntent(db, resourceId, {
      commandText: 'Show game interface inspiration',
    });

    expect(brief.evidence[0].kind).toBe('membership_feedback');
    expect(brief.evidence.some(item => item.kind === 'codex_resource_analysis')).toBe(true);
    expect(brief.evidence.findIndex(item => item.kind === 'membership_feedback')).toBeLessThan(
      brief.evidence.findIndex(item => item.kind === 'codex_resource_analysis'),
    );
  });
});
