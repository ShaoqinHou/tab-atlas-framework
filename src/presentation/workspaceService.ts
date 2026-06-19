import type Database from 'better-sqlite3';
import { z } from 'zod';
import { buildResourceBrief, buildResourceBriefsForIntent } from '../resources/briefs.js';
import { redactSensitiveText, redactUrlForPrompt } from '../security/urlPrivacy.js';
import { MembershipState, SemanticViewPlan, type ResourceBrief } from '../shared/schemas.js';
import {
  EvidenceStrength,
  TargetInspector,
  ViewSectionPage,
  type TargetInspector as TargetInspectorType,
  type ViewSectionPage as ViewSectionPageType,
  type ViewWorkspaceArtifact as ViewWorkspaceArtifactType,
  type VisualResourceCard,
} from './contracts.js';
import { projectSemanticViewWorkspace } from './projectWorkspace.js';

const TargetKind = z.enum(['resource', 'atomic_item']);
type TargetKind = z.infer<typeof TargetKind>;

export interface WorkspaceRequestOptions {
  maxCardsPerSection?: number;
  generatedAt?: string;
}

export function getViewWorkspace(
  db: Database.Database,
  viewId: string,
  options: WorkspaceRequestOptions = {},
): ViewWorkspaceArtifactType {
  const loaded = loadViewPlan(db, viewId);
  const resourceIds = resourceIdsForPlan(db, loaded.plan);
  const briefs = buildResourceBriefsForIntent(db, resourceIds, {
    commandText: loaded.plan.commandText,
    viewId,
  });
  return projectSemanticViewWorkspace(loaded.plan, briefs, {
    maxCardsPerSection: options.maxCardsPerSection ?? 24,
    generatedAt: options.generatedAt,
  });
}

export function getViewSectionPage(
  db: Database.Database,
  viewId: string,
  sectionId: string,
  input: { cursor?: number; limit?: number } = {},
): ViewSectionPageType {
  const cursor = Math.max(0, input.cursor ?? 0);
  const limit = Math.min(Math.max(1, input.limit ?? 24), 100);
  const workspace = getViewWorkspace(db, viewId, { maxCardsPerSection: 10_000 });
  const section = workspace.sections.find(candidate => candidate.id === sectionId || slug(candidate.title) === sectionId);
  if (!section) throw new Error(`Section not found: ${sectionId}`);
  const cards = section.cards.slice(cursor, cursor + limit);
  const nextCursor = cursor + cards.length < section.totalCount ? cursor + cards.length : null;
  return ViewSectionPage.parse({
    viewId,
    sectionId: section.id,
    title: section.title,
    totalCount: section.totalCount,
    cursor,
    nextCursor,
    limit,
    cards,
  });
}

export function getTargetInspector(
  db: Database.Database,
  input: {
    targetKind: string;
    targetId: string;
    viewId?: string;
  },
): TargetInspectorType {
  const targetKind = TargetKind.parse(input.targetKind);
  const target = loadTargetBrief(db, targetKind, input.targetId);
  const card = input.viewId ? cardForTarget(db, input.viewId, targetKind, input.targetId) : undefined;
  const membership = input.viewId ? membershipForTarget(db, input.viewId, targetKind, input.targetId, target.brief) : undefined;
  return TargetInspector.parse({
    targetKind,
    targetId: input.targetId,
    parentResourceId: targetKind === 'atomic_item' ? target.brief.resourceId : undefined,
    title: targetKind === 'atomic_item' ? target.atomicItem?.name ?? '(untitled item)' : target.brief.title ?? '(untitled)',
    host: target.brief.host,
    urlKind: target.brief.urlKind,
    safeOpenUrl: redactUrlForPrompt(target.brief.redactedUrl ?? target.brief.canonicalUrl),
    visualKind: card?.visualKind ?? (targetKind === 'atomic_item' ? 'atomic_item' : visualKindForBrief(target.brief)),
    media: card?.media,
    currentViewMembership: membership,
    summary: targetKind === 'atomic_item' ? target.atomicItem?.summary : target.brief.summary,
    userNotes: target.brief.userAnnotations.map(annotation => ({
      id: annotation.id,
      tags: annotation.tags.map(redactSensitiveText),
      description: annotation.description ? redactSensitiveText(annotation.description) : undefined,
      decision: annotation.decision,
      source: annotation.source,
      createdAt: annotation.createdAt,
    })),
    evidence: evidenceForInspector(target.brief, membership?.evidenceStrength),
    technicalEvidenceRefs: card?.evidenceRefs ?? [],
    extractionStatus: target.brief.extractionStatus,
    atomicItems: target.brief.atomicItems.map(item => ({
      itemId: item.itemId,
      itemKind: item.itemKind,
      name: item.name,
      summary: item.summary,
      confidence: item.confidence,
    })),
    relatedViews: relatedViews(db, targetKind, input.targetId),
    relatedResources: relatedResources(db, target.brief.resourceId, target.brief.host),
  });
}

