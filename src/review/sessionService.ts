import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { addUserAnnotation, getUserAnnotationById } from '../annotations/service.js';
import { buildResourceBrief } from '../resources/briefs.js';
import type { ResourceBrief } from '../shared/schemas.js';
import {
  ReviewSessionCreateInput,
  ReviewSessionDecisionInput,
  REVIEW_KEYBOARD_SHORTCUTS,
  type ReviewSessionCreateInput as ReviewSessionCreateInputValue,
  type ReviewSessionType,
} from './sessionContracts.js';

export interface ReviewSessionSnapshot {
  session: {
    id: string;
    type: ReviewSessionType;
    title?: string;
    status: string;
    commandText?: string;
    sourceViewId?: string;
    currentIndex: number;
    totalItems: number;
    createdAt: string;
    updatedAt: string;
  };
  current: ResourceBrief | null;
  next: ResourceBrief[];
  progress: {
    pending: number;
    completed: number;
    skipped: number;
  };
  keyboardShortcuts: typeof REVIEW_KEYBOARD_SHORTCUTS;
  frequentTags: string[];
}

export function createReviewSession(
  db: Database.Database,
  input: ReviewSessionCreateInputValue = {},
): ReviewSessionSnapshot {
  const parsed = ReviewSessionCreateInput.parse(input);
  const explicitIds = parsed.explicitResourceIds?.length ? parsed.explicitResourceIds : parsed.resourceIds;
  const resourceIds = explicitIds?.length
    ? dedupeIds(explicitIds)
    : selectResourcesForSession(db, parsed.type, {
      commandText: parsed.commandText,
      sourceViewId: parsed.sourceViewId,
    });
  const id = `review_session_${nanoid()}`;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO review_sessions
        (id, session_type, title, status, command_text, source_view_id, filters_json, current_index, total_items, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, '{}', 0, ?, ?, ?)
    `).run(id, parsed.type, parsed.title ?? null, parsed.commandText ?? null, parsed.sourceViewId ?? null, resourceIds.length, now, now);
    const insert = db.prepare(`
      INSERT INTO review_session_items (id, session_id, resource_id, position, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    resourceIds.forEach((resourceId, position) => {
      insert.run(`review_item_${nanoid()}`, id, resourceId, position);
    });
  });
  tx();
  return getReviewSession(db, id, parsed.preload);
}

export function getReviewSession(db: Database.Database, sessionId: string, preload = 4): ReviewSessionSnapshot {
  const session = getSessionRow(db, sessionId);
  const rows = nextSessionItems(db, sessionId, preload);
  const currentRow = rows[0] ?? null;
  return {
    session: {
      id: session.id,
      type: session.session_type,
      title: session.title ?? undefined,
      status: session.status,
      commandText: session.command_text ?? undefined,
      sourceViewId: session.source_view_id ?? undefined,
      currentIndex: session.current_index,
      totalItems: session.total_items,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    },
    current: currentRow ? buildResourceBrief(db, currentRow.resource_id) : null,
    next: rows.slice(1).map(row => buildResourceBrief(db, row.resource_id)),
    progress: sessionProgress(db, sessionId),
    keyboardShortcuts: REVIEW_KEYBOARD_SHORTCUTS,
    frequentTags: frequentTags(db),
  };
}

