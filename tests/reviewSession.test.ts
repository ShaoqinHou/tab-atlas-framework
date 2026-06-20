import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import {
  createReviewSession,
  getReviewSession,
  pauseReviewSession,
  resumeReviewSession,
  submitReviewSessionDecision,
} from '../src/review/sessionService.js';

function seed(db = openDatabase(':memory:')) {
  importSnapshot(db, {
    capturedAt: '2026-06-19T00:00:00.000Z',
    tabs: [
      { browser: 'chrome', title: 'Receiver architecture', url: 'https://example.com/receiver' },
      { browser: 'chrome', title: 'Extension popup', url: 'https://example.com/extension' },
      { browser: 'chrome', title: 'SQLite migrations', url: 'https://example.com/sqlite' },
      { browser: 'chrome', title: 'Codex planning', url: 'https://example.com/codex' },
      { browser: 'chrome', title: 'Random article', url: 'https://example.com/random' },
    ],
  }, 'review_session_test');
  return db;
}

function sessionResourceIds(db: ReturnType<typeof openDatabase>, sessionId: string): string[] {
  return (db.prepare(`
    SELECT resource_id
    FROM review_session_items
    WHERE session_id = ?
    ORDER BY position
  `).all(sessionId) as Array<{ resource_id: string }>).map(row => row.resource_id);
}