function loadViewPlan(db: Database.Database, viewId: string): { plan: z.infer<typeof SemanticViewPlan>; commandId?: string } {
  const view = db.prepare(`
    SELECT id, name, description, query_json, status
    FROM views
    WHERE id = ?
  `).get(viewId) as ViewRow | undefined;
  if (!view) throw new Error(`View not found: ${viewId}`);

  const spec = db.prepare(`
    SELECT command_id, goal, inclusion_rules_json, exclusion_rules_json, section_rules_json, sort_policy
    FROM semantic_view_specs
    WHERE view_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(viewId) as SpecRow | undefined;

  const command = spec?.command_id
    ? db.prepare(`SELECT text FROM user_commands WHERE id = ?`).get(spec.command_id) as { text: string } | undefined
    : undefined;

  const rows = db.prepare(`
    SELECT id, target_kind, target_id, state, section, confidence, reason, conflict_note, evidence_refs
    FROM memberships
    WHERE view_id = ?
    ORDER BY
      CASE state
        WHEN 'strong_include' THEN 0
        WHEN 'weak_include' THEN 1
        WHEN 'conflict' THEN 2
        WHEN 'needs_review' THEN 3
        ELSE 4
      END,
      confidence DESC
  `).all(viewId) as MembershipRow[];

  const query = parseRecord(view.query_json);
  const commandText = command?.text
    ?? (typeof query.commandText === 'string' ? query.commandText : `Open ${view.name}`);

  return {
    commandId: spec?.command_id ?? undefined,
    plan: SemanticViewPlan.parse({
      commandText,
      views: [{
        name: view.name,
        goal: spec?.goal ?? view.description ?? view.name,
        description: view.description ?? undefined,
        inclusionRules: parseStringArray(spec?.inclusion_rules_json),
        exclusionRules: parseStringArray(spec?.exclusion_rules_json),
        sections: parseStringArray(spec?.section_rules_json),
        sortPolicy: spec?.sort_policy ?? undefined,
        confidence: typeof query.confidence === 'number' ? query.confidence : 0.5,
        memberships: rows.map(row => ({
          targetKind: row.target_kind,
          targetId: row.target_id,
          section: row.section ?? undefined,
          state: row.state,
          confidence: row.confidence,
          reason: row.reason ?? '',
          evidenceRefs: parseStringArray(row.evidence_refs),
          conflict: row.conflict_note ?? undefined,
        })),
      }],
      reviewQueues: [],
      explanation: view.description ?? '',
    }),
  };
}

function resourceIdsForPlan(db: Database.Database, plan: z.infer<typeof SemanticViewPlan>): string[] {
  const ids = new Set<string>();
  const atomicIds: string[] = [];
  for (const view of plan.views) {
    for (const membership of view.memberships) {
      if (membership.targetKind === 'resource') ids.add(membership.targetId);
      else atomicIds.push(membership.targetId);
    }
  }
  if (atomicIds.length) {
    const rows = db.prepare(`
      SELECT resource_id
      FROM atomic_items
      WHERE id IN (${atomicIds.map(() => '?').join(',')})
    `).all(...atomicIds) as Array<{ resource_id: string }>;
    for (const row of rows) ids.add(row.resource_id);
  }
  return [...ids];
}

function cardForTarget(
  db: Database.Database,
  viewId: string,
  targetKind: TargetKind,
  targetId: string,
): VisualResourceCard | undefined {
  const workspace = getViewWorkspace(db, viewId, { maxCardsPerSection: 10_000 });
  return [...workspace.sections.flatMap(section => section.cards), ...workspace.reviewLane]
    .find(card => card.targetKind === targetKind && card.targetId === targetId);
}

function membershipForTarget(
  db: Database.Database,
  viewId: string,
  targetKind: TargetKind,
  targetId: string,
  brief: ResourceBrief,
): TargetInspectorType['currentViewMembership'] {
  const row = db.prepare(`
    SELECT id, state, section, confidence, reason, evidence_refs
    FROM memberships
    WHERE view_id = ? AND target_kind = ? AND target_id = ?
    LIMIT 1
  `).get(viewId, targetKind, targetId) as Pick<MembershipRow, 'id' | 'state' | 'section' | 'confidence' | 'reason' | 'evidence_refs'> | undefined;
  if (!row) return undefined;
  const evidenceRefs = parseStringArray(row.evidence_refs);
  return {
    viewId,
    membershipId: row.id,
    state: row.state,
    section: row.section ?? undefined,
    confidence: row.confidence,
    reason: row.reason ?? '',
    evidenceStrength: evidenceStrengthFor(evidenceRefs, brief),
  };
}

function loadTargetBrief(
  db: Database.Database,
  targetKind: TargetKind,
  targetId: string,
): { brief: ResourceBrief; atomicItem?: ResourceBrief['atomicItems'][number] } {
  if (targetKind === 'resource') return { brief: buildResourceBrief(db, targetId) };
  const row = db.prepare(`
    SELECT resource_id
    FROM atomic_items
    WHERE id = ?
  `).get(targetId) as { resource_id: string } | undefined;
  if (!row) throw new Error(`Atomic item not found: ${targetId}`);
  const brief = buildResourceBrief(db, row.resource_id);
  const atomicItem = brief.atomicItems.find(item => item.itemId === targetId);
  if (!atomicItem) throw new Error(`Atomic item not found in brief: ${targetId}`);
  return { brief, atomicItem };
}

function evidenceForInspector(brief: ResourceBrief, membershipStrength?: EvidenceStrength): TargetInspectorType['evidence'] {
  const userEvidence = brief.userAnnotations.map(annotation => ({
    label: 'User note',
    kind: 'user_annotation',
    text: redactSensitiveText([annotation.description, annotation.tags.join(', ')].filter(Boolean).join(' - ') || annotation.decision),
    provenance: redactSensitiveText(annotation.source),
    confidence: 1,
  }));
  const extracted = brief.evidence.map(item => ({
    label: labelForEvidence(item.kind, item.provenance, membershipStrength),
    kind: item.kind,
    text: redactSensitiveText(item.text),
    provenance: redactSensitiveText(item.provenance),
    confidence: item.confidence,
  }));
  return [...userEvidence, ...extracted].slice(0, 20);
}

function relatedViews(db: Database.Database, targetKind: TargetKind, targetId: string): TargetInspectorType['relatedViews'] {
  const rows = db.prepare(`
    SELECT v.id, v.name, m.state, m.section
    FROM memberships m
    JOIN views v ON v.id = m.view_id
    WHERE m.target_kind = ? AND m.target_id = ?
    ORDER BY v.created_at DESC
    LIMIT 8
  `).all(targetKind, targetId) as Array<{ id: string; name: string; state: z.infer<typeof MembershipState>; section: string | null }>;
  return rows.map(row => ({
    viewId: row.id,
    name: row.name,
    state: row.state,
    section: row.section ?? undefined,
  }));
}

function relatedResources(db: Database.Database, resourceId: string, host: string): TargetInspectorType['relatedResources'] {
  const rows = db.prepare(`
    SELECT id, title_best, host
    FROM resources
    WHERE host = ? AND id <> ?
    ORDER BY last_seen_at DESC
    LIMIT 6
  `).all(host, resourceId) as Array<{ id: string; title_best: string | null; host: string }>;
  return rows.map(row => ({
    resourceId: row.id,
    title: row.title_best ?? '(untitled)',
    host: row.host,
  }));
}

function evidenceStrengthFor(refs: string[], brief: ResourceBrief): EvidenceStrength {
  if (refs.some(ref => ref.startsWith('user_annotation:'))) return 'user_direct';
  if (refs.some(ref => ref.startsWith('feedback:'))) return 'user_feedback';
  const referenced = brief.evidence.filter(evidence => refs.includes(evidence.id));
  if (referenced.some(evidence => /(transcript|description|metadata|article|chapter|manual)/i.test(`${evidence.kind} ${evidence.provenance}`))) {
    return 'verified_content';
  }
  if (refs.some(ref => /codex|analysis|planner/i.test(ref))
      || referenced.some(evidence => /codex|analysis/i.test(`${evidence.kind} ${evidence.provenance}`))) {
    return 'generated_analysis';
  }
  return 'title_only';
}

function labelForEvidence(kind: string, provenance: string, membershipStrength?: EvidenceStrength): string {
  if (/feedback/i.test(provenance)) return 'Prior correction';
  if (/transcript|description|metadata|article|manual/i.test(`${kind} ${provenance}`)) return 'Verified content';
  if (/codex|analysis/i.test(`${kind} ${provenance}`)) return 'AI analysis';
  if (membershipStrength === 'user_direct') return 'User note';
  return 'Title only';
}

function visualKindForBrief(brief: ResourceBrief): TargetInspectorType['visualKind'] {
  if (brief.urlKind.startsWith('youtube_')) return 'video';
  if (brief.urlKind.startsWith('github_')) return 'repository';
  if (brief.urlKind === 'docs' || brief.urlKind === 'pdf') return 'document';
  if (brief.urlKind === 'search') return 'search';
  if (brief.urlKind === 'web_page') return 'article';
  return 'unknown';
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'section';
}

type ViewRow = {
  id: string;
  name: string;
  description: string | null;
  query_json: string | null;
  status: string;
};

type SpecRow = {
  command_id: string | null;
  goal: string;
  inclusion_rules_json: string;
  exclusion_rules_json: string;
  section_rules_json: string;
  sort_policy: string | null;
};

type MembershipRow = {
  id: string;
  target_kind: TargetKind;
  target_id: string;
  state: z.infer<typeof MembershipState>;
  section: string | null;
  confidence: number;
  reason: string | null;
  conflict_note: string | null;
  evidence_refs: string;
};