export function submitReviewSessionDecision(
  db: Database.Database,
  sessionId: string,
  input: unknown,
): ReviewSessionSnapshot {
  const parsed = ReviewSessionDecisionInput.parse(input);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const item = db.prepare(`
      SELECT id, position, status, decision_json
      FROM review_session_items
      WHERE session_id = ? AND resource_id = ?
    `).get(sessionId, parsed.resourceId) as { id: string; position: number; status: string; decision_json: string | null } | undefined;
    if (!item) throw new Error(`Review session item not found: ${parsed.resourceId}`);
    if (item.status === 'completed' && item.decision_json) return;

    if (parsed.action !== 'skip') {
      const annotationId = reviewAnnotationId(sessionId, parsed.resourceId);
      if (!getUserAnnotationById(db, annotationId)) {
        const tags = parsed.action === 'mark_ignore' ? [...parsed.tags, 'ignore'] : parsed.tags;
        addUserAnnotation(db, {
          id: annotationId,
          targetKind: 'resource',
          targetId: parsed.resourceId,
          tags,
          description: parsed.description,
          decision: parsed.action === 'mark_ignore' ? 'ignore' : parsed.decision,
          source: 'focused_review',
          createdAt: now,
        });
      }
    }

    db.prepare(`
      UPDATE review_session_items
      SET status = ?, decision_json = ?, decided_at = ?
      WHERE id = ?
    `).run(parsed.action === 'skip' ? 'skipped' : 'completed', JSON.stringify(parsed), now, item.id);
    const nextPosition = nextPendingPosition(db, sessionId) ?? item.position + 1;
    db.prepare(`
      UPDATE review_sessions
      SET current_index = ?, updated_at = ?,
          status = CASE WHEN ? THEN 'completed' ELSE status END,
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END
      WHERE id = ?
    `).run(nextPosition, now, isSessionDone(db, sessionId) ? 1 : 0, isSessionDone(db, sessionId) ? 1 : 0, now, sessionId);
  });
  tx();
  return getReviewSession(db, sessionId);
}

export function pauseReviewSession(db: Database.Database, sessionId: string): ReviewSessionSnapshot {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE review_sessions
    SET status = 'paused', paused_at = ?, updated_at = ?
    WHERE id = ?
  `).run(now, now, sessionId);
  return getReviewSession(db, sessionId);
}

export function resumeReviewSession(db: Database.Database, sessionId: string): ReviewSessionSnapshot {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE review_sessions
    SET status = 'active', paused_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'paused'
  `).run(now, sessionId);
  return getReviewSession(db, sessionId);
}

function selectResourcesForSession(
  db: Database.Database,
  type: ReviewSessionType,
  input: { commandText?: string; sourceViewId?: string },
): string[] {
  if (type === 'extraction_failures') {
    return dedupeIds((db.prepare(`
      SELECT resource_id AS id
      FROM extraction_artifacts
      WHERE status LIKE 'failed%' OR error_code IS NOT NULL
      UNION
      SELECT resource_id AS id
      FROM resource_extraction_state
      WHERE status LIKE 'failed%' OR last_error IS NOT NULL
      LIMIT 200
    `).all() as Array<{ id: string }>).map(row => row.id));
  }
  if (type === 'weak_matches') {
    return input.sourceViewId ? sourceViewResourceIds(db, input.sourceViewId, ['weak_include', 'needs_review']) : [];
  }
  if (type === 'conflicts') {
    return input.sourceViewId ? sourceViewResourceIds(db, input.sourceViewId, ['conflict']) : [];
  }
  if (type === 'ambiguous') {
    return input.sourceViewId ? sourceViewResourceIds(db, input.sourceViewId, ['weak_include', 'needs_review', 'conflict']) : [];
  }
  const terms = (input.commandText ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 3).slice(0, 10);
  const resources = db.prepare(`
    SELECT r.id, r.title_best, r.host, r.redacted_url,
           COALESCE((
             SELECT group_concat(t.group_title, ' ')
             FROM tab_observations t
             WHERE t.resource_id = r.id
           ), '') AS groups
    FROM resources r
    WHERE NOT EXISTS (
      SELECT 1 FROM user_annotations ua
      WHERE ua.target_kind = 'resource' AND ua.target_id = r.id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM atomic_items ai
        JOIN user_annotations ua ON ua.target_kind = 'atomic_item' AND ua.target_id = ai.id
        WHERE ai.resource_id = r.id
      )
    ORDER BY r.last_seen_at DESC
    LIMIT 500
  `).all() as Array<{ id: string; title_best: string | null; host: string; redacted_url: string; groups: string }>;
  if (!terms.length || type === 'unmarked') return resources.map(row => row.id);
  return resources
    .filter(row => terms.some(term => `${row.title_best ?? ''} ${row.host} ${row.redacted_url} ${row.groups}`.toLowerCase().includes(term)))
    .map(row => row.id);
}

