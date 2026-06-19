import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  evaluateFeedbackForIntent,
  saveFeedbackIntentContext,
} from '../preferences/feedbackContextService.js';

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
  scopeMode: z.enum(['view_revision', 'intent', 'global']).default('intent'),
  sourceRevisionId: z.string().optional(),
  sourceCommandText: z.string().optional(),
  sourceGoal: z.string().optional(),
  sourceRules: z.array(z.string()).optional(),
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
  consequence?: {
    scope: 'view_revision' | 'intent' | 'global';
    currentState?: string;
    message: string;
  };
}

type ViewRevisionRow = {
  id: string;
  lineage_id: string;
  view_id: string;
  parent_revision_id: string | null;
  command_id: string | null;
  revision_number: number;
  status: z.infer<typeof ViewRevisionStatus>;
  snapshot_json: string;
  created_at: string;
};

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

export function listViewRevisions(db: Database.Database, viewId: string): ViewRevisionRecord[] {
  const rows = db.prepare(`
    SELECT id, lineage_id, view_id, parent_revision_id, command_id, revision_number, status, snapshot_json, created_at
    FROM view_revisions
    WHERE view_id = ?
    ORDER BY revision_number DESC
  `).all(viewId) as ViewRevisionRow[];
  return rows.map(revisionFromRow);
}

export function getLatestViewRevision(db: Database.Database, viewId: string): ViewRevisionRecord | null {
  const row = db.prepare(`
    SELECT id, lineage_id, view_id, parent_revision_id, command_id, revision_number, status, snapshot_json, created_at
    FROM view_revisions
    WHERE view_id = ?
    ORDER BY revision_number DESC
    LIMIT 1
  `).get(viewId) as ViewRevisionRow | undefined;
  return row ? revisionFromRow(row) : null;
}

export function getViewRevision(db: Database.Database, revisionId: string): ViewRevisionRecord {
  const row = db.prepare(`
    SELECT id, lineage_id, view_id, parent_revision_id, command_id, revision_number, status, snapshot_json, created_at
    FROM view_revisions
    WHERE id = ?
  `).get(revisionId) as ViewRevisionRow | undefined;
  if (!row) throw new Error(`View revision not found: ${revisionId}`);
  return revisionFromRow(row);
}

export function acceptViewRevision(db: Database.Database, revisionId: string): ViewRevisionRecord {
  const revision = getViewRevision(db, revisionId);
  const tx = db.transaction(() => {
    const acceptedRows = db.prepare(`
      SELECT id, view_id
      FROM view_revisions
      WHERE lineage_id = ? AND status = 'accepted' AND id <> ?
    `).all(revision.lineageId, revision.id) as { id: string; view_id: string }[];
    for (const row of acceptedRows) {
      db.prepare(`UPDATE view_revisions SET status = 'superseded' WHERE id = ?`).run(row.id);
      db.prepare(`UPDATE views SET status = 'superseded' WHERE id = ?`).run(row.view_id);
    }
    db.prepare(`UPDATE view_revisions SET status = 'accepted' WHERE id = ?`).run(revision.id);
    db.prepare(`UPDATE views SET status = 'accepted' WHERE id = ?`).run(revision.viewId);
    db.prepare(`UPDATE memberships SET accepted_by_user = 1 WHERE view_id = ?`).run(revision.viewId);
  });
  tx();
  return getViewRevision(db, revisionId);
}

