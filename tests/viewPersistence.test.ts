import { describe, expect, it } from 'vitest';
import { addUserAnnotation } from '../src/annotations/service.js';
import { explainMembership } from '../src/agent/tools.js';
import { planSemanticViewHeuristic } from '../src/ai/heuristicSemanticView.js';
import { openDatabase } from '../src/db/index.js';
import { runDeterministicExtraction } from '../src/extract/deterministic.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { buildResourceBriefs } from '../src/resources/briefs.js';
import { applyViewPlan, createUserCommand, persistSemanticViewPlan, previewView } from '../src/views/service.js';

function seedViewFixture() {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-17T00:00:00.000Z',
    tabs: [
      {
        browser: 'chrome',
        title: 'Beautiful watercolor environments',
        url: 'https://www.youtube.com/watch?v=watercolor01',
      },
      {
        browser: 'chrome',
        title: 'Gameplay mechanics breakdown',
        url: 'https://example.com/gameplay-mechanics',
      },
      {
        browser: 'edge',
        title: 'Ambient album',
        url: 'https://example.com/ambient-album',
      },
    ],
  }, 'test');
  runDeterministicExtraction(db);
  const rows = db.prepare('SELECT id, title_best FROM resources ORDER BY title_best').all() as { id: string; title_best: string }[];
  const byTitle = Object.fromEntries(rows.map(row => [row.title_best, row.id]));
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: byTitle['Beautiful watercolor environments'],
    tags: ['inspiration'],
    description: 'Forest level moodboard for game art direction.',
    decision: 'inspiration',
    source: 'focused_review',
  });
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: byTitle['Ambient album'],
    tags: ['inspiration', 'music'],
    description: 'Atmosphere reference.',
    decision: 'inspiration',
    source: 'focused_review',
  });
  return { db, byTitle };
}

describe('semantic view persistence', () => {
  it('persists strict game inspiration with include and exclude states', () => {
    const { db, byTitle } = seedViewFixture();
    const commandId = createUserCommand(db, 'Make a strict game inspiration group');
    const briefs = buildResourceBriefs(db, Object.values(byTitle));
    const plan = planSemanticViewHeuristic('Make a strict game inspiration group', briefs);
    const persisted = persistSemanticViewPlan(db, commandId, plan, 'heuristic');
    const preview = previewView(db, persisted.viewIds[0]);

    expect(preview.name).toBe('Game inspiration');
    expect(preview.countsByState.strong_include).toBeGreaterThanOrEqual(2);
    expect(preview.countsByState.exclude).toBeGreaterThanOrEqual(1);
    expect(preview.samples.some(sample => sample.resourceId === byTitle['Beautiful watercolor environments'] && sample.state === 'strong_include')).toBe(true);
  });

  it('persists loose inspiration sections including cross-domain inspiration', () => {
    const { db, byTitle } = seedViewFixture();
    const commandId = createUserCommand(db, 'Make a loose group mainly game inspiration but welcome all marked inspiration');
    const plan = planSemanticViewHeuristic(
      'Make a loose group mainly game inspiration but welcome all marked inspiration',
      buildResourceBriefs(db, Object.values(byTitle)),
    );
    const persisted = persistSemanticViewPlan(db, commandId, plan, 'heuristic');
    const preview = previewView(db, persisted.viewIds[0]);

    expect(preview.name).toBe('Loose inspiration');
    expect(Object.keys(preview.countsBySection)).toContain('Cross-domain inspiration');
    expect(preview.samples.some(sample => sample.section === 'Cross-domain inspiration')).toBe(true);
  });

  it('explains persisted membership with evidence refs', () => {
    const { db, byTitle } = seedViewFixture();
    const commandId = createUserCommand(db, 'Make a strict game inspiration group');
    const plan = planSemanticViewHeuristic('Make a strict game inspiration group', buildResourceBriefs(db, Object.values(byTitle)));
    const persisted = persistSemanticViewPlan(db, commandId, plan, 'heuristic');

    const explanation = explainMembership(db, {
      resourceId: byTitle['Beautiful watercolor environments'],
      viewId: persisted.viewIds[0],
    });

    expect(explanation.explanation).toContain('User annotation');
    expect(explanation.evidenceRefs.some(ref => ref.startsWith('user_annotation:'))).toBe(true);
    expect(explanation.confidence).toBeGreaterThan(0.9);
  });

  it('accepts a view without mutating or overwriting earlier accepted memberships', () => {
    const { db, byTitle } = seedViewFixture();
    const firstCommandId = createUserCommand(db, 'Make a strict game inspiration group');
    const firstPlan = planSemanticViewHeuristic('Make a strict game inspiration group', buildResourceBriefs(db, Object.values(byTitle)));
    const first = persistSemanticViewPlan(db, firstCommandId, firstPlan, 'heuristic');
    applyViewPlan(db, first.viewIds[0], 'accepted');

    const secondCommandId = createUserCommand(db, 'Make a loose group mainly game inspiration but welcome all marked inspiration');
    const secondPlan = planSemanticViewHeuristic('Make a loose group mainly game inspiration but welcome all marked inspiration', buildResourceBriefs(db, Object.values(byTitle)));
    persistSemanticViewPlan(db, secondCommandId, secondPlan, 'heuristic');

    const acceptedCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memberships
      WHERE view_id = ? AND accepted_by_user = 1
    `).get(first.viewIds[0]) as { count: number };
    const acceptedView = db.prepare('SELECT status FROM views WHERE id = ?').get(first.viewIds[0]) as { status: string };

    expect(acceptedCount.count).toBeGreaterThan(0);
    expect(acceptedView.status).toBe('accepted');
  });
});
