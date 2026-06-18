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
