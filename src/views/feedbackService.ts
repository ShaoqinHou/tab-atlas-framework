import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export const ViewRevisionStatus = z.enum(['proposed', 'accepted', 'superseded', 'rejected']);
export const MembershipFeedbackDecision = z.enum(['accept', 'reject', 'correct', 'pin_include', 'pin_exclude']);

export const CreateViewRevisionInput = z.object({
  viewId: z.string(),
  parentRevisionId: z.string().optional(),
  lineageId: z.string().optional(),
  commandId: z.string().optional(),
  status: ViewRevisionStatus.default('proposed'),
  snapshot: z.unknown(),
});

export const RecordMembershipFeedbackInput = z.object({
  viewId: z.string(),
  membershipId: z.string().optional(),
  targetKind: z.enum(['resource', 'atomic_item']),
  targetId: z.string(),
  decision: MembershipFeedbackDecision,
  correction: z.unknown().optional(),
  reason: z.string().optional(),
});

export interface ViewRevisionRecord {
  id: string;
  lineageId: string;
  viewId: string;
  parentRevisionId?: string;
  commandId?: string;
  revisionNumber: number;
  status: z.infer<typeof ViewRevisionStatus>;
  snapshot: unknown;
  createdAt: string;
}

export interface MembershipFeedbackRecord {
  id: string;
  viewId: string;
  membershipId?: string;
  targetKind: 'resource' | 'atomic_item';
  targetId: string;
  decision: z.infer<typeof MembershipFeedbackDecision>;
  correction?: unknown;
  reason?: string;
  createdAt: string;
}

export function createViewRevision(
  db: Database.Database,
  input: z.input<typeof CreateViewRevisionInput>,
): ViewRevisionRecord {
  const parsed = CreateViewRevisionInput.parse(input);
  const parent = parsed.parentRevisionId
    ? db.prepare(`
        SELECT lineage_id, revision_number
        FROM view_revisions
        WHERE id = ?
      `).get(parsed.parentRevisionId) as { lineage_id: string; revision_number: number } | undefined
    : undefined;
  if (parsed.parentRevisionId && !parent) throw new Error(`Parent revision not found: ${parsed.parentRevisionId}`);

  const lineageId = parent?.lineage_id ?? parsed.lineageId ?? `lineage_${nanoid()}`;
  const latest = db.prepare(`
    SELECT COALESCE(MAX(revision_number), 0) AS revision_number
    FROM view_revisions
    WHERE lineage_id = ?
  `).get(lineageId) as { revision_number: number };
  const revisionNumber = Math.max(parent?.revision_number ?? 0, latest.revision_number) + 1;
  const id = `revision_${nanoid()}`;
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO view_revisions
      (id, lineage_id, view_id, parent_revision_id, command_id, revision_number, status, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    lineageId,
    parsed.viewId,
    parsed.parentRevisionId ?? null,
    parsed.commandId ?? null,
    revisionNumber,
    parsed.status,
    JSON.stringify(parsed.snapshot),
    createdAt,
  );

  return {
    id,
    lineageId,
    viewId: parsed.viewId,
    parentRevisionId: parsed.parentRevisionId,
    commandId: parsed.commandId,
    revisionNumber,
    status: parsed.status,
    snapshot: parsed.snapshot,
    createdAt,
  };
}

export function recordMembershipFeedback(
  db: Database.Database,
  input: z.input<typeof RecordMembershipFeedbackInput>,
): MembershipFeedbackRecord {
  const parsed = RecordMembershipFeedbackInput.parse(input);
  const id = `feedback_${nanoid()}`;
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO membership_feedback
      (id, view_id, membership_id, target_kind, target_id, decision, correction_json, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    parsed.viewId,
    parsed.membershipId ?? null,
    parsed.targetKind,
    parsed.targetId,
    parsed.decision,
    parsed.correction === undefined ? null : JSON.stringify(parsed.correction),
    parsed.reason ?? null,
    createdAt,
  );
  return {
    id,
    viewId: parsed.viewId,
    membershipId: parsed.membershipId,
    targetKind: parsed.targetKind,
    targetId: parsed.targetId,
    decision: parsed.decision,
    correction: parsed.correction,
    reason: parsed.reason,
    createdAt,
  };
}

export function listTargetFeedback(
  db: Database.Database,
  targetKind: 'resource' | 'atomic_item',
  targetId: string,
): MembershipFeedbackRecord[] {
  const rows = db.prepare(`
    SELECT id, view_id, membership_id, target_kind, target_id, decision, correction_json, reason, created_at
    FROM membership_feedback
    WHERE target_kind = ? AND target_id = ?
    ORDER BY created_at DESC
  `).all(targetKind, targetId) as Array<{
    id: string;
    view_id: string;
    membership_id: string | null;
    target_kind: 'resource' | 'atomic_item';
    target_id: string;
    decision: z.infer<typeof MembershipFeedbackDecision>;
    correction_json: string | null;
    reason: string | null;
    created_at: string;
  }>;
  return rows.map(row => ({
    id: row.id,
    viewId: row.view_id,
    membershipId: row.membership_id ?? undefined,
    targetKind: row.target_kind,
    targetId: row.target_id,
    decision: MembershipFeedbackDecision.parse(row.decision),
    correction: row.correction_json ? parseJson(row.correction_json) : undefined,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  }));
}

/** Compact high-priority evidence that can be added to future ResourceBriefs. */
export function buildPreferenceEvidence(
  db: Database.Database,
  targetKind: 'resource' | 'atomic_item',
  targetId: string,
): Array<{ kind: 'membership_feedback'; text: string; confidence: number; feedbackId: string }> {
  return listTargetFeedback(db, targetKind, targetId).map(feedback => ({
    kind: 'membership_feedback' as const,
    text: [
      `User ${feedback.decision.replace('_', ' ')} for a previous semantic view.`,
      feedback.reason ?? '',
      feedback.correction === undefined ? '' : `Correction: ${JSON.stringify(feedback.correction)}`,
    ].filter(Boolean).join(' '),
    confidence: feedback.decision === 'pin_include' || feedback.decision === 'pin_exclude' ? 1 : 0.95,
    feedbackId: feedback.id,
  }));
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
