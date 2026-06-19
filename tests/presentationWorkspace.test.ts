import { describe, expect, it } from 'vitest';
import { addUserAnnotation } from '../src/annotations/service.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { planPresentationActionsFromText } from '../src/presentation/actionPlanner.js';
import {
  getTargetInspector,
  getViewSectionPage,
  getViewWorkspace,
} from '../src/presentation/workspaceService.js';
import type { ResourceBrief, SemanticViewPlan } from '../src/shared/schemas.js';
import { createUserCommand, persistSemanticViewPlan } from '../src/views/service.js';
import {
  assertPresentationActionsNonDestructive,
  type PresentationAction,
} from '../src/presentation/contracts.js';
import { projectSemanticViewWorkspace } from '../src/presentation/projectWorkspace.js';
import {
  validateRoleplayScenarioCoverage,
  workspaceRoleplayScenarios,
} from '../src/presentation/roleplayScenarios.js';

const briefs: ResourceBrief[] = [{
  resourceId: 'res_game',
  canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
  redactedUrl: 'https://www.youtube.com/watch?v=abc123def45',
  urlKind: 'youtube_video',
  host: 'youtube.com',
  title: 'Forest atmosphere study',
  browserGroupTitles: ['Game Ideas'],
  userAnnotations: [{
    id: 'ann_1',
    targetKind: 'resource',
    targetId: 'res_game',
    tags: ['inspiration', 'game'],
    description: 'Use this as a forest level moodboard.',
    decision: 'inspiration',
    source: 'focused_review',
    createdAt: '2026-06-19T00:00:00.000Z',
  }],
  systemTags: ['youtube'],
  summary: 'A visual study of forest lighting and environmental mood.',
  atomicItems: [{
    itemId: 'item_lighting',
    itemKind: 'idea',
    name: 'Forest lighting palette',
    summary: 'Cool shadows and warm light shafts.',
    evidenceRefs: ['ev_transcript'],
    confidence: 0.82,
  }],
  extractionStatus: 'complete',
  evidence: [{
    id: 'ev_transcript',
    kind: 'transcript',
    text: 'The creator discusses light shafts and atmospheric depth.',
    provenance: 'manual_paste',
    confidence: 0.9,
  }],
}, {
  resourceId: 'res_weak',
  canonicalUrl: 'https://example.com/tutorial',
  redactedUrl: 'https://example.com/tutorial',
  urlKind: 'web_page',
  host: 'example.com',
  title: 'General art tutorial',
  browserGroupTitles: [],
  userAnnotations: [],
  systemTags: ['web_page'],
  summary: 'A general tutorial with uncertain relevance.',
  atomicItems: [],
  extractionStatus: 'metadata_only',
  evidence: [{
    id: 'ev_title_weak',
    kind: 'title',
    text: 'General art tutorial',
    provenance: 'extension_snapshot',
    confidence: 0.4,
  }],
}];

const plan: SemanticViewPlan = {
  commandText: 'Make a loose game inspiration board.',
  views: [{
    name: 'Loose game inspiration',
    goal: 'Collect useful game-centered and cross-domain inspiration.',
    inclusionRules: ['Include user-marked inspiration.'],
    exclusionRules: ['Hide unrelated material.'],
    sections: ['Game-centered', 'Cross-domain'],
    confidence: 0.9,
    memberships: [{
      targetKind: 'resource',
      targetId: 'res_game',
      section: 'Game-centered',
      state: 'strong_include',
      confidence: 0.97,
      reason: 'The user explicitly marked it as a forest level moodboard.',
      evidenceRefs: ['user_annotation:ann_1', 'ev_transcript'],
    }, {
      targetKind: 'atomic_item',
      targetId: 'item_lighting',
      section: 'Game-centered',
      state: 'strong_include',
      confidence: 0.82,
      reason: 'This specific lighting idea is useful independently.',
      evidenceRefs: ['ev_transcript'],
    }, {
      targetKind: 'resource',
      targetId: 'res_weak',
      section: 'Cross-domain',
      state: 'needs_review',
      confidence: 0.42,
      reason: 'Only title-level evidence suggests possible relevance.',
      evidenceRefs: ['ev_title_weak'],
    }],
  }],
  reviewQueues: [{
    queueName: 'ambiguous',
    reason: 'Weak evidence',
    targetIds: ['res_weak'],
  }],
  explanation: 'User evidence is prioritized.',
};

