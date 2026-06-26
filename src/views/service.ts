import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { SemanticViewPlan, type MembershipState } from '../shared/schemas.js';
import { acceptViewRevision, createViewRevision, getLatestViewRevision } from './feedbackService.js';

export type ApplyViewMode = 'proposed' | 'accepted';

export interface PersistedViewPlan {
  commandId: string;
  viewIds: string[];
}

export interface PersistSemanticViewPlanOptions {
  origin?: string;
  parentRevisionId?: string;
  viewIds?: string[];
}

export interface ViewPreview {
  viewId: string;
  name: string;
  status: string;
  goal?: string;
  inclusionRules: string[];
  exclusionRules: string[];
  countsByState: Record<MembershipState, number>;
  countsBySection: Record<string, number>;
  samples: Array<{
    membershipId: string;
    resourceId: string;
    title: string;
    host: string;
    redactedUrl: string;
    state: MembershipState;
    section?: string;
    confidence: number;
    reason: string;
  }>;
}

type ViewRow = {
  id: string;
  name: string;
  status: string;
};

type SpecRow = {
  goal: string;
  inclusion_rules_json: string;
  exclusion_rules_json: string;
};

type MembershipPreviewRow = {
  id: string;
  target_id: string;
  title_best: string | null;
  host: string;
  redacted_url: string;
  state: MembershipState;
  section: string | null;
  confidence: number;
  reason: string | null;
};

export function createUserCommand(db: Database.Database, text: string, parsedIntent?: unknown, id = `cmd_${nanoid()}`): string {
  db.prepare(`
    INSERT INTO user_commands (id, text, created_at, parsed_intent_json, status)
    VALUES (?, ?, ?, ?, 'proposed')
    ON CONFLICT(id) DO NOTHING
  `).run(id, text, new Date().toISOString(), parsedIntent ? JSON.stringify(parsedIntent) : null);
  return id;
}

export function persistSemanticViewPlan(
  db: Database.Database,
  commandId: string,
  rawPlan: unknown,
  optionsOrOrigin: PersistSemanticViewPlanOptions | string = 'heuristic',
): PersistedViewPlan {
  const plan = SemanticViewPlan.parse(rawPlan);
  const options = typeof optionsOrOrigin === 'string' ? { origin: optionsOrOrigin } : optionsOrOrigin;
  const origin = options.origin ?? 'heuristic';
  const now = new Date().toISOString();
  const viewIds: string[] = [];

  const tx = db.transaction(() => {
    for (const [index, view] of plan.views.entries()) {
      const viewId = options.viewIds?.[index] ?? `view_${nanoid()}`;
      const specId = `spec_${nanoid()}`;
      viewIds.push(viewId);

      db.prepare(`
        INSERT INTO views (id, name, description, query_json, origin, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'proposed', ?)
      `).run(
        viewId,
        view.name,
        view.description ?? '',
        JSON.stringify({ commandText: plan.commandText, confidence: view.confidence }),
        origin,
        now,
      );

      db.prepare(`
        INSERT INTO semantic_view_specs
          (id, view_id, command_id, goal, inclusion_rules_json, exclusion_rules_json, section_rules_json, sort_policy, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        specId,
        viewId,
        commandId,
        view.goal,
        JSON.stringify(view.inclusionRules),
        JSON.stringify(view.exclusionRules),
        JSON.stringify(view.sections),
        view.sortPolicy ?? null,
        now,
      );

      for (const membership of view.memberships) {
        validateMembershipEvidence(membership.state, membership.targetId, membership.evidenceRefs);
        db.prepare(`
          INSERT INTO memberships
            (id, target_kind, target_id, view_id, state, section, confidence, reason, conflict_note, evidence_refs, accepted_by_user)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          `mem_${nanoid()}`,
          membership.targetKind,
          membership.targetId,
          viewId,
          membership.state,
          membership.section ?? null,
          membership.confidence,
          membership.reason,
          membership.conflict ?? null,
          JSON.stringify(membership.evidenceRefs),
        );
      }

      createViewRevision(db, {
        viewId,
        parentRevisionId: options.parentRevisionId,
        commandId,
        status: 'proposed',
        snapshot: {
          commandText: plan.commandText,
          view,
        },
      });
    }

    for (const queue of plan.reviewQueues) {
      for (const targetId of reviewQueueResourceIds(db, queue.targetIds)) {
        db.prepare(`
          INSERT INTO review_queue_items (id, resource_id, queue_name, status, reason, priority, created_at)
          VALUES (?, ?, ?, 'pending', ?, 0.4, ?)
          ON CONFLICT(queue_name, resource_id) DO NOTHING
        `).run(`rq_${nanoid()}`, targetId, queue.queueName, queue.reason, now);
      }
    }

    db.prepare(`
      UPDATE user_commands
      SET plan_json = ?, status = 'proposed'
      WHERE id = ?
    `).run(JSON.stringify(plan), commandId);
  });
  tx();

  return { commandId, viewIds };
}

