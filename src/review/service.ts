import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { AddUserAnnotationInput, ReviewNextInput, ReviewNextOutput, SubmitReviewDecisionInput } from '../agent/toolContracts.js';
import { addUserAnnotation } from '../annotations/service.js';
import { buildResourceBrief } from '../resources/briefs.js';
import type { ResourceBrief } from '../shared/schemas.js';

type ReviewItemRow = {
  id: string;
  resource_id: string;
  queue_name: string;
  status: 'pending' | 'skipped' | 'completed' | 'dismissed';
  skipped_count: number;
};

export type ReviewNextInputValue = Parameters<typeof ReviewNextInput.parse>[0];
export type SubmitReviewDecisionInputValue = Parameters<typeof SubmitReviewDecisionInput.parse>[0];

export function getReviewNext(db: Database.Database, input: ReviewNextInputValue = {}): ReturnType<typeof ReviewNextOutput.parse> {
  const parsed = ReviewNextInput.parse(input);
  if (parsed.queue === 'unmarked') seedUnmarkedReviewQueue(db);

  const rows = selectReviewRows(db, parsed.queue, parsed.preload + 1, parsed.filters?.urlKinds);
  const current = rows[0] ? briefAndMarkPresented(db, rows[0]) : null;
  const next = rows.slice(1).map(row => buildResourceBrief(db, row.resource_id));

  return ReviewNextOutput.parse({ current, next });
}

export function submitReviewDecision(db: Database.Database, input: SubmitReviewDecisionInputValue): ReturnType<typeof ReviewNextOutput.parse> {
  const parsed = SubmitReviewDecisionInput.parse(input);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    if (parsed.action === 'skip') {
      skipReviewItem(db, parsed.resourceId, 'unmarked', now);
      return;
    }

    const tags = parsed.action === 'mark_ignore' ? [...parsed.tags, 'ignore'] : parsed.tags;
    const decision = parsed.action === 'mark_ignore' ? 'ignore' : parsed.decision;
    if (tags.length || parsed.description || decision !== 'none') {
      addUserAnnotation(db, AddUserAnnotationInput.parse({
        targetKind: 'resource',
        targetId: parsed.resourceId,
        tags,
        description: parsed.description,
        decision,
        source: 'focused_review',
        createdAt: now,
      }));
    }

    completeReviewItem(db, parsed.resourceId, 'unmarked', now);
  });
  tx();

  return getReviewNext(db, { queue: 'unmarked', preload: 2 });
}

export function seedUnmarkedReviewQueue(db: Database.Database): void {
  const now = new Date().toISOString();
  const resources = db.prepare(`
    SELECT r.id
    FROM resources r
    WHERE NOT EXISTS (
      SELECT 1 FROM user_annotations ua
      WHERE ua.target_kind = 'resource' AND ua.target_id = r.id
    )
    ORDER BY r.last_seen_at DESC
  `).all() as { id: string }[];

  const insert = db.prepare(`
    INSERT INTO review_queue_items (id, resource_id, queue_name, status, reason, priority, position, created_at)
    VALUES (?, ?, 'unmarked', 'pending', 'No user tag, note, or decision yet.', 0, ?, ?)
    ON CONFLICT(queue_name, resource_id) DO NOTHING
  `);

  const tx = db.transaction(() => {
    resources.forEach((resource, index) => {
      insert.run(`rq_${nanoid()}`, resource.id, index, now);
    });
  });
  tx();
}

function selectReviewRows(db: Database.Database, queue: string, limit: number, urlKinds?: string[]): ReviewItemRow[] {
  const statusOrder = `
    CASE qi.status
      WHEN 'pending' THEN 0
      WHEN 'skipped' THEN 1
      ELSE 2
    END
  `;
  const params: unknown[] = [queue];
  const urlKindClause = urlKinds?.length
    ? `AND r.url_kind IN (${urlKinds.map(() => '?').join(', ')})`
    : '';
  if (urlKinds?.length) params.push(...urlKinds);
  params.push(limit);

  return db.prepare(`
    SELECT qi.id, qi.resource_id, qi.queue_name, qi.status, qi.skipped_count
    FROM review_queue_items qi
    JOIN resources r ON r.id = qi.resource_id
    WHERE qi.queue_name = ?
      AND qi.status IN ('pending', 'skipped')
      ${urlKindClause}
    ORDER BY ${statusOrder}, qi.priority DESC, COALESCE(qi.position, 999999), qi.created_at
    LIMIT ?
  `).all(...params) as ReviewItemRow[];
}

function briefAndMarkPresented(db: Database.Database, row: ReviewItemRow): ResourceBrief {
  db.prepare(`
    UPDATE review_queue_items
    SET last_presented_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), row.id);
  return buildResourceBrief(db, row.resource_id);
}

function skipReviewItem(db: Database.Database, resourceId: string, queue: string, now: string): void {
  db.prepare(`
    UPDATE review_queue_items
    SET status = 'skipped',
        skipped_count = skipped_count + 1,
        last_presented_at = ?
    WHERE resource_id = ? AND queue_name = ? AND status IN ('pending', 'skipped')
  `).run(now, resourceId, queue);
}

function completeReviewItem(db: Database.Database, resourceId: string, queue: string, now: string): void {
  db.prepare(`
    UPDATE review_queue_items
    SET status = 'completed',
        completed_at = ?
    WHERE resource_id = ? AND queue_name = ?
  `).run(now, resourceId, queue);
}