describe('visual workspace projection', () => {
  it('projects a board with visual cards, user signals, sections, and a review lane', () => {
    const workspace = projectSemanticViewWorkspace(plan, briefs, {
      generatedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(workspace.layout).toBe('board');
    expect(workspace.sections.map(section => section.title)).toEqual(['Game-centered', 'Cross-domain']);
    const gameCard = workspace.sections[0].cards.find(card => card.targetId === 'res_game');
    expect(gameCard).toMatchObject({
      visualKind: 'video',
      evidenceStrength: 'user_direct',
      userSignal: 'Use this as a forest level moodboard.',
    });
    expect(gameCard?.media?.thumbnailUrl).toContain('abc123def45');
    expect(workspace.reviewLane.map(card => card.targetId)).toContain('res_weak');
  });

  it('keeps atomic items visually distinct from parent resources', () => {
    const workspace = projectSemanticViewWorkspace(plan, briefs);
    const item = workspace.sections.flatMap(section => section.cards)
      .find(card => card.targetId === 'item_lighting');
    expect(item).toMatchObject({
      targetKind: 'atomic_item',
      parentResourceId: 'res_game',
      visualKind: 'atomic_item',
    });
  });

  it('allows only non-destructive presentation actions', () => {
    const actions: PresentationAction[] = [
      { kind: 'set_layout', layout: 'gallery' },
      { kind: 'focus_section', sectionId: 'game-centered' },
      { kind: 'open_resource', targetKind: 'resource', targetId: 'res_game', inspectorTab: 'evidence' },
      { kind: 'open_review', queue: 'needs_review' },
    ];
    expect(() => assertPresentationActionsNonDestructive(actions)).not.toThrow();
  });

  it('plans conversational presentation actions from workspace text', () => {
    const workspace = projectSemanticViewWorkspace(plan, briefs, {
      generatedAt: '2026-06-19T00:00:00.000Z',
    });

    const galleryPlan = planPresentationActionsFromText('show this as a gallery and focus game-centered', {
      activeViewId: 'view_game',
      workspace,
    });
    expect(galleryPlan.actions).toEqual([
      { kind: 'set_layout', layout: 'gallery' },
      { kind: 'focus_section', sectionId: 'game-centered' },
    ]);

    const evidencePlan = planPresentationActionsFromText('open the strongest item and show evidence', {
      activeViewId: 'view_game',
      workspace,
    });
    expect(evidencePlan.actions).toContainEqual({
      kind: 'open_resource',
      targetKind: 'resource',
      targetId: 'res_game',
      inspectorTab: 'evidence',
    });
  });

  it('defines role-play coverage before human pilot use', () => {
    expect(validateRoleplayScenarioCoverage()).toEqual([]);
    expect(workspaceRoleplayScenarios).toHaveLength(5);
    expect(workspaceRoleplayScenarios.some(scenario => scenario.persona.visualPreference === 'visual_first')).toBe(true);
  });

  it('projects persisted views through bounded workspace and section APIs', () => {
    const { db, viewId } = seedPersistedWorkspace();

    const workspace = getViewWorkspace(db, viewId, {
      maxCardsPerSection: 1,
      generatedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(workspace.sections[0].visibleCount).toBe(1);
    expect(workspace.sections[0].cards).toHaveLength(1);
    expect(workspace.hiddenExcludedCount).toBe(1);

    const page = getViewSectionPage(db, viewId, workspace.sections[0].id, { cursor: 0, limit: 2 });
    expect(page.cards.length).toBeLessThanOrEqual(2);
    expect(page.totalCount).toBeGreaterThanOrEqual(2);
  });

  it('builds an inspector with user notes before technical evidence and safe URLs', () => {
    const { db, viewId, resourceId, atomicItemId } = seedPersistedWorkspace();

    const resourceInspector = getTargetInspector(db, { targetKind: 'resource', targetId: resourceId, viewId });
    expect(resourceInspector.safeOpenUrl).toContain('example.com');
    expect(JSON.stringify(resourceInspector)).not.toContain('secret=');
    expect(resourceInspector.userNotes[0].description).toContain('moodboard');
    expect(resourceInspector.evidence[0].label).toBe('User note');
    expect(resourceInspector.currentViewMembership?.evidenceStrength).toBe('user_direct');

    const atomicInspector = getTargetInspector(db, { targetKind: 'atomic_item', targetId: atomicItemId, viewId });
    expect(atomicInspector.parentResourceId).toBe(resourceId);
    expect(atomicInspector.visualKind).toBe('atomic_item');
  });

  it('pages a 1000-resource persisted view without returning duplicate section targets', () => {
    const { db, viewId } = seedLargePersistedWorkspace(1000);

    const workspace = getViewWorkspace(db, viewId, { maxCardsPerSection: 5 });
    expect(workspace.sections[0].cards).toHaveLength(5);
    expect(workspace.sections[0].totalCount).toBe(900);
    expect(workspace.hiddenExcludedCount).toBe(100);

    const seen = new Set<string>();
    let cursor: number | undefined = 0;
    let pageCount = 0;
    while (cursor !== undefined) {
      const page = getViewSectionPage(db, viewId, workspace.sections[0].id, { cursor, limit: 100 });
      pageCount += 1;
      for (const card of page.cards) {
        expect(seen.has(card.targetId)).toBe(false);
        seen.add(card.targetId);
      }
      cursor = page.nextCursor ?? undefined;
    }

    expect(pageCount).toBe(9);
    expect(seen.size).toBe(900);
  });
});

function seedPersistedWorkspace(): {
  db: ReturnType<typeof openDatabase>;
  viewId: string;
  resourceId: string;
  atomicItemId: string;
} {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-19T00:00:00.000Z',
    tabs: [
      { browser: 'chrome', title: 'Forest atmosphere study', url: 'https://example.com/forest?secret=1', groupTitle: 'Game Ideas' },
      { browser: 'chrome', title: 'Inventory UI breakdown', url: 'https://example.com/ui', groupTitle: 'Game Ideas' },
      { browser: 'chrome', title: 'Unrelated database manual', url: 'https://example.com/db', groupTitle: 'Reference' },
    ],
  }, 'presentation_test');
  const rows = db.prepare('SELECT id, title_best FROM resources').all() as Array<{ id: string; title_best: string }>;
  const byTitle = Object.fromEntries(rows.map(row => [row.title_best, row.id]));
  const resourceId = byTitle['Forest atmosphere study'];
  const secondId = byTitle['Inventory UI breakdown'];
  const excludedId = byTitle['Unrelated database manual'];
  const atomicItemId = 'item_lighting_palette';
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: resourceId,
    tags: ['inspiration', 'game'],
    description: 'Use this as a forest level moodboard.',
    decision: 'inspiration',
    source: 'focused_review',
  });
  db.prepare(`
    INSERT INTO extraction_artifacts
      (id, resource_id, recipe_id, artifact_kind, text_excerpt, json_payload, source_url, provenance, confidence, status, extracted_at)
    VALUES ('ev_transcript_seed', ?, 'manual.v1', 'transcript', 'The creator discusses light shafts.', '{}', '', 'manual_paste', 0.9, 'complete', ?)
  `).run(resourceId, new Date().toISOString());
  db.prepare(`
    INSERT INTO atomic_items (id, resource_id, item_kind, name, summary, evidence_refs, confidence, created_by, created_at)
    VALUES (?, ?, 'idea', 'Forest lighting palette', 'Cool shadows and warm light shafts.', '["ev_transcript_seed"]', 0.82, 'codex_scan', ?)
  `).run(atomicItemId, resourceId, new Date().toISOString());

  const commandId = createUserCommand(db, 'Make a loose game inspiration board.');
  const persisted = persistSemanticViewPlan(db, commandId, {
    commandText: 'Make a loose game inspiration board.',
    views: [{
      name: 'Loose game inspiration',
      goal: 'Collect useful game-centered and cross-domain inspiration.',
      inclusionRules: ['Include user-marked inspiration.'],
      exclusionRules: ['Hide unrelated material.'],
      sections: ['Game-centered', 'Needs a quick look'],
      confidence: 0.9,
      memberships: [{
        targetKind: 'resource',
        targetId: resourceId,
        section: 'Game-centered',
        state: 'strong_include',
        confidence: 0.97,
        reason: 'The user explicitly marked it as a forest level moodboard.',
        evidenceRefs: ['user_annotation:ann_seed', 'ev_transcript_seed'],
      }, {
        targetKind: 'atomic_item',
        targetId: atomicItemId,
        section: 'Game-centered',
        state: 'strong_include',
        confidence: 0.82,
        reason: 'This specific lighting idea is useful independently.',
        evidenceRefs: ['ev_transcript_seed'],
      }, {
        targetKind: 'resource',
        targetId: secondId,
        section: 'Game-centered',
        state: 'weak_include',
        confidence: 0.51,
        reason: 'UI examples may be useful but need a closer look.',
        evidenceRefs: ['ev_title_seed'],
      }, {
        targetKind: 'resource',
        targetId: excludedId,
        section: 'Excluded',
        state: 'exclude',
        confidence: 0.8,
        reason: 'Database reference is unrelated to the inspiration board.',
        evidenceRefs: [],
      }],
    }],
    reviewQueues: [],
    explanation: 'User evidence is prioritized.',
  });
  return { db, viewId: persisted.viewIds[0], resourceId, atomicItemId };
}