function sourceViewResourceIds(db: Database.Database, sourceViewId: string, states: string[]): string[] {
  if (!states.length) return [];
  const rows = db.prepare(`
    SELECT resource_id, MIN(position) AS first_seen
    FROM (
      SELECT
        CASE
          WHEN m.target_kind = 'resource' THEN m.target_id
          ELSE ai.resource_id
        END AS resource_id,
        m.rowid AS position
      FROM memberships m
      LEFT JOIN atomic_items ai ON ai.id = m.target_id AND m.target_kind = 'atomic_item'
      WHERE m.view_id = ?
        AND m.state IN (${states.map(() => '?').join(',')})
        AND (
          m.target_kind = 'resource'
          OR ai.resource_id IS NOT NULL
        )
    )
    WHERE resource_id IS NOT NULL
    GROUP BY resource_id
    ORDER BY first_seen
  `).all(sourceViewId, ...states) as Array<{ resource_id: string | null }>;
  return rows.flatMap(row => row.resource_id ? [row.resource_id] : []);
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function nextSessionItems(db: Database.Database, sessionId: string, preload: number): Array<{ resource_id: string; position: number }> {
  const rows = db.prepare(`
    SELECT resource_id, position
    FROM review_session_items
    WHERE session_id = ? AND status = 'pending'
    ORDER BY position
    LIMIT ?
  `).all(sessionId, preload) as Array<{ resource_id: string; position: number }>;
  if (rows.length) return rows;
  return db.prepare(`
    SELECT resource_id, position
    FROM review_session_items
    WHERE session_id = ? AND status = 'skipped'
    ORDER BY position
    LIMIT ?
  `).all(sessionId, preload) as Array<{ resource_id: string; position: number }>;
}

function nextPendingPosition(db: Database.Database, sessionId: string): number | null {
  const row = db.prepare(`
    SELECT position
    FROM review_session_items
    WHERE session_id = ? AND status IN ('pending', 'skipped')
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, position
    LIMIT 1
  `).get(sessionId) as { position: number } | undefined;
  return row?.position ?? null;
}

function isSessionDone(db: Database.Database, sessionId: string): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM review_session_items
    WHERE session_id = ? AND status IN ('pending', 'skipped')
  `).get(sessionId) as { count: number };
  return row.count === 0;
}

function sessionProgress(db: Database.Database, sessionId: string): ReviewSessionSnapshot['progress'] {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM review_session_items
    WHERE session_id = ?
    GROUP BY status
  `).all(sessionId) as Array<{ status: string; count: number }>;
  return {
    pending: rows.find(row => row.status === 'pending')?.count ?? 0,
    completed: rows.find(row => row.status === 'completed')?.count ?? 0,
    skipped: rows.find(row => row.status === 'skipped')?.count ?? 0,
  };
}

function frequentTags(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT tags_json
    FROM user_annotations
    ORDER BY created_at DESC
    LIMIT 200
  `).all() as Array<{ tags_json: string }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of parseStringArray(row.tags_json)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag]) => tag);
}

function getSessionRow(db: Database.Database, sessionId: string): ReviewSessionRow {
  const row = db.prepare(`
    SELECT id, session_type, title, status, command_text, source_view_id, current_index, total_items, created_at, updated_at
    FROM review_sessions
    WHERE id = ?
  `).get(sessionId) as ReviewSessionRow | undefined;
  if (!row) throw new Error(`Review session not found: ${sessionId}`);
  return row;
}

function reviewAnnotationId(sessionId: string, resourceId: string): string {
  const digest = crypto.createHash('sha256').update(`${sessionId}\0${resourceId}`).digest('hex').slice(0, 24);
  return `ann_review_${digest}`;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

type ReviewSessionRow = {
  id: string;
  session_type: ReviewSessionType;
  title: string | null;
  status: string;
  command_text: string | null;
  source_view_id: string | null;
  current_index: number;
  total_items: number;
  created_at: string;
  updated_at: string;
};
