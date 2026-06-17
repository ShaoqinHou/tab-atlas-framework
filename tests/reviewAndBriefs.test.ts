import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { addUserAnnotation } from '../src/annotations/service.js';
import { buildResourceBrief } from '../src/resources/briefs.js';
import { getReviewNext, submitReviewDecision } from '../src/review/service.js';
import { searchResources } from '../src/agent/tools.js';

function seedOneResource() {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-17T00:00:00.000Z',
    tabs: [{
      browser: 'chrome',
      title: 'Beautiful watercolor environments',
      url: 'https://www.youtube.com/watch?v=abc123def45',
      groupTitle: 'Art refs',
    }],
  }, 'test');
  const row = db.prepare('SELECT id FROM resources LIMIT 1').get() as { id: string };
  return { db, resourceId: row.id };
}

describe('resource briefs and focused review', () => {
  it('places user annotations before title and extracted evidence in ResourceBrief JSON', () => {
    const { db, resourceId } = seedOneResource();
    const annotation = addUserAnnotation(db, {
      targetKind: 'resource',
      targetId: resourceId,
      tags: ['game', 'inspiration', 'ui'],
      description: 'Inventory UI idea; use for project X.',
      decision: 'inspiration',
      source: 'focused_review',
    });

    const brief = buildResourceBrief(db, resourceId);
    const serialized = JSON.stringify(brief);

    expect(brief.userAnnotations[0].id).toBe(annotation.id);
    expect(brief.userAnnotations[0].description).toContain('Inventory UI');
    expect(serialized.indexOf('"userAnnotations"')).toBeLessThan(serialized.indexOf('"evidence"'));
    expect(brief.evidence.some(item => item.kind === 'title')).toBe(true);
  });

  it('searches user annotations as higher-priority evidence than title text', () => {
    const { db, resourceId } = seedOneResource();
    addUserAnnotation(db, {
      targetKind: 'resource',
      targetId: resourceId,
      tags: ['game', 'inspiration'],
      description: 'Forest level moodboard.',
      decision: 'inspiration',
      source: 'focused_review',
    });

    const result = searchResources(db, {
      query: 'game',
      filters: { annotationStatus: 'any', limit: 10 },
    });

    expect(result.matches[0].resourceId).toBe(resourceId);
    expect(result.matches[0].reasons).toContain('user annotation matches "game"');
  });

  it('keeps skipped focused-review items available after pending items are exhausted', () => {
    const { db, resourceId } = seedOneResource();
    const first = getReviewNext(db, { queue: 'unmarked', preload: 0 });
    expect(first.current?.resourceId).toBe(resourceId);

    const afterSkip = submitReviewDecision(db, {
      resourceId,
      action: 'skip',
      tags: [],
      decision: 'none',
    });

    expect(afterSkip.current?.resourceId).toBe(resourceId);
    const queueRow = db.prepare(`
      SELECT status, skipped_count
      FROM review_queue_items
      WHERE resource_id = ?
    `).get(resourceId) as { status: string; skipped_count: number };
    expect(queueRow.status).toBe('skipped');
    expect(queueRow.skipped_count).toBe(1);
  });
});