function seedLargePersistedWorkspace(count: number): {
  db: ReturnType<typeof openDatabase>;
  viewId: string;
} {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-19T00:00:00.000Z',
    tabs: Array.from({ length: count }, (_, index) => ({
      browser: index % 2 ? 'edge' : 'chrome',
      title: `Bulk workspace resource ${index.toString().padStart(4, '0')}`,
      url: `https://bulk.example.test/resource/${index}`,
      groupTitle: 'Bulk',
    })),
  }, 'presentation_large_test');
  const rows = db.prepare(`
    SELECT id
    FROM resources
    ORDER BY title_best
  `).all() as Array<{ id: string }>;
  const commandId = createUserCommand(db, 'Create a large visual workspace');
  const persisted = persistSemanticViewPlan(db, commandId, {
    commandText: 'Create a large visual workspace',
    views: [{
      name: 'Large workspace',
      goal: 'Exercise bounded visual workspace paging.',
      inclusionRules: ['Include bulk resources.'],
      exclusionRules: ['Hide every tenth resource.'],
      sections: ['Bulk'],
      confidence: 0.8,
      memberships: rows.map((row, index) => ({
        targetKind: 'resource',
        targetId: row.id,
        section: 'Bulk',
        state: index % 10 === 0 ? 'exclude' : 'strong_include',
        confidence: 1 - (index % 100) / 1000,
        reason: 'Bulk pagination fixture.',
        evidenceRefs: index % 10 === 0 ? [] : [`title:${row.id}`],
      })),
    }],
    reviewQueues: [],
    explanation: 'Large fixture.',
  });
  return { db, viewId: persisted.viewIds[0] };
}