export function rejectViewRevision(db: Database.Database, revisionId: string): ViewRevisionRecord {
  const revision = getViewRevision(db, revisionId);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE view_revisions SET status = 'rejected' WHERE id = ?`).run(revision.id);
    db.prepare(`UPDATE views SET status = 'rejected' WHERE id = ?`).run(revision.viewId);
  });
  tx();
  return getViewRevision(db, revisionId);
}

export function compareViewRevisions(db: Database.Database, leftRevisionId: string, rightRevisionId: string): {
  left: ViewRevisionRecord;
  right: ViewRevisionRecord;
} {
  return {
    left: getViewRevision(db, leftRevisionId),
    right: getViewRevision(db, rightRevisionId),
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
  const source = feedbackSourceContext(db, parsed.viewId);
  saveFeedbackIntentContext(db, {
    feedbackId: id,
    mode: parsed.scopeMode,
    sourceViewId: parsed.viewId,
    sourceRevisionId: parsed.sourceRevisionId ?? source.revisionId,
    sourceCommandText: parsed.sourceCommandText ?? source.commandText,
    sourceGoal: parsed.sourceGoal ?? source.goal,
    sourceRules: parsed.sourceRules ?? source.rules,
  });
  const consequence = applyMembershipFeedbackConsequence(db, parsed);
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
    consequence,
  };
}

export function undoMembershipFeedback(
  db: Database.Database,
  feedbackId: string,
): { undone: true; feedbackId: string; restoredState?: string; message: string } {
  const row = db.prepare(`
    SELECT id, view_id, membership_id, correction_json
    FROM membership_feedback
    WHERE id = ?
  `).get(feedbackId) as { id: string; view_id: string; membership_id: string | null; correction_json: string | null } | undefined;
  if (!row) throw new Error(`Feedback not found: ${feedbackId}`);
  const correction = parseJson(row.correction_json ?? '{}') as { previousMembership?: { state?: string; section?: string; reason?: string; conflictNote?: string } } | undefined;
  const previous = correction?.previousMembership;
  if (row.membership_id && previous?.state) {
    db.prepare(`
      UPDATE memberships
      SET state = ?,
          section = COALESCE(?, section),
          reason = COALESCE(?, reason),
          conflict_note = ?
      WHERE id = ? AND view_id = ?
    `).run(
      previous.state,
      previous.section ?? null,
      previous.reason ?? null,
      previous.conflictNote ?? null,
      row.membership_id,
      row.view_id,
    );
  }
  db.prepare(`DELETE FROM membership_feedback WHERE id = ?`).run(feedbackId);
  return {
    undone: true,
    feedbackId,
    restoredState: previous?.state,
    message: previous?.state
      ? `Removed correction and restored this membership to ${previous.state}.`
      : 'Removed correction. Re-run refinement if this view needs a prior state restored.',
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
  current?: { commandText: string; viewId?: string; revisionId?: string },
): Array<{ kind: 'membership_feedback'; text: string; confidence: number; feedbackId: string }> {
  return listTargetFeedback(db, targetKind, targetId)
    .flatMap(feedback => {
      if (current) {
        const match = evaluateFeedbackForIntent(db, feedback.id, current);
        if (!match.applies) return [];
      }
      return [{
        kind: 'membership_feedback' as const,
        text: [
          `User ${feedback.decision.replace('_', ' ')} for a previous semantic view.`,
          feedback.reason ?? '',
          feedback.correction === undefined ? '' : `Correction: ${JSON.stringify(feedback.correction)}`,
        ].filter(Boolean).join(' '),
        confidence: feedback.decision === 'pin_include' || feedback.decision === 'pin_exclude' ? 1 : 0.95,
        feedbackId: feedback.id,
      }];
    });
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function revisionFromRow(row: ViewRevisionRow): ViewRevisionRecord {
  return {
    id: row.id,
    lineageId: row.lineage_id,
    viewId: row.view_id,
    parentRevisionId: row.parent_revision_id ?? undefined,
    commandId: row.command_id ?? undefined,
    revisionNumber: row.revision_number,
    status: ViewRevisionStatus.parse(row.status),
    snapshot: parseJson(row.snapshot_json),
    createdAt: row.created_at,
  };
}

function feedbackSourceContext(db: Database.Database, viewId: string): {
  revisionId?: string;
  commandText: string;
  goal: string;
  rules: string[];
} {
  const revision = getLatestViewRevision(db, viewId);
  const spec = db.prepare(`
    SELECT command_id, goal, inclusion_rules_json, exclusion_rules_json
    FROM semantic_view_specs
    WHERE view_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(viewId) as {
    command_id: string | null;
    goal: string;
    inclusion_rules_json: string;
    exclusion_rules_json: string;
  } | undefined;
  const command = spec?.command_id
    ? db.prepare(`SELECT text FROM user_commands WHERE id = ?`).get(spec.command_id) as { text: string } | undefined
    : undefined;
  return {
    revisionId: revision?.id,
    commandText: command?.text ?? '',
    goal: spec?.goal ?? '',
    rules: [
      ...parseStringArray(spec?.inclusion_rules_json ?? '[]'),
      ...parseStringArray(spec?.exclusion_rules_json ?? '[]'),
    ],
  };
}

function applyMembershipFeedbackConsequence(
  db: Database.Database,
  input: z.infer<typeof RecordMembershipFeedbackInput>,
): MembershipFeedbackRecord['consequence'] {
  if (!input.membershipId) {
    return {
      scope: input.scopeMode,
      message: `Stored ${input.decision.replace('_', ' ')} feedback for future related views.`,
    };
  }
  const correction = input.correction && typeof input.correction === 'object'
    ? input.correction as { sectionSuggestion?: string; correctedMeaning?: string }
    : {};
  const next = consequenceForDecision(input.decision, correction.sectionSuggestion);
  db.prepare(`
    UPDATE memberships
    SET state = ?,
        section = COALESCE(?, section),
        conflict_note = COALESCE(?, conflict_note),
        reason = COALESCE(?, reason)
    WHERE id = ? AND view_id = ?
  `).run(
    next.state,
    next.section ?? null,
    next.conflictNote ?? null,
    next.reason ?? null,
    input.membershipId,
    input.viewId,
  );
  return {
    scope: input.scopeMode,
    currentState: next.state,
    message: next.message,
  };
}

function consequenceForDecision(
  decision: z.infer<typeof MembershipFeedbackDecision>,
  sectionSuggestion?: string,
): { state: string; section?: string; conflictNote?: string; reason?: string; message: string } {
  if (decision === 'pin_include' || decision === 'accept') {
    return {
      state: 'strong_include',
      section: sectionSuggestion,
      reason: sectionSuggestion ? `User corrected this into ${sectionSuggestion}.` : undefined,
      message: 'This card is now pinned as a strong match in the current view and will influence related intent matches.',
    };
  }
  if (decision === 'pin_exclude' || decision === 'reject') {
    return {
      state: 'conflict',
      conflictNote: 'User excluded this for the current intent; kept visible as a correction consequence.',
      message: 'This card is kept visible as a conflict instead of disappearing, and the exclusion is scoped to this intent.',
    };
  }
  return {
    state: 'needs_review',
    section: sectionSuggestion,
    reason: sectionSuggestion ? `User suggested ${sectionSuggestion}; refine the view to apply the corrected meaning.` : undefined,
    conflictNote: 'User supplied a correction; refine the view to recalculate membership.',
    message: 'This correction is stored and the card remains pending refinement for this intent.',
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
