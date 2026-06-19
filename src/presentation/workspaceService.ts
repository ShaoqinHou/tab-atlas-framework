import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
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
  const view = loadViewHeader(db, viewId);
  const limit = clampLimit(options.maxCardsPerSection ?? 24, 1, 100);
  const sectionSummaries = loadSectionSummaries(db, viewId, view.sections);
  const sections = sectionSummaries.map(section => {
    const rows = loadMembershipRows(db, {
      viewId,
      sectionTitle: section.title,
      cursor: 0,
      limit,
      includeExcluded: false,
    });
    return {
      id: section.id,
      title: section.title,
      description: undefined,
      totalCount: section.totalCount,
      visibleCount: Math.min(section.totalCount, rows.length),
      collapsedByDefault: false,
      cards: cardsForRows(db, view, rows),
    };
  });
  const reviewRows = loadReviewRows(db, viewId, 40);
  const counts = countStates(db, viewId);
  const included = counts.strong_include + counts.weak_include;

  return {
    kind: 'semantic_view_workspace',
    viewName: view.name,
    goal: view.goal,
    commandText: view.commandText,
    layout: 'board',
    headline: `${included} useful matches across ${sections.length} ${sections.length === 1 ? 'section' : 'sections'}`,
    subhead: summarySentence(counts),
    stats: [
      { id: 'strong', label: 'Strong matches', value: counts.strong_include, tone: 'positive' },
      { id: 'weak', label: 'Weak matches', value: counts.weak_include, tone: 'warning' },
      { id: 'conflict', label: 'Conflicts', value: counts.conflict, tone: counts.conflict ? 'danger' : 'neutral' },
      { id: 'review', label: 'Needs review', value: counts.needs_review, tone: counts.needs_review ? 'warning' : 'neutral' },
    ],
    sections,
    reviewLane: cardsForRows(db, view, reviewRows),
    hiddenExcludedCount: counts.exclude,
    suggestedPrompts: suggestedPrompts(view.name, counts),
    availableLayouts: ['board', 'gallery', 'map', 'compact'],
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
}

