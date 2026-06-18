import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import {
  createReviewSession,
  getReviewSession,
  submitReviewSessionDecision,
} from '../src/review/sessionService.js';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

const results: EvalResult[] = [];
results.push(preloadAndShortcuts());
results.push(restartResumePosition());
results.push(skipReappears());
results.push(duplicateDecisionIdempotent());
results.push(commandSpecificTargets());

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Review evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Review evaluation passed: ${results.length}/${results.length} cases.`);

function preloadAndShortcuts(): EvalResult {
  const db = seed();
  const session = createReviewSession(db, { type: 'unmarked', preload: 4 });
  return result(
    'Preload and keyboard contract',
    'current card plus next three cards and shortcut map are returned',
    `current=${Boolean(session.current)}; next=${session.next.length}; skip=${session.keyboardShortcuts.skip}`,
    Boolean(session.current) && session.next.length === 3 && session.keyboardShortcuts.skip === 'S',
  );
}

function restartResumePosition(): EvalResult {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-review-eval-'));
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
  try {
    const resumed = getReviewSession(reopened, session.session.id);
    return result(
      'Restart resumes position',
      'after database reopen, current card advances and completed count remains',
      `currentChanged=${resumed.current?.resourceId !== firstId}; completed=${resumed.progress.completed}`,
      resumed.current?.resourceId !== firstId && resumed.progress.completed === 1,
    );
  } finally {
    reopened.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function skipReappears(): EvalResult {
  const db = seed();
  const session = createReviewSession(db, { type: 'unmarked', preload: 4 });
  const skippedId = session.current!.resourceId;
  const afterSkip = submitReviewSessionDecision(db, session.session.id, { resourceId: skippedId, action: 'skip' });
  for (const item of [afterSkip.current, ...afterSkip.next].filter(Boolean)) {
    submitReviewSessionDecision(db, session.session.id, {
      resourceId: item!.resourceId,
      action: 'save_and_next',
      tags: ['reviewed'],
      decision: 'none',
    });
  }
  const later = getReviewSession(db, session.session.id);
  return result(
    'Skipped item reappears',
    'skip advances immediately but skipped item is not lost',
    `skipped=${skippedId}; later=${later.current?.resourceId ?? '(none)'}`,
    later.current?.resourceId === skippedId,
  );
}

function duplicateDecisionIdempotent(): EvalResult {
  const db = seed();
  const session = createReviewSession(db, { type: 'unmarked', preload: 4 });
  const resourceId = session.current!.resourceId;
  const decision = { resourceId, action: 'save_and_next' as const, tags: ['important'], decision: 'important' as const };
  submitReviewSessionDecision(db, session.session.id, decision);
  submitReviewSessionDecision(db, session.session.id, decision);
  const count = (db.prepare('SELECT COUNT(*) AS count FROM user_annotations WHERE target_id = ?').get(resourceId) as { count: number }).count;
  return result(
    'Duplicate decision idempotency',
    'duplicate review decision creates one annotation',
    `annotations=${count}`,
    count === 1,
  );
}

function commandSpecificTargets(): EvalResult {
  const db = seed();
  const session = createReviewSession(db, { type: 'ambiguous_command', commandText: 'receiver extension', preload: 4 });
  const titles = [session.current, ...session.next].filter(Boolean).map(item => item!.title ?? '');
  return result(
    'Command-specific target filtering',
    'session only contains resources matching command terms',
    titles.join(' | '),
    titles.length > 0 && titles.every(title => /receiver|extension/i.test(title)),
  );
}

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
  }, 'review_eval');
  return db;
}

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}
