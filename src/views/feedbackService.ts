import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  evaluateFeedbackForIntent,
  saveFeedbackIntentContext,
} from '../preferences/feedbackContextService.js';
import { redactSensitiveText } from '../security/urlPrivacy.js';

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

export interface ViewRevisionComparison {
  left: ViewRevisionRecord;
  right: ViewRevisionRecord;
  comparable: boolean;
  unavailableReason?: string;
  summary: {
    added: number;
    removed: number;
    changed: number;
    goalChanged: boolean;
    rulesChanged: boolean;
  };
  changes: {
    addedTargets: RevisionTargetChange[];
    removedTargets: RevisionTargetChange[];
    membershipChanges: RevisionMembershipChange[];
    goalChange?: { from: string; to: string };
    ruleChanges: Array<{ kind: 'added' | 'removed'; rule: string }>;
  };
}

export interface RevisionTargetChange {
  targetKind: 'resource' | 'atomic_item';
  targetId: string;
  parentResourceId?: string;
  title: string;
  host: string;
  state?: string;
  section?: string;
  confidence?: number;
}

export interface RevisionMembershipChange extends RevisionTargetChange {
  before: {
    state: string;
    section?: string;
    confidence: number;
  };
  after: {
    state: string;
    section?: string;
    confidence: number;
  };
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

type MembershipUndoSnapshot = {
  id: string;
  view_id: string;
  target_kind: 'resource' | 'atomic_item';
  target_id: string;
  state: string;
  section: string | null;
  reason: string | null;
  conflict_note: string | null;
  accepted_by_user: number;
};

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
  const latest = getLatestViewRevision(db, viewId);
  const rows = latest
    ? db.prepare(`
        SELECT id, lineage_id, view_id, parent_revision_id, command_id, revision_number, status, snapshot_json, created_at
        FROM view_revisions
        WHERE lineage_id = ?
        ORDER BY revision_number DESC
      `).all(latest.lineageId) as ViewRevisionRow[]
    : db.prepare(`
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

export function compareViewRevisions(db: Database.Database, leftRevisionId: string, rightRevisionId: string): ViewRevisionComparison {
  const left = getViewRevision(db, leftRevisionId);
  const right = getViewRevision(db, rightRevisionId);
  if (left.lineageId !== right.lineageId) {
    return {
      left,
      right,
      comparable: false,
      unavailableReason: 'Revisions are from different lineages.',
      summary: { added: 0, removed: 0, changed: 0, goalChanged: false, rulesChanged: false },
      changes: { addedTargets: [], removedTargets: [], membershipChanges: [], ruleChanges: [] },
    };
  }
  const leftSnapshot = normalizeRevisionSnapshot(left.snapshot);
  const rightSnapshot = normalizeRevisionSnapshot(right.snapshot);
  const leftMembers = new Map(leftSnapshot.memberships.map(member => [memberKey(member), member]));
  const rightMembers = new Map(rightSnapshot.memberships.map(member => [memberKey(member), member]));
  const addedTargets = [...leftMembers.entries()]
    .filter(([key]) => !rightMembers.has(key))
    .map(([, member]) => targetChangeForMember(db, member));
  const removedTargets = [...rightMembers.entries()]
    .filter(([key]) => !leftMembers.has(key))
    .map(([, member]) => targetChangeForMember(db, member));
  const membershipChanges = [...leftMembers.entries()].flatMap(([key, after]) => {
    const before = rightMembers.get(key);
    if (!before || !membershipChanged(before, after)) return [];
    return [{
      ...targetChangeForMember(db, after),
      before: {
        state: before.state,
        section: before.section,
        confidence: before.confidence,
      },
      after: {
        state: after.state,
        section: after.section,
        confidence: after.confidence,
      },
    }];
  });
  const goalChange = leftSnapshot.goal === rightSnapshot.goal ? undefined : {
    from: rightSnapshot.goal,
    to: leftSnapshot.goal,
  };
  const ruleChanges = diffRules(rightSnapshot.rules, leftSnapshot.rules);
  return {
    left,
    right,
    comparable: true,
    summary: {
      added: addedTargets.length,
      removed: removedTargets.length,
      changed: membershipChanges.length,
      goalChanged: Boolean(goalChange),
      rulesChanged: ruleChanges.length > 0,
    },
    changes: {
      addedTargets,
      removedTargets,
      membershipChanges,
      goalChange,
      ruleChanges,
    },
  };
}

export function recordMembershipFeedback(
  db: Database.Database,
  input: z.input<typeof RecordMembershipFeedbackInput>,
): MembershipFeedbackRecord {
  const parsed = RecordMembershipFeedbackInput.parse(input);
  const id = `feedback_${nanoid()}`;
  const createdAt = new Date().toISOString();
  const correction = sanitizeCorrection(parsed.correction);
  const consequence = db.transaction(() => {
    const undo = parsed.membershipId
      ? loadUndoSnapshot(db, {
        membershipId: parsed.membershipId,
        viewId: parsed.viewId,
        targetKind: parsed.targetKind,
        targetId: parsed.targetId,
      })
      : null;
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
      correction === undefined ? null : JSON.stringify(correction),
      parsed.reason ?? null,
      createdAt,
    );
    if (undo) storeUndoSnapshot(db, id, undo, createdAt);
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
    return applyMembershipFeedbackConsequence(db, { ...parsed, correction });
  })();
  return {
    id,
    viewId: parsed.viewId,
    membershipId: parsed.membershipId,
    targetKind: parsed.targetKind,
    targetId: parsed.targetId,
    decision: parsed.decision,
    correction,
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
    SELECT f.id, f.view_id, f.membership_id,
           u.previous_state, u.previous_section, u.previous_reason, u.previous_conflict_note, u.previous_accepted_by_user
    FROM membership_feedback f
    LEFT JOIN membership_feedback_undo u ON u.feedback_id = f.id
    WHERE f.id = ?
  `).get(feedbackId) as {
    id: string;
    view_id: string;
    membership_id: string | null;
    previous_state: string | null;
    previous_section: string | null;
    previous_reason: string | null;
    previous_conflict_note: string | null;
    previous_accepted_by_user: number | null;
  } | undefined;
  if (!row) throw new Error(`Feedback not found: ${feedbackId}`);
  db.transaction(() => {
    if (row.membership_id && row.previous_state) {
      assertLatestFeedbackForMembership(db, feedbackId, row.membership_id);
      db.prepare(`
        UPDATE memberships
        SET state = ?,
            section = ?,
            reason = ?,
            conflict_note = ?,
            accepted_by_user = ?
        WHERE id = ? AND view_id = ?
      `).run(
        row.previous_state,
        row.previous_section,
        row.previous_reason,
        row.previous_conflict_note,
        row.previous_accepted_by_user ?? 0,
        row.membership_id,
        row.view_id,
      );
    }
    db.prepare(`DELETE FROM membership_feedback WHERE id = ?`).run(feedbackId);
  })();
  return {
    undone: true,
    feedbackId,
    restoredState: row.previous_state ?? undefined,
    message: row.previous_state
      ? `Correction undone. Restored this membership to ${row.previous_state}.`
      : 'Correction undone. Re-run refinement if this view needs a prior state restored.',
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

function loadUndoSnapshot(
  db: Database.Database,
  input: {
    membershipId: string;
    viewId: string;
    targetKind: 'resource' | 'atomic_item';
    targetId: string;
  },
): MembershipUndoSnapshot {
  const row = db.prepare(`
    SELECT id, view_id, target_kind, target_id, state, section, reason, conflict_note, accepted_by_user
    FROM memberships
    WHERE id = ? AND view_id = ? AND target_kind = ? AND target_id = ?
  `).get(input.membershipId, input.viewId, input.targetKind, input.targetId) as MembershipUndoSnapshot | undefined;
  if (!row) {
    throw new Error('Membership does not match the supplied view and target');
  }
  return row;
}

function storeUndoSnapshot(
  db: Database.Database,
  feedbackId: string,
  snapshot: MembershipUndoSnapshot,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO membership_feedback_undo
      (feedback_id, membership_id, view_id, target_kind, target_id, previous_state, previous_section,
       previous_reason, previous_conflict_note, previous_accepted_by_user, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    feedbackId,
    snapshot.id,
    snapshot.view_id,
    snapshot.target_kind,
    snapshot.target_id,
    snapshot.state,
    snapshot.section,
    snapshot.reason,
    snapshot.conflict_note,
    snapshot.accepted_by_user,
    createdAt,
  );
}

function assertLatestFeedbackForMembership(
  db: Database.Database,
  feedbackId: string,
  membershipId: string,
): void {
  const latest = db.prepare(`
    SELECT f.id
    FROM membership_feedback f
    JOIN membership_feedback_undo u ON u.feedback_id = f.id
    WHERE f.membership_id = ?
    ORDER BY f.rowid DESC
    LIMIT 1
  `).get(membershipId) as { id: string } | undefined;
  if (latest && latest.id !== feedbackId) {
    throw new Error('Cannot undo a stale correction after a newer correction was applied');
  }
}

function sanitizeCorrection(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const rest = { ...(value as Record<string, unknown>) };
  delete rest.previousMembership;
  return rest;
}

function normalizeRevisionSnapshot(snapshot: unknown): {
  goal: string;
  rules: string[];
  memberships: Array<{
    targetKind: 'resource' | 'atomic_item';
    targetId: string;
    state: string;
    section?: string;
    confidence: number;
  }>;
} {
  const root = snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : {};
  const view = root.view && typeof root.view === 'object' ? root.view as Record<string, unknown> : root;
  const memberships = Array.isArray(view.memberships)
    ? view.memberships.flatMap(item => normalizeRevisionMembership(item))
    : [];
  return {
    goal: stringValue(view.goal),
    rules: [
      ...stringArray(view.rules),
      ...stringArray(view.inclusionRules),
      ...stringArray(view.exclusionRules),
    ],
    memberships,
  };
}

function normalizeRevisionMembership(value: unknown): Array<{
  targetKind: 'resource' | 'atomic_item';
  targetId: string;
  state: string;
  section?: string;
  confidence: number;
}> {
  if (!value || typeof value !== 'object') return [];
  const raw = value as Record<string, unknown>;
  const targetKind = raw.targetKind === 'atomic_item' ? 'atomic_item' : raw.targetKind === 'resource' ? 'resource' : null;
  const targetId = typeof raw.targetId === 'string' ? raw.targetId : '';
  const state = typeof raw.state === 'string' ? raw.state : '';
  if (!targetKind || !targetId || !state) return [];
  return [{
    targetKind,
    targetId,
    state,
    section: typeof raw.section === 'string' ? raw.section : undefined,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
  }];
}

function memberKey(member: { targetKind: string; targetId: string }): string {
  return `${member.targetKind}:${member.targetId}`;
}

function membershipChanged(
  before: { state: string; section?: string; confidence: number },
  after: { state: string; section?: string; confidence: number },
): boolean {
  return before.state !== after.state
    || (before.section ?? '') !== (after.section ?? '')
    || Math.abs(before.confidence - after.confidence) >= 0.001;
}

function targetChangeForMember(
  db: Database.Database,
  member: {
    targetKind: 'resource' | 'atomic_item';
    targetId: string;
    state: string;
    section?: string;
    confidence: number;
  },
): RevisionTargetChange {
  const target = targetInfo(db, member.targetKind, member.targetId);
  return {
    ...target,
    state: member.state,
    section: member.section,
    confidence: member.confidence,
  };
}

function targetInfo(
  db: Database.Database,
  targetKind: 'resource' | 'atomic_item',
  targetId: string,
): Pick<RevisionTargetChange, 'targetKind' | 'targetId' | 'parentResourceId' | 'title' | 'host'> {
  if (targetKind === 'resource') {
    const row = db.prepare(`
      SELECT title_best, host
      FROM resources
      WHERE id = ?
    `).get(targetId) as { title_best: string | null; host: string } | undefined;
    return {
      targetKind,
      targetId,
      title: redactSensitiveText(row?.title_best ?? '(untitled resource)'),
      host: row?.host ?? '',
    };
  }
  const row = db.prepare(`
    SELECT ai.resource_id, ai.name, r.host
    FROM atomic_items ai
    JOIN resources r ON r.id = ai.resource_id
    WHERE ai.id = ?
  `).get(targetId) as { resource_id: string; name: string; host: string } | undefined;
  return {
    targetKind,
    targetId,
    parentResourceId: row?.resource_id,
    title: redactSensitiveText(row?.name ?? '(untitled item)'),
    host: row?.host ?? '',
  };
}

function diffRules(before: string[], after: string[]): Array<{ kind: 'added' | 'removed'; rule: string }> {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...after.filter(rule => !beforeSet.has(rule)).map(rule => ({ kind: 'added' as const, rule })),
    ...before.filter(rule => !afterSet.has(rule)).map(rule => ({ kind: 'removed' as const, rule })),
  ];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
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