export function getViewSectionPage(
  db: Database.Database,
  viewId: string,
  sectionId: string,
  input: { cursor?: number; limit?: number } = {},
): ViewSectionPageType {
  const cursor = Math.max(0, input.cursor ?? 0);
  const limit = clampLimit(input.limit ?? 24, 1, 100);
  const view = loadViewHeader(db, viewId);
  const section = loadSectionSummaries(db, viewId, view.sections)
    .find(candidate => candidate.id === sectionId || slug(candidate.title) === sectionId);
  if (!section) throw new Error(`Section not found: ${sectionId}`);
  const rows = loadMembershipRows(db, {
    viewId,
    sectionTitle: section.title,
    cursor,
    limit,
    includeExcluded: false,
  });
  const cards = cardsForRows(db, view, rows);
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
  const membershipRow = input.viewId ? membershipRowForTarget(db, input.viewId, targetKind, input.targetId) : undefined;
  const card = input.viewId && membershipRow ? cardForMembershipRow(db, input.viewId, membershipRow) : undefined;
  const membership = input.viewId && membershipRow ? membershipForRow(input.viewId, membershipRow, target.brief) : undefined;
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
    technicalEvidenceRefs: membershipRow ? parseStringArray(membershipRow.evidence_refs) : [],
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

function loadViewHeader(db: Database.Database, viewId: string): ViewHeader {
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
  const query = parseRecord(view.query_json);
  return {
    viewId,
    name: view.name,
    description: view.description ?? undefined,
    goal: spec?.goal ?? view.description ?? view.name,
    commandText: command?.text ?? (typeof query.commandText === 'string' ? query.commandText : `Open ${view.name}`),
    inclusionRules: parseStringArray(spec?.inclusion_rules_json),
    exclusionRules: parseStringArray(spec?.exclusion_rules_json),
    sections: parseStringArray(spec?.section_rules_json),
    sortPolicy: spec?.sort_policy ?? undefined,
    confidence: typeof query.confidence === 'number' ? query.confidence : 0.5,
  };
}

function cardForMembershipRow(
  db: Database.Database,
  viewId: string,
  row: MembershipRow,
): VisualResourceCard | undefined {
  const view = loadViewHeader(db, viewId);
  return cardsForRows(db, view, [row])[0];
}

function membershipForRow(
  viewId: string,
  row: Pick<MembershipRow, 'id' | 'state' | 'section' | 'confidence' | 'reason' | 'evidence_refs'>,
  brief: ResourceBrief,
): TargetInspectorType['currentViewMembership'] {
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

function membershipRowForTarget(
  db: Database.Database,
  viewId: string,
  targetKind: TargetKind,
  targetId: string,
): MembershipRow | undefined {
  return db.prepare(`
    SELECT id, target_kind, target_id, state, section, confidence, reason, conflict_note, evidence_refs
    FROM memberships
    WHERE view_id = ? AND target_kind = ? AND target_id = ?
    LIMIT 1
  `).get(viewId, targetKind, targetId) as MembershipRow | undefined;
}

function loadSectionSummaries(db: Database.Database, viewId: string, declaredSections: string[]): SectionSummary[] {
  const rows = db.prepare(`
    SELECT COALESCE(section, '') AS section, COUNT(*) AS total_count
    FROM memberships
    WHERE view_id = ? AND state <> 'exclude'
    GROUP BY COALESCE(section, '')
  `).all(viewId) as Array<{ section: string; total_count: number }>;
  const byTitle = new Map(rows.map(row => [row.section || 'Main matches', row.total_count]));
  const titles = [
    ...declaredSections,
    ...rows.map(row => row.section || 'Main matches'),
  ].filter((title, index, all) => title && all.indexOf(title) === index);
  return titles
    .map(title => ({
      id: sectionId(title),
      title,
      totalCount: byTitle.get(title) ?? 0,
    }))
    .filter(section => section.totalCount > 0);
}

function loadMembershipRows(
  db: Database.Database,
  input: {
    viewId: string;
    sectionTitle: string;
    cursor: number;
    limit: number;
    includeExcluded: boolean;
  },
): MembershipRow[] {
  return db.prepare(`
    SELECT id, target_kind, target_id, state, section, confidence, reason, conflict_note, evidence_refs
    FROM memberships
    WHERE view_id = ?
      AND COALESCE(section, 'Main matches') = ?
      ${input.includeExcluded ? '' : "AND state <> 'exclude'"}
    ORDER BY
      CASE state
        WHEN 'strong_include' THEN 0
        WHEN 'weak_include' THEN 1
        WHEN 'conflict' THEN 2
        WHEN 'needs_review' THEN 3
        ELSE 4
      END,
      confidence DESC,
      target_id ASC
    LIMIT ? OFFSET ?
  `).all(input.viewId, input.sectionTitle, input.limit, input.cursor) as MembershipRow[];
}

function loadReviewRows(db: Database.Database, viewId: string, limit: number): MembershipRow[] {
  return db.prepare(`
    SELECT id, target_kind, target_id, state, section, confidence, reason, conflict_note, evidence_refs
    FROM memberships
    WHERE view_id = ? AND state IN ('weak_include', 'conflict', 'needs_review')
    ORDER BY
      CASE state
        WHEN 'weak_include' THEN 0
        WHEN 'conflict' THEN 1
        WHEN 'needs_review' THEN 2
        ELSE 3
      END,
      confidence DESC,
      target_id ASC
    LIMIT ?
  `).all(viewId, limit) as MembershipRow[];
}

function countStates(db: Database.Database, viewId: string): Record<z.infer<typeof MembershipState>, number> {
  const counts = {
    strong_include: 0,
    weak_include: 0,
    conflict: 0,
    exclude: 0,
    needs_review: 0,
  };
  const rows = db.prepare(`
    SELECT state, COUNT(*) AS count
    FROM memberships
    WHERE view_id = ?
    GROUP BY state
  `).all(viewId) as Array<{ state: z.infer<typeof MembershipState>; count: number }>;
  for (const row of rows) counts[row.state] = row.count;
  return counts;
}

function cardsForRows(db: Database.Database, view: ViewHeader, rows: MembershipRow[]): VisualResourceCard[] {
  if (!rows.length) return [];
  const resourceIds = resourceIdsForRows(db, rows);
  const briefs = buildResourceBriefsForIntent(db, resourceIds, {
    commandText: view.commandText,
    viewId: view.viewId,
  });
  const plan = SemanticViewPlan.parse({
    commandText: view.commandText,
    views: [{
      name: view.name,
      goal: view.goal,
      description: view.description,
      inclusionRules: view.inclusionRules,
      exclusionRules: view.exclusionRules,
      sections: view.sections.length ? view.sections : [...new Set(rows.map(row => row.section ?? 'Main matches'))],
      sortPolicy: view.sortPolicy,
      confidence: view.confidence,
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
  });
  return projectSemanticViewWorkspace(plan, briefs, { maxCardsPerSection: rows.length })
    .sections.flatMap(section => section.cards)
    .sort((left, right) => compareCards(left, right));
}

function resourceIdsForRows(db: Database.Database, rows: MembershipRow[]): string[] {
  const ids = new Set<string>();
  const atomicIds: string[] = [];
  for (const row of rows) {
    if (row.target_kind === 'resource') ids.add(row.target_id);
    else atomicIds.push(row.target_id);
  }
  if (atomicIds.length) {
    const found = db.prepare(`
      SELECT resource_id
      FROM atomic_items
      WHERE id IN (${atomicIds.map(() => '?').join(',')})
    `).all(...atomicIds) as Array<{ resource_id: string }>;
    for (const row of found) ids.add(row.resource_id);
  }
  return [...ids];
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

function summarySentence(counts: Record<z.infer<typeof MembershipState>, number>): string {
  const parts = [
    counts.weak_include ? `${counts.weak_include} weak` : '',
    counts.conflict ? `${counts.conflict} conflicting` : '',
    counts.needs_review ? `${counts.needs_review} needing review` : '',
  ].filter(Boolean);
  return parts.length
    ? `${parts.join(', ')}. Excluded resources stay hidden until requested.`
    : 'All visible matches have strong supporting evidence.';
}

function suggestedPrompts(viewName: string, counts: Record<z.infer<typeof MembershipState>, number>): string[] {
  return [
    counts.weak_include ? 'Hide weak matches.' : '',
    counts.conflict ? 'Show only conflicts and explain them.' : '',
    counts.needs_review ? 'Start a quick review of uncertain items.' : '',
    `Split ${viewName} into practical and inspirational sections.`,
    'Show this as a visual gallery.',
  ].filter(Boolean);
}

function compareCards(left: VisualResourceCard, right: VisualResourceCard): number {
  return stateRank(left.state) - stateRank(right.state)
    || right.confidence - left.confidence
    || left.targetId.localeCompare(right.targetId);
}

function stateRank(state: z.infer<typeof MembershipState>): number {
  switch (state) {
    case 'strong_include': return 0;
    case 'weak_include': return 1;
    case 'conflict': return 2;
    case 'needs_review': return 3;
    case 'exclude': return 4;
  }
}

function clampLimit(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, Math.floor(Number.isFinite(value) ? value : min)), max);
}

function sectionId(title: string): string {
  return `${slug(title)}-${crypto.createHash('sha1').update(title).digest('hex').slice(0, 6)}`;
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

type ViewHeader = {
  viewId: string;
  name: string;
  description?: string;
  goal: string;
  commandText: string;
  inclusionRules: string[];
  exclusionRules: string[];
  sections: string[];
  sortPolicy?: string;
  confidence: number;
};

type SectionSummary = {
  id: string;
  title: string;
  totalCount: number;
};