export function previewView(db: Database.Database, viewId: string): ViewPreview {
  const view = db.prepare(`
    SELECT id, name, status
    FROM views
    WHERE id = ?
  `).get(viewId) as ViewRow | undefined;
  if (!view) throw new Error(`View not found: ${viewId}`);

  const spec = db.prepare(`
    SELECT goal, inclusion_rules_json, exclusion_rules_json
    FROM semantic_view_specs
    WHERE view_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(viewId) as SpecRow | undefined;

  const stateRows = db.prepare(`
    SELECT state, COUNT(*) AS count
    FROM memberships
    WHERE view_id = ?
    GROUP BY state
  `).all(viewId) as { state: MembershipState; count: number }[];

  const sectionRows = db.prepare(`
    SELECT COALESCE(section, '(none)') AS section, COUNT(*) AS count
    FROM memberships
    WHERE view_id = ?
    GROUP BY COALESCE(section, '(none)')
  `).all(viewId) as { section: string; count: number }[];

  const sampleRows = db.prepare(`
    SELECT
      m.id,
      m.target_id,
      r.title_best,
      r.host,
      r.redacted_url,
      m.state,
      m.section,
      m.confidence,
      m.reason
    FROM memberships m
    JOIN resources r ON r.id = m.target_id
    WHERE m.view_id = ? AND m.target_kind = 'resource'
    ORDER BY
      CASE m.state
        WHEN 'strong_include' THEN 0
        WHEN 'weak_include' THEN 1
        WHEN 'conflict' THEN 2
        WHEN 'needs_review' THEN 3
        ELSE 4
      END,
      m.confidence DESC
    LIMIT 12
  `).all(viewId) as MembershipPreviewRow[];

  return {
    viewId: view.id,
    name: view.name,
    status: view.status,
    goal: spec?.goal,
    inclusionRules: spec ? parseStringArray(spec.inclusion_rules_json) : [],
    exclusionRules: spec ? parseStringArray(spec.exclusion_rules_json) : [],
    countsByState: countsByState(stateRows),
    countsBySection: Object.fromEntries(sectionRows.map(row => [row.section, row.count])),
    samples: sampleRows.map(row => ({
      membershipId: row.id,
      resourceId: row.target_id,
      title: row.title_best ?? '(untitled)',
      host: row.host,
      redactedUrl: row.redacted_url,
      state: row.state,
      section: row.section ?? undefined,
      confidence: row.confidence,
      reason: row.reason ?? '',
    })),
  };
}

export function applyViewPlan(db: Database.Database, viewId: string, mode: ApplyViewMode): ViewPreview {
  if (mode === 'proposed') {
    db.prepare('UPDATE views SET status = ? WHERE id = ?').run('proposed', viewId);
    return previewView(db, viewId);
  }
  if (mode !== 'accepted') throw new Error(`Unsupported apply mode: ${mode}`);
  const tx = db.transaction(() => {
    const revision = getLatestViewRevision(db, viewId);
    if (revision) acceptViewRevision(db, revision.id);
    else {
      db.prepare('UPDATE views SET status = ? WHERE id = ?').run('accepted', viewId);
      db.prepare('UPDATE memberships SET accepted_by_user = 1 WHERE view_id = ?').run(viewId);
    }
  });
  tx();
  return previewView(db, viewId);
}

export function refineView(db: Database.Database, viewId: string, naturalLanguageEdit: string): string {
  return createUserCommand(db, `Refine ${viewId}: ${naturalLanguageEdit}`, { refinesViewId: viewId });
}

function validateMembershipEvidence(state: MembershipState, targetId: string, evidenceRefs: string[]): void {
  if ((state === 'strong_include' || state === 'weak_include' || state === 'conflict') && evidenceRefs.length === 0) {
    throw new Error(`Membership for ${targetId} in state ${state} requires evidenceRefs`);
  }
}

function reviewQueueResourceIds(db: Database.Database, targetIds: string[]): string[] {
  const resourceExists = db.prepare('SELECT id FROM resources WHERE id = ?');
  const atomicParent = db.prepare('SELECT resource_id FROM atomic_items WHERE id = ?');
  const resolved: string[] = [];
  for (const targetId of targetIds) {
    if (typeof targetId !== 'string' || !targetId) continue;
    const resource = resourceExists.get(targetId) as { id: string } | undefined;
    if (resource) {
      resolved.push(resource.id);
      continue;
    }
    const parent = atomicParent.get(targetId) as { resource_id: string } | undefined;
    if (parent) resolved.push(parent.resource_id);
  }
  return [...new Set(resolved)];
}

function countsByState(rows: { state: MembershipState; count: number }[]): Record<MembershipState, number> {
  const result: Record<MembershipState, number> = {
    strong_include: 0,
    weak_include: 0,
    conflict: 0,
    exclude: 0,
    needs_review: 0,
  };
  for (const row of rows) result[row.state] = row.count;
  return result;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
