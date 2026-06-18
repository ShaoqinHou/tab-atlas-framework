import type Database from 'better-sqlite3';
import {
  AddUserAnnotationInput,
  ExplainMembershipInput,
  ExplainMembershipOutput,
  GetResourceBriefsInput,
  GetResourceBriefsOutput,
  PlanSemanticViewInput,
  PlanSemanticViewOutput,
  SearchResourcesInput,
  SearchResourcesOutput,
} from './toolContracts.js';
import { addUserAnnotation } from '../annotations/service.js';
import { planSemanticView } from '../ai/planSemanticView.js';
import { buildResourceBrief, buildResourceBriefs, buildResourceBriefsForIntent } from '../resources/briefs.js';
import { getReviewNext, submitReviewDecision } from '../review/service.js';
import type { LlmProvider } from '../llm/types.js';

type ResourceSearchRow = {
  id: string;
  redacted_url: string;
  url_kind: string;
  host: string;
  title_best: string | null;
  user_text: string | null;
  extracted_text: string | null;
  browser_groups: string | null;
  annotation_count: number;
};

export function searchResources(db: Database.Database, input: Parameters<typeof SearchResourcesInput.parse>[0]) {
  const parsed = SearchResourcesInput.parse(input);
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (parsed.filters.urlKinds?.length) {
    clauses.push(`r.url_kind IN (${parsed.filters.urlKinds.map(() => '?').join(', ')})`);
    params.push(...parsed.filters.urlKinds);
  }

  if (parsed.filters.annotationStatus === 'marked') {
    clauses.push(`EXISTS (SELECT 1 FROM user_annotations ua WHERE ua.target_kind = 'resource' AND ua.target_id = r.id)`);
  } else if (parsed.filters.annotationStatus === 'unmarked') {
    clauses.push(`NOT EXISTS (SELECT 1 FROM user_annotations ua WHERE ua.target_kind = 'resource' AND ua.target_id = r.id)`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      r.id,
      r.redacted_url,
      r.url_kind,
      r.host,
      r.title_best,
      COALESCE(fts.user_text, '') AS user_text,
      COALESCE(fts.extracted_text, '') AS extracted_text,
      COALESCE((
        SELECT group_concat(DISTINCT tob.group_title)
        FROM tab_observations tob
        WHERE tob.resource_id = r.id AND tob.group_title IS NOT NULL AND tob.group_title <> ''
      ), '') AS browser_groups,
      COALESCE((
        SELECT COUNT(*)
        FROM user_annotations ua
        WHERE ua.target_kind = 'resource' AND ua.target_id = r.id
      ), 0) AS annotation_count
    FROM resources r
    LEFT JOIN resource_fts fts ON fts.resource_id = r.id
    ${where}
    ORDER BY r.last_seen_at DESC
    LIMIT 1000
  `).all(...params) as ResourceSearchRow[];

  const terms = parsed.query.toLowerCase().split(/\s+/).map(term => term.trim()).filter(Boolean);
  const matches = rows
    .map(row => scoreSearchRow(row, terms))
    .filter(match => terms.length === 0 || match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, parsed.filters.limit);

  return SearchResourcesOutput.parse({ matches });
}

export function getResourceBriefs(db: Database.Database, input: Parameters<typeof GetResourceBriefsInput.parse>[0]) {
  const parsed = GetResourceBriefsInput.parse(input);
  return GetResourceBriefsOutput.parse({
    briefs: buildResourceBriefs(db, parsed.resourceIds),
  });
}

export async function planSemanticViewTool(
  db: Database.Database,
  provider: LlmProvider,
  input: Parameters<typeof PlanSemanticViewInput.parse>[0],
) {
  const parsed = PlanSemanticViewInput.parse(input);
  const briefs = parsed.candidateResourceIds.length
    ? buildResourceBriefsForIntent(db, parsed.candidateResourceIds, { commandText: parsed.commandText })
    : [];
  const result = await planSemanticView(provider, parsed.commandText, briefs, parsed.options);
  return PlanSemanticViewOutput.parse(result.value);
}

export function addUserAnnotationTool(db: Database.Database, input: Parameters<typeof AddUserAnnotationInput.parse>[0]) {
  return addUserAnnotation(db, input);
}

export { getReviewNext, submitReviewDecision };

export function explainMembership(db: Database.Database, input: Parameters<typeof ExplainMembershipInput.parse>[0]) {
  const parsed = ExplainMembershipInput.parse(input);
  const row = db.prepare(`
    SELECT confidence, reason, evidence_refs
    FROM memberships
    WHERE target_kind = 'resource' AND target_id = ? AND view_id = ?
    ORDER BY accepted_by_user DESC, confidence DESC
    LIMIT 1
  `).get(parsed.resourceId, parsed.viewId) as { confidence: number; reason: string | null; evidence_refs: string } | undefined;

  if (!row) {
    const brief = buildResourceBrief(db, parsed.resourceId);
    return ExplainMembershipOutput.parse({
      resourceId: parsed.resourceId,
      viewId: parsed.viewId,
      explanation: `No stored membership found. Highest-priority available evidence starts with ${brief.userAnnotations.length} user annotation(s).`,
      evidenceRefs: brief.userAnnotations.flatMap(annotation => annotation.id ? [`user_annotation:${annotation.id}`] : []),
      confidence: 0,
    });
  }

  return ExplainMembershipOutput.parse({
    resourceId: parsed.resourceId,
    viewId: parsed.viewId,
    explanation: row.reason ?? 'Stored membership has no explanation yet.',
    evidenceRefs: parseStringArray(row.evidence_refs),
    confidence: row.confidence,
  });
}

function scoreSearchRow(row: ResourceSearchRow, terms: string[]) {
  const reasons: string[] = [];
  let score = 0;

  for (const term of terms) {
    const title = row.title_best?.toLowerCase() ?? '';
    const url = row.redacted_url.toLowerCase();
    const userText = row.user_text?.toLowerCase() ?? '';
    const extractedText = row.extracted_text?.toLowerCase() ?? '';
    const browserGroups = row.browser_groups?.toLowerCase() ?? '';
    if (userText.includes(term)) {
      score += 5;
      reasons.push(`user annotation matches "${term}"`);
    }
    if (browserGroups.includes(term)) {
      score += 2;
      reasons.push(`browser group matches "${term}"`);
    }
    if (extractedText.includes(term)) {
      score += 2;
      reasons.push(`extracted evidence matches "${term}"`);
    }
    if (title.includes(term)) {
      score += 1.5;
      reasons.push(`title matches "${term}"`);
    }
    if (url.includes(term) || row.host.includes(term) || row.url_kind.includes(term)) {
      score += 1;
      reasons.push(`URL/kind matches "${term}"`);
    }
  }

  if (terms.length === 0) {
    score = row.annotation_count > 0 ? 1 : 0.5;
    reasons.push(row.annotation_count > 0 ? 'marked resource' : 'resource');
  }

  return {
    resourceId: row.id,
    score,
    reasons: [...new Set(reasons)],
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
