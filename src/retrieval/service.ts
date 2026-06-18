import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import {
  fallbackRetrievalPlan,
  RetrievalPlan,
  type RetrievalCandidate,
  type RetrievalMetrics,
  type RetrievalSource,
} from './queryPlan.js';

export interface RetrievalRunResult {
  runId: string;
  plan: RetrievalPlan;
  candidates: RetrievalCandidate[];
  selectedResourceIds: string[];
  metrics: RetrievalMetrics;
}

type CandidateInput = {
  targetKind: 'resource' | 'atomic_item';
  targetId: string;
  resourceId: string;
  source: RetrievalSource;
  text: string;
  baseScore: number;
  reason: string;
};

export function retrieveCandidatesForCommand(
  db: Database.Database,
  commandText: string,
  options: { maxCandidates?: number; knownRelevantResourceIds?: string[] } = {},
): RetrievalRunResult {
  const plan = fallbackRetrievalPlan(commandText, options.maxCandidates ?? 200);
  const terms = termsForPlan(plan);
  const merged = new Map<string, RetrievalCandidate>();

  for (const query of plan.queries) {
      const sourceRows = rowsForSource(db, query.source, query.limit);
    for (const row of sourceRows) {
      const score = scoreText(row.text, terms) * query.weight + row.baseScore;
      if (terms.length && score <= row.baseScore && query.source !== 'recent') continue;
      addCandidate(merged, row, score);
    }
  }

  if (plan.includeUserMarkedForTaste) {
    for (const row of rowsForSource(db, 'user_annotations', 500)) {
      addCandidate(merged, row, 100 + row.baseScore);
    }
  }

  const candidates = [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, plan.maxCandidates);
  const selectedResourceIds = [...new Set(candidates.map(candidate => candidate.resourceId))].slice(0, plan.maxPromptResources);
  const metrics = metricsFor(candidates, selectedResourceIds, options.knownRelevantResourceIds ?? []);
  const runId = persistRetrievalRun(db, commandText, plan, candidates, selectedResourceIds, metrics);
  return { runId, plan, candidates, selectedResourceIds, metrics };
}

function rowsForSource(db: Database.Database, source: RetrievalSource, limit: number): CandidateInput[] {
  switch (source) {
    case 'user_annotations':
      return (db.prepare(`
        SELECT target_kind, target_id, tags_json, description, decision
        FROM user_annotations
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit) as Array<{ target_kind: 'resource' | 'atomic_item'; target_id: string; tags_json: string; description: string | null; decision: string }>)
        .map(row => ({
          targetKind: row.target_kind,
          targetId: row.target_id,
          resourceId: row.target_kind === 'resource' ? row.target_id : resourceIdForAtomicItem(db, row.target_id),
          source,
          text: `${row.tags_json} ${row.description ?? ''} ${row.decision}`,
          baseScore: 8,
          reason: 'user annotation evidence',
        }))
        .filter(row => row.resourceId);
    case 'membership_feedback':
      return (db.prepare(`
        SELECT target_kind, target_id, decision, reason
        FROM membership_feedback
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit) as Array<{ target_kind: 'resource' | 'atomic_item'; target_id: string; decision: string; reason: string | null }>)
        .map(row => ({
          targetKind: row.target_kind,
          targetId: row.target_id,
          resourceId: row.target_kind === 'resource' ? row.target_id : resourceIdForAtomicItem(db, row.target_id),
          source,
          text: `${row.decision} ${row.reason ?? ''}`,
          baseScore: 6,
          reason: 'membership feedback evidence',
        }))
        .filter(row => row.resourceId);
    case 'atomic_items':
      return (db.prepare(`
        SELECT id, resource_id, item_kind, name, summary
        FROM atomic_items
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit) as Array<{ id: string; resource_id: string; item_kind: string; name: string; summary: string | null }>)
        .map(row => ({
          targetKind: 'atomic_item',
          targetId: row.id,
          resourceId: row.resource_id,
          source,
          text: `${row.item_kind} ${row.name} ${row.summary ?? ''}`,
          baseScore: 5,
          reason: `atomic item ${row.item_kind}`,
        }));
    case 'extracted_evidence':
      return (db.prepare(`
        SELECT resource_id, artifact_kind, text_excerpt, json_payload
        FROM extraction_artifacts
        ORDER BY extracted_at DESC
        LIMIT ?
      `).all(limit) as Array<{ resource_id: string; artifact_kind: string; text_excerpt: string | null; json_payload: string | null }>)
        .map(row => ({
          targetKind: 'resource',
          targetId: row.resource_id,
          resourceId: row.resource_id,
          source,
          text: `${row.artifact_kind} ${row.text_excerpt ?? ''} ${row.json_payload ?? ''}`,
          baseScore: 3,
          reason: `extracted ${row.artifact_kind}`,
        }));
    case 'codex_scan':
      return (db.prepare(`
        SELECT resource_id, text_excerpt, json_payload
        FROM extraction_artifacts
        WHERE recipe_id = 'codex_resource_analysis.v1'
        ORDER BY extracted_at DESC
        LIMIT ?
      `).all(limit) as Array<{ resource_id: string; text_excerpt: string | null; json_payload: string | null }>)
        .map(row => ({
          targetKind: 'resource',
          targetId: row.resource_id,
          resourceId: row.resource_id,
          source,
          text: `${row.text_excerpt ?? ''} ${row.json_payload ?? ''}`,
          baseScore: 4,
          reason: 'Codex scan summary/topics',
        }));
    case 'browser_groups':
      return (db.prepare(`
        SELECT resource_id, group_title, title
        FROM tab_observations
        WHERE COALESCE(group_title, '') <> ''
        ORDER BY id DESC
        LIMIT ?
      `).all(limit) as Array<{ resource_id: string; group_title: string | null; title: string | null }>)
        .map(row => ({
          targetKind: 'resource',
          targetId: row.resource_id,
          resourceId: row.resource_id,
          source,
          text: `${row.group_title ?? ''} ${row.title ?? ''}`,
          baseScore: 2,
          reason: 'browser group/title',
        }));
    case 'fts':
      return (db.prepare(`
        SELECT resource_id, title, url, user_text, extracted_text
        FROM resource_fts
        LIMIT ?
      `).all(limit) as Array<{ resource_id: string; title: string; url: string; user_text: string; extracted_text: string }>)
        .map(row => ({
          targetKind: 'resource',
          targetId: row.resource_id,
          resourceId: row.resource_id,
          source,
          text: `${row.title} ${row.url} ${row.user_text} ${row.extracted_text}`,
          baseScore: 1,
          reason: 'FTS title/url/text',
        }));
    case 'recent':
      return (db.prepare(`
        SELECT id, title_best, host, redacted_url, url_kind
        FROM resources
        ORDER BY last_seen_at DESC
        LIMIT ?
      `).all(limit) as Array<{ id: string; title_best: string | null; host: string; redacted_url: string; url_kind: string }>)
        .map(row => ({
          targetKind: 'resource',
          targetId: row.id,
          resourceId: row.id,
          source,
          text: `${row.title_best ?? ''} ${row.host} ${row.redacted_url} ${row.url_kind}`,
          baseScore: 0.25,
          reason: 'recent resource fallback',
        }));
    default:
      return [];
  }
}

function addCandidate(map: Map<string, RetrievalCandidate>, input: CandidateInput, score: number): void {
  const key = `${input.targetKind}:${input.targetId}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      targetKind: input.targetKind,
      targetId: input.targetId,
      resourceId: input.resourceId,
      score,
      sources: [input.source],
      reasons: [input.reason],
    });
    return;
  }
  existing.score += score;
  if (!existing.sources.includes(input.source)) existing.sources.push(input.source);
  if (!existing.reasons.includes(input.reason)) existing.reasons.push(input.reason);
}

