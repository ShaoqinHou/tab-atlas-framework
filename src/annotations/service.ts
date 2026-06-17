import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { AddUserAnnotationInput } from '../agent/toolContracts.js';
import { UserAnnotation, type AnnotationDecision } from '../shared/schemas.js';
import { refreshResourceSearchText } from '../resources/searchIndex.js';

type AnnotationRow = {
  id: string;
  target_kind: 'resource' | 'atomic_item';
  target_id: string;
  tags_json: string;
  description: string | null;
  decision: AnnotationDecision;
  source: 'focused_review' | 'resource_detail' | 'agent_chat' | 'bulk_edit' | 'import';
  created_at: string;
  updated_at: string | null;
};

export type AddAnnotationInput = Parameters<typeof AddUserAnnotationInput.parse>[0];

export function addUserAnnotation(db: Database.Database, input: AddAnnotationInput): UserAnnotation {
  const parsed = AddUserAnnotationInput.parse(input);
  const now = parsed.createdAt ?? new Date().toISOString();
  const id = parsed.id ?? `ann_${nanoid()}`;
  const tags = normalizeTags(parsed.tags);

  db.prepare(`
    INSERT INTO user_annotations (id, target_kind, target_id, tags_json, description, decision, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    parsed.targetKind,
    parsed.targetId,
    JSON.stringify(tags),
    parsed.description ?? null,
    parsed.decision,
    parsed.source,
    now,
    now,
  );

  if (parsed.targetKind === 'resource') refreshResourceSearchText(db, parsed.targetId);

  return UserAnnotation.parse({
    id,
    targetKind: parsed.targetKind,
    targetId: parsed.targetId,
    tags,
    description: parsed.description,
    decision: parsed.decision,
    source: parsed.source,
    createdAt: now,
    updatedAt: now,
  });
}

export function getUserAnnotations(db: Database.Database, targetKind: 'resource' | 'atomic_item', targetId: string): UserAnnotation[] {
  const rows = db.prepare(`
    SELECT id, target_kind, target_id, tags_json, description, decision, source, created_at, updated_at
    FROM user_annotations
    WHERE target_kind = ? AND target_id = ?
    ORDER BY created_at DESC
  `).all(targetKind, targetId) as AnnotationRow[];

  return rows.map(annotationFromRow);
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))];
}

function annotationFromRow(row: AnnotationRow): UserAnnotation {
  return UserAnnotation.parse({
    id: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    tags: parseTags(row.tags_json),
    description: row.description ?? undefined,
    decision: row.decision,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  });
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