describe('persistent review sessions', () => {
  it('preloads current plus next three cards', () => {
    const db = seed();
    const session = createReviewSession(db, { type: 'unmarked', preload: 4 });

    expect(session.current).toBeTruthy();
    expect(session.next).toHaveLength(3);
    expect(session.keyboardShortcuts.skip).toBe('S');
  });

  it('survives restart and resumes position', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-review-session-'));
    const dbPath = path.join(base, 'tabatlas.sqlite');
    const db = seed(openDatabase(dbPath));
    const session = createReviewSession(db, { type: 'unmarked', preload: 4 });
    const firstId = session.current!.resourceId;
    submitReviewSessionDecision(db, session.session.id, {
      resourceId: firstId,
      action: 'save_and_next',
      tags: ['project_reference'],
      decision: 'project_reference',
    });
    db.close();

    const reopened = openDatabase(dbPath);
    const resumed = getReviewSession(reopened, session.session.id);

    expect(resumed.current?.resourceId).not.toBe(firstId);
    expect(resumed.progress.completed).toBe(1);
    reopened.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('skip advances now and skipped item reappears after pending items', () => {
    const db = seed();
    const session = createReviewSession(db, { type: 'unmarked', preload: 4 });
    const skippedId = session.current!.resourceId;
    const afterSkip = submitReviewSessionDecision(db, session.session.id, {
      resourceId: skippedId,
      action: 'skip',
    });

    expect(afterSkip.current?.resourceId).not.toBe(skippedId);
    expect(afterSkip.progress.skipped).toBe(1);
    for (const item of [afterSkip.current, ...afterSkip.next].filter(Boolean)) {
      submitReviewSessionDecision(db, session.session.id, {
        resourceId: item!.resourceId,
        action: 'save_and_next',
        tags: ['reviewed'],
        decision: 'none',
      });
    }
    const later = getReviewSession(db, session.session.id);
    expect(later.current?.resourceId).toBe(skippedId);
  });

  it('lets skipped items be completed when they return', () => {
    const db = seed();
    const session = createReviewSession(db, { type: 'unmarked', preload: 5 });
    const skippedId = session.current!.resourceId;
    const afterSkip = submitReviewSessionDecision(db, session.session.id, {
      resourceId: skippedId,
      action: 'skip',
    });

    for (const item of [afterSkip.current, ...afterSkip.next].filter(Boolean)) {
      submitReviewSessionDecision(db, session.session.id, {
        resourceId: item!.resourceId,
        action: 'save_and_next',
        tags: ['reviewed'],
        decision: 'none',
      });
    }
    const returned = getReviewSession(db, session.session.id);
    expect(returned.current?.resourceId).toBe(skippedId);

    const completed = submitReviewSessionDecision(db, session.session.id, {
      resourceId: skippedId,
      action: 'save_and_next',
      tags: ['reviewed_later'],
      decision: 'important',
    });

    expect(completed.current).toBeNull();
    expect(completed.session.status).toBe('completed');
    expect(completed.progress.completed).toBe(5);
  });

  it('duplicate decisions create one annotation', () => {
    const db = seed();
    const session = createReviewSession(db, { type: 'unmarked', preload: 4 });
    const resourceId = session.current!.resourceId;
    const decision = {
      resourceId,
      action: 'save_and_next' as const,
      tags: ['important'],
      decision: 'important' as const,
    };

    submitReviewSessionDecision(db, session.session.id, decision);
    submitReviewSessionDecision(db, session.session.id, decision);

    const annotations = db.prepare('SELECT COUNT(*) AS count FROM user_annotations WHERE target_id = ?').get(resourceId) as { count: number };
    expect(annotations.count).toBe(1);
  });

  it('command-specific session only includes relevant targets', () => {
    const db = seed();
    const session = createReviewSession(db, {
      type: 'ambiguous_command',
      commandText: 'receiver extension',
      preload: 4,
    });
    const titles = [session.current, ...session.next].filter(Boolean).map(item => item!.title ?? '');

    expect(titles.every(title => /receiver|extension/i.test(title))).toBe(true);
  });

  it('unmarked review excludes annotated resources', () => {
    const db = seed();
    const annotated = db.prepare('SELECT id FROM resources ORDER BY title_best LIMIT 1').get() as { id: string };
    db.prepare(`
      INSERT INTO user_annotations (id, target_kind, target_id, tags_json, decision, source, created_at)
      VALUES ('ann_existing', 'resource', ?, '["done"]', 'important', 'focused_review', ?)
    `).run(annotated.id, new Date().toISOString());

    const session = createReviewSession(db, { type: 'unmarked', preload: 4 });
    expect(sessionResourceIds(db, session.session.id)).not.toContain(annotated.id);
  });

  it('extraction failure review only includes failed resources', () => {
    const db = seed();
    const rows = db.prepare('SELECT id FROM resources ORDER BY title_best LIMIT 3').all() as Array<{ id: string }>;
    db.prepare(`
      INSERT INTO extraction_artifacts
        (id, resource_id, recipe_id, artifact_kind, provenance, confidence, status, error_code, extracted_at)
      VALUES
        ('failed_artifact', ?, 'metadata.v1', 'metadata', 'test', 0.2, 'failed_parse', 'parse', ?),
        ('complete_artifact', ?, 'metadata.v1', 'metadata', 'test', 0.9, 'complete', NULL, ?)
    `).run(rows[0].id, new Date().toISOString(), rows[1].id, new Date().toISOString());
    db.prepare(`
      INSERT INTO resource_extraction_state
        (resource_id, recipe_id, adapter_id, dependency_hash, status, attempts, last_error, updated_at)
      VALUES (?, 'metadata.v1', 'adapter', 'hash', 'failed_network', 1, 'timeout', ?)
    `).run(rows[2].id, new Date().toISOString());

    const session = createReviewSession(db, { type: 'extraction_failures', preload: 4 });
    expect(sessionResourceIds(db, session.session.id).sort()).toEqual([rows[0].id, rows[2].id].sort());
  });

  it('source-view weak and conflict queues include items beyond page one without title matching', () => {
    const db = openDatabase(':memory:');
    importSnapshot(db, {
      capturedAt: '2026-06-19T00:00:00.000Z',
      tabs: Array.from({ length: 8 }, (_, index) => ({
        browser: 'chrome' as const,
        title: `Neutral project resource ${index}`,
        url: `https://resource-${index}.example.test/page`,
      })),
    }, 'review_source_view_test');
    const resources = (db.prepare('SELECT id FROM resources ORDER BY title_best').all() as Array<{ id: string }>).map(row => row.id);
    db.prepare(`
      INSERT INTO views (id, name, description, query_json, origin, status, created_at)
      VALUES ('view_review_source', 'Source view', '', '{}', 'codex', 'proposed', ?)
    `).run(new Date().toISOString());
    const insertMembership = db.prepare(`
      INSERT INTO memberships
        (id, target_kind, target_id, view_id, state, section, confidence, reason, evidence_refs)
      VALUES (?, 'resource', ?, 'view_review_source', ?, 'Main', ?, 'Fixture.', '["ev_title"]')
    `);
    resources.forEach((resourceId, index) => {
      insertMembership.run(`mem_source_${index}`, resourceId, index < 6 ? 'weak_include' : 'conflict', 0.4 + index / 100);
    });

    const weak = createReviewSession(db, {
      type: 'weak_matches',
      sourceViewId: 'view_review_source',
      preload: 4,
    });
    const conflict = createReviewSession(db, {
      type: 'conflicts',
      sourceViewId: 'view_review_source',
      preload: 4,
    });

    expect(weak.session.totalItems).toBe(6);
    expect(weak.next).toHaveLength(3);
    expect(sessionResourceIds(db, weak.session.id)).toEqual(resources.slice(0, 6));
    expect(conflict.session.totalItems).toBe(2);
    expect(sessionResourceIds(db, conflict.session.id)).toEqual(resources.slice(6, 8));
    expect([weak.current, ...weak.next].filter(Boolean).every(item => !/weak|conflict/i.test(item!.title ?? ''))).toBe(true);
  });

  it('deduplicates atomic-item memberships to their parent resource', () => {
    const db = seed();
    const resource = db.prepare('SELECT id FROM resources ORDER BY title_best LIMIT 1').get() as { id: string };
    db.prepare(`
      INSERT INTO views (id, name, description, query_json, origin, status, created_at)
      VALUES ('view_atomic_review', 'Atomic review', '', '{}', 'codex', 'proposed', ?)
    `).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO atomic_items (id, resource_id, item_kind, name, evidence_refs, confidence, created_at)
      VALUES ('item_review_atomic', ?, 'idea', 'Extracted idea', '[]', 0.5, ?)
    `).run(resource.id, new Date().toISOString());
    db.prepare(`
      INSERT INTO memberships
        (id, target_kind, target_id, view_id, state, section, confidence, reason, evidence_refs)
      VALUES
        ('mem_resource_review', 'resource', ?, 'view_atomic_review', 'weak_include', 'Main', 0.4, 'Resource.', '["ev_title"]'),
        ('mem_atomic_review', 'atomic_item', 'item_review_atomic', 'view_atomic_review', 'needs_review', 'Main', 0.3, 'Item.', '["ev_title"]')
    `).run(resource.id);

    const session = createReviewSession(db, {
      type: 'ambiguous',
      sourceViewId: 'view_atomic_review',
      preload: 4,
    });

    expect(sessionResourceIds(db, session.session.id)).toEqual([resource.id]);
  });

  it('pause and resume preserve current card', () => {
    const db = seed();
    const session = createReviewSession(db, { type: 'unmarked', preload: 4 });
    const currentId = session.current!.resourceId;

    pauseReviewSession(db, session.session.id);
    const resumed = resumeReviewSession(db, session.session.id);

    expect(resumed.session.status).toBe('active');
    expect(resumed.current?.resourceId).toBe(currentId);
  });
});