function termsForPlan(plan: RetrievalPlan): string[] {
  return [...new Set(plan.queries.flatMap(query => query.query.toLowerCase().split(/[^a-z0-9_]+/))
    .map(term => term.trim())
    .filter(term => term.length >= 2 && !STOP_WORDS.has(term)))];
}

function scoreText(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) score += term.length > 4 ? 2 : 1;
  }
  return score;
}

function metricsFor(candidates: RetrievalCandidate[], selectedResourceIds: string[], knownRelevant: string[]): RetrievalMetrics {
  const sourceCoverage: Partial<Record<RetrievalSource, number>> = {};
  for (const candidate of candidates) {
    for (const source of candidate.sources) sourceCoverage[source] = (sourceCoverage[source] ?? 0) + 1;
  }
  const selected = new Set(selectedResourceIds);
  const known = knownRelevant.length ? knownRelevant : selectedResourceIds;
  return {
    candidateCount: candidates.length,
    selectedCount: selectedResourceIds.length,
    sourceCoverage,
    userMarkedRecall: recallFor(candidates.filter(candidate => candidate.sources.includes('user_annotations')).map(candidate => candidate.resourceId), selected),
    knownRelevantRecall: recallFor(known, selected),
    atomicItemRecall: recallFor(candidates.filter(candidate => candidate.targetKind === 'atomic_item').map(candidate => candidate.resourceId), selected),
    uncertainCount: candidates.filter(candidate => candidate.score < 2).length,
  };
}

function recallFor(ids: string[], selected: Set<string>): number {
  const unique = [...new Set(ids)];
  if (!unique.length) return 1;
  return unique.filter(id => selected.has(id)).length / unique.length;
}

function persistRetrievalRun(
  db: Database.Database,
  commandText: string,
  plan: RetrievalPlan,
  candidates: RetrievalCandidate[],
  selectedResourceIds: string[],
  metrics: RetrievalMetrics,
): string {
  const id = `retrieval_${nanoid()}`;
  db.prepare(`
    INSERT INTO retrieval_runs
      (id, command_text, provider, plan_json, metrics_json, candidate_count, selected_count, source_coverage_json, created_at)
    VALUES (?, ?, 'deterministic_multi_source', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    commandText,
    JSON.stringify(plan),
    JSON.stringify({ ...metrics, sample: candidates.slice(0, 20) }),
    candidates.length,
    selectedResourceIds.length,
    JSON.stringify(metrics.sourceCoverage),
    new Date().toISOString(),
  );
  return id;
}

function resourceIdForAtomicItem(db: Database.Database, itemId: string): string {
  const row = db.prepare('SELECT resource_id FROM atomic_items WHERE id = ?').get(itemId) as { resource_id: string } | undefined;
  return row?.resource_id ?? '';
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'but', 'by', 'for', 'from', 'group', 'include', 'into',
  'make', 'mainly', 'mostly', 'of', 'or', 'the', 'this', 'to', 'view', 'with',
]);
