import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { CheckpointStore } from '../acceptance/checkpointStore.js';
import type { LlmProvider, LlmUsage } from '../llm/types.js';
import { runStructured } from '../llm/runStructured.js';
import {
  SemanticViewPlan,
  type MembershipState,
  type ResourceBrief as ResourceBriefType,
} from '../shared/schemas.js';
import { projectResourceBriefsForPrompt, redactSensitiveText } from '../security/urlPrivacy.js';
import { PROMPT_REDACTION_VERSION } from '../security/urlPrivacy.js';
import { planSemanticView, type PlanSemanticViewOptions } from './planSemanticView.js';
import {
  compactChunkDecisions,
  HierarchicalMergeInput,
  SemanticChunkResult,
  type SemanticChunkResult as SemanticChunkResultType,
} from './hierarchicalPlannerContracts.js';
import {
  chunkCheckpointKey,
  hierarchicalEvidenceFingerprint,
  unresolvedTargetDescriptors,
  validateSemanticChunkCoverage,
  type HierarchicalPlannerIdentity,
} from './hierarchicalPlannerSafety.js';
import { repairSemanticViewPlanCandidate, semanticViewPlanJsonContract } from './semanticViewPlanRepair.js';

export interface HierarchicalPlanningOptions extends PlanSemanticViewOptions {
  maxDirectResources?: number;
  maxDirectPromptBytes?: number;
  chunkSize?: number;
  checkpointPath?: string;
  db?: Database.Database;
  retrievalRunId?: string;
  providerIdentity?: Partial<HierarchicalPlannerIdentity>;
  plannerVersion?: string;
}

export interface HierarchicalPlanningResult {
  value: SemanticViewPlan;
  usage: LlmUsage;
  attempts: number;
  mode: 'direct' | 'hierarchical';
  chunkCount: number;
  splitChunkCount: number;
  failedChunkCount: number;
  checkpointPath?: string;
  runId?: string;
  evidenceFingerprint?: string;
}

const DEFAULT_MAX_DIRECT_RESOURCES = 60;
const DEFAULT_MAX_DIRECT_PROMPT_BYTES = 60_000;
const DEFAULT_CHUNK_SIZE = 40;

export async function planSemanticViewHierarchical(
  provider: LlmProvider,
  commandText: string,
  briefs: ResourceBriefType[],
  options: HierarchicalPlanningOptions = {},
): Promise<HierarchicalPlanningResult> {
  const maxDirectResources = options.maxDirectResources ?? DEFAULT_MAX_DIRECT_RESOURCES;
  const maxDirectPromptBytes = options.maxDirectPromptBytes ?? DEFAULT_MAX_DIRECT_PROMPT_BYTES;
  const promptBytes = Buffer.byteLength(JSON.stringify(projectResourceBriefsForPrompt(briefs)), 'utf8');
  if (briefs.length <= maxDirectResources && promptBytes <= maxDirectPromptBytes) {
    const direct = await planSemanticView(provider, commandText, briefs, options);
    return {
      ...direct,
      mode: 'direct',
      chunkCount: 0,
      splitChunkCount: 0,
      failedChunkCount: 0,
    };
  }

  const checkpointPath = options.checkpointPath ?? path.join(process.cwd(), '.local', 'hierarchical-semantic-chunks.json');
  const store = new CheckpointStore<SemanticChunkResultType>(checkpointPath);
  const identity = identityFor(commandText, options);
  const evidenceFingerprint = hierarchicalEvidenceFingerprint(briefs, identity);
  const runId = options.db ? ensureHierarchicalRun(options.db, {
    commandText,
    retrievalRunId: options.retrievalRunId,
    identity,
    evidenceFingerprint,
    targetCount: targetIdSet(briefs).size,
    chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
  }) : undefined;
  const system = await fs.readFile(new URL('../../knowledge/prompts/semantic-view-planner.system.md', import.meta.url), 'utf8');
  const chunks = chunkBriefs(briefs, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const usage: LlmUsage = {};
  const results: SemanticChunkResultType[] = [];
  let attempts = 0;
  let splitChunkCount = 0;
  let failedChunkCount = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? [];
    const chunkFingerprint = chunkCheckpointKey({ runFingerprint: evidenceFingerprint, ordinal: index, briefs: chunk });
    const chunkId = chunkIdFor(chunkFingerprint, index);
    const cached = options.db
      ? readHierarchicalChunk(options.db, runId!, chunkFingerprint)?.result
      : store.get(chunkId)?.result;
    if (cached) {
      results.push(cached);
      continue;
    }
    if (options.db) startHierarchicalChunk(options.db, runId!, chunkId, index, chunkFingerprint, chunk);
    else store.start(chunkId);
    try {
      const result = await runChunk(provider, commandText, chunkId, chunk, system);
      accumulateUsage(usage, result.usage);
      attempts += result.attempts;
      if (options.db) finishHierarchicalChunk(options.db, chunkId, 'passed', result.value, result.usage, result.attempts);
      else store.pass(chunkId, result.value);
      results.push(result.value);
    } catch (error) {
      if (chunk.length <= 1) {
        const failed = failedChunkResult(commandText, chunkId, chunk, error);
        failedChunkCount += 1;
        if (options.db) finishHierarchicalChunk(options.db, chunkId, 'failed', failed, {}, 1, error);
        else store.fail(chunkId, error);
        results.push(failed);
        continue;
      }
      splitChunkCount += 1;
      if (options.db) finishHierarchicalChunk(options.db, chunkId, 'failed', failedChunkResult(commandText, chunkId, chunk, error), {}, 1, error);
      else store.fail(chunkId, error);
      const midpoint = Math.ceil(chunk.length / 2);
      const left = chunk.slice(0, midpoint);
      const right = chunk.slice(midpoint);
      for (const [offset, suffix, split] of [[0, 'a', left], [1, 'b', right]] as const) {
        const splitOrdinal = (index * 10) + offset + 1;
        const splitFingerprint = chunkCheckpointKey({ runFingerprint: evidenceFingerprint, ordinal: splitOrdinal, briefs: split });
        const splitId = `${chunkId}-${suffix}`;
        const cachedSplit = options.db
          ? readHierarchicalChunk(options.db, runId!, splitFingerprint)?.result
          : store.get(splitId)?.result;
        if (cachedSplit) {
          results.push(cachedSplit);
          continue;
        }
        if (options.db) startHierarchicalChunk(options.db, runId!, splitId, splitOrdinal, splitFingerprint, split, chunkId);
        else store.start(splitId);
        try {
          const splitResult = await runChunk(provider, commandText, splitId, split, system);
          accumulateUsage(usage, splitResult.usage);
          attempts += splitResult.attempts;
          if (options.db) finishHierarchicalChunk(options.db, splitId, 'passed', splitResult.value, splitResult.usage, splitResult.attempts);
          else store.pass(splitId, splitResult.value);
          results.push(splitResult.value);
        } catch (splitError) {
          const failed = failedChunkResult(commandText, splitId, split, splitError);
          failedChunkCount += 1;
          if (options.db) finishHierarchicalChunk(options.db, splitId, 'failed', failed, {}, 1, splitError);
          else store.fail(splitId, splitError);
          results.push(failed);
        }
      }
    }
  }

  const mergeInput = HierarchicalMergeInput.parse({
    commandText,
    chunkResults: results,
    conflicts: compactChunkDecisions(results),
  });
  const merged = await runStructured(provider, mergePrompt(commandText, mergeInput), SemanticViewPlan, {
    system,
    maxRetries: 2,
    repair: value => repairSemanticViewPlanCandidate(commandText, value),
    semanticValidate: planValidator(briefs),
  });
  accumulateUsage(usage, merged.usage);
  attempts += merged.attempts;
  const finalPlan = surfaceUnresolvedTargets(merged.value, results, briefs);
  if (options.db && runId) {
    completeHierarchicalRun(options.db, runId, failedChunkCount > 0 ? 'completed_with_degraded_chunks' : 'passed', finalPlan, usage);
  }
  return {
    value: finalPlan,
    usage,
    attempts,
    mode: 'hierarchical',
    chunkCount: results.length,
    splitChunkCount,
    failedChunkCount,
    checkpointPath,
    runId,
    evidenceFingerprint,
  };
}

async function runChunk(
  provider: LlmProvider,
  commandText: string,
  chunkId: string,
  briefs: ResourceBriefType[],
  system: string,
) {
  return runStructured(provider, chunkPrompt(commandText, chunkId, briefs), SemanticChunkResult, {
    system,
    maxRetries: 1,
    semanticValidate: chunkValidator(commandText, chunkId, briefs),
  });
}

function chunkPrompt(commandText: string, chunkId: string, briefs: ResourceBriefType[]): string {
  return [
    'Classify this deterministic chunk for a later semantic-view merge.',
    'Return only SemanticChunkResult JSON. Preserve evidence refs from the supplied briefs.',
    '',
    `Command: ${redactSensitiveText(commandText)}`,
    `Chunk ID: ${chunkId}`,
    '',
    'For each relevant resource or atomic item, create one decision.',
    'Use needs_review for unresolved targets instead of dropping them.',
    '',
    JSON.stringify({ resources: projectResourceBriefsForPrompt(briefs) }, null, 2),
  ].join('\n');
}

function mergePrompt(commandText: string, input: HierarchicalMergeInput): string {
  return [
    'Merge these SemanticChunkResult decisions into the ordinary SemanticViewPlan schema.',
    'Do not invent URLs, titles, private text, or target IDs. Preserve evidence refs.',
    'Targets with unresolved or conflicting chunk decisions should become needs_review or conflict memberships.',
    semanticViewPlanJsonContract(),
    '',
    `Command: ${redactSensitiveText(commandText)}`,
    '',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

function chunkValidator(commandText: string, chunkId: string, briefs: ResourceBriefType[]) {
  const targetIds = targetIdSet(briefs);
  const evidenceIds = evidenceIdSet(briefs);
  return (value: SemanticChunkResultType): string[] => {
    const errors: string[] = [];
    if (value.commandText !== commandText) errors.push('commandText does not match input command');
    if (value.chunkId !== chunkId) errors.push('chunkId does not match requested chunk');
    errors.push(...validateSemanticChunkCoverage(value, briefs));
    for (const decision of value.decisions) {
      if (!targetIds.has(decision.targetId)) errors.push(`unknown chunk targetId ${decision.targetId}`);
      for (const ref of decision.evidenceRefs) {
        if ((ref.startsWith('ev_') || ref.startsWith('user_annotation:') || ref.startsWith('feedback:')) && !evidenceIds.has(ref)) {
          errors.push(`unknown evidence ref ${ref}`);
        }
      }
    }
    return errors;
  };
}

function planValidator(briefs: ResourceBriefType[]) {
  const targetIds = targetIdSet(briefs);
  const evidenceIds = evidenceIdSet(briefs);
  return (value: SemanticViewPlan): string[] => {
    const errors: string[] = [];
    for (const view of value.views) {
      if (view.inclusionRules.length === 0) errors.push(`view ${view.name} has no inclusionRules`);
      for (const membership of view.memberships) {
        if (!targetIds.has(membership.targetId)) errors.push(`membership references unknown targetId ${membership.targetId}`);
        if (membership.state !== 'exclude' && membership.evidenceRefs.length === 0) {
          errors.push(`membership for ${membership.targetId} has no evidenceRefs`);
        }
        for (const ref of membership.evidenceRefs) {
          if ((ref.startsWith('ev_') || ref.startsWith('user_annotation:') || ref.startsWith('feedback:')) && !evidenceIds.has(ref)) {
            errors.push(`membership for ${membership.targetId} references unknown evidence ${ref}`);
          }
        }
      }
    }
    for (const queue of value.reviewQueues) {
      for (const targetId of queue.targetIds) {
        if (!targetIds.has(targetId)) errors.push(`review queue ${queue.queueName} references unknown targetId ${targetId}`);
      }
    }
    return errors;
  };
}

function surfaceUnresolvedTargets(plan: SemanticViewPlan, chunks: SemanticChunkResultType[], briefs: ResourceBriefType[]): SemanticViewPlan {
  const unresolved = unresolvedTargetDescriptors(chunks, briefs);
  if (!unresolved.length || !plan.views[0]) return plan;
  const existing = new Set(plan.views.flatMap(view => view.memberships.map(membership => membership.targetId)));
  const additions = unresolved
    .filter(target => !existing.has(target.targetId))
    .map(target => ({
      targetKind: target.targetKind,
      targetId: target.targetId,
      state: 'needs_review' as MembershipState,
      confidence: 0.35,
      reason: 'Chunk planning marked this target unresolved; review before accepting.',
      evidenceRefs: [`planner:unresolved:${target.targetId}`],
    }));
  if (!additions.length) return plan;
  return SemanticViewPlan.parse({
    ...plan,
    views: [{
      ...plan.views[0],
      memberships: [...plan.views[0].memberships, ...additions],
    }, ...plan.views.slice(1)],
    reviewQueues: [
      ...plan.reviewQueues,
      {
        queueName: 'hierarchical_planner_unresolved',
        reason: 'Large-candidate chunk planning left these targets unresolved.',
        targetIds: additions.map(item => item.targetId),
      },
    ],
  });
}

function chunkBriefs(briefs: ResourceBriefType[], chunkSize: number): ResourceBriefType[][] {
  const chunks: ResourceBriefType[][] = [];
  for (let index = 0; index < briefs.length; index += chunkSize) {
    chunks.push(briefs.slice(index, index + chunkSize));
  }
  return chunks;
}

function chunkIdFor(chunkFingerprint: string, index: number): string {
  return `semantic_chunk_${index + 1}_${chunkFingerprint.slice(0, 24)}`;
}

function targetIdSet(briefs: ResourceBriefType[]): Set<string> {
  const ids = new Set<string>();
  for (const brief of briefs) {
    ids.add(brief.resourceId);
    for (const item of brief.atomicItems ?? []) ids.add(item.itemId);
  }
  return ids;
}

function evidenceIdSet(briefs: ResourceBriefType[]): Set<string> {
  const ids = new Set<string>();
  for (const brief of briefs) {
    for (const evidence of brief.evidence ?? []) ids.add(evidence.id);
    for (const annotation of brief.userAnnotations ?? []) {
      if (annotation.id) ids.add(`user_annotation:${annotation.id}`);
      ids.add(`user_annotation:${brief.resourceId}`);
    }
  }
  return ids;
}

function accumulateUsage(into: LlmUsage, add: LlmUsage): void {
  if (add.inputTokens) into.inputTokens = (into.inputTokens ?? 0) + add.inputTokens;
  if (add.outputTokens) into.outputTokens = (into.outputTokens ?? 0) + add.outputTokens;
  if (add.quotaTurns) into.quotaTurns = (into.quotaTurns ?? 0) + add.quotaTurns;
}

function identityFor(commandText: string, options: HierarchicalPlanningOptions): HierarchicalPlannerIdentity {
  const identity = options.providerIdentity ?? {};
  return {
    commandText,
    model: identity.model ?? 'unknown-model',
    reasoningEffort: identity.reasoningEffort ?? 'unknown-effort',
    providerRole: identity.providerRole ?? 'semantic_planner',
    providerScopeKey: identity.providerScopeKey ?? 'unknown-scope',
    redactionVersion: identity.redactionVersion ?? PROMPT_REDACTION_VERSION,
    plannerVersion: identity.plannerVersion ?? options.plannerVersion ?? 'hierarchical-planner-v2',
  };
}

function failedChunkResult(
  commandText: string,
  chunkId: string,
  briefs: ResourceBriefType[],
  error: unknown,
): SemanticChunkResultType {
  return SemanticChunkResult.parse({
    commandText,
    chunkId,
    decisions: [],
    unresolvedTargets: briefs.flatMap(brief => [
      brief.resourceId,
      ...brief.atomicItems.map(item => item.itemId),
    ]),
    notes: [`chunk failed and degraded to needs_review: ${error instanceof Error ? error.message : String(error)}`],
  });
}

function ensureHierarchicalRun(db: Database.Database, input: {
  commandText: string;
  retrievalRunId?: string;
  identity: HierarchicalPlannerIdentity;
  evidenceFingerprint: string;
  targetCount: number;
  chunkSize: number;
}): string {
  const existing = db.prepare(`
    SELECT id
    FROM hierarchical_planning_runs
    WHERE evidence_fingerprint = ?
      AND provider_scope_key = ?
      AND model = ?
      AND reasoning_effort = ?
    LIMIT 1
  `).get(input.evidenceFingerprint, input.identity.providerScopeKey, input.identity.model, input.identity.reasoningEffort) as { id: string } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`
      UPDATE hierarchical_planning_runs
      SET status = CASE WHEN status = 'passed' THEN status ELSE 'running' END,
          updated_at = ?
      WHERE id = ?
    `).run(now, existing.id);
    return existing.id;
  }
  const id = `hier_run_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO hierarchical_planning_runs
      (id, command_text_hash, retrieval_run_id, provider_role, provider_scope_key, provider_thread_id,
       model, reasoning_effort, redaction_version, evidence_fingerprint, status, target_count,
       chunk_size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
  `).run(
    id,
    crypto.createHash('sha256').update(input.commandText).digest('hex'),
    input.retrievalRunId ?? null,
    input.identity.providerRole,
    input.identity.providerScopeKey,
    null,
    input.identity.model,
    input.identity.reasoningEffort,
    input.identity.redactionVersion ?? PROMPT_REDACTION_VERSION,
    input.evidenceFingerprint,
    input.targetCount,
    input.chunkSize,
    now,
    now,
  );
  return id;
}

function readHierarchicalChunk(
  db: Database.Database,
  runId: string,
  evidenceFingerprint: string,
): { result: SemanticChunkResultType } | undefined {
  const row = db.prepare(`
    SELECT result_json
    FROM hierarchical_planning_chunks
    WHERE run_id = ?
      AND evidence_fingerprint = ?
      AND status IN ('passed', 'failed')
      AND result_json IS NOT NULL
    LIMIT 1
  `).get(runId, evidenceFingerprint) as { result_json: string } | undefined;
  if (!row) return undefined;
  return { result: SemanticChunkResult.parse(JSON.parse(row.result_json)) };
}

function startHierarchicalChunk(
  db: Database.Database,
  runId: string,
  chunkId: string,
  ordinal: number,
  evidenceFingerprint: string,
  briefs: ResourceBriefType[],
  splitParentId?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hierarchical_planning_chunks
      (id, run_id, ordinal, evidence_fingerprint, status, target_ids_json, attempts, split_parent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', ?, 0, ?, ?, ?)
    ON CONFLICT(run_id, ordinal, evidence_fingerprint) DO UPDATE SET
      status = 'running',
      attempts = attempts + 1,
      updated_at = excluded.updated_at
  `).run(
    chunkId,
    runId,
    ordinal,
    evidenceFingerprint,
    JSON.stringify(briefs.flatMap(brief => [brief.resourceId, ...brief.atomicItems.map(item => item.itemId)])),
    splitParentId ?? null,
    now,
    now,
  );
}

function finishHierarchicalChunk(
  db: Database.Database,
  chunkId: string,
  status: 'passed' | 'failed',
  result: SemanticChunkResultType,
  usage: LlmUsage,
  attempts: number,
  error?: unknown,
): void {
  db.prepare(`
    UPDATE hierarchical_planning_chunks
    SET status = ?,
        result_json = ?,
        usage_json = ?,
        attempts = MAX(attempts, ?),
        error = ?,
        updated_at = ?,
        completed_at = ?
    WHERE id = ?
  `).run(
    status,
    JSON.stringify(result),
    JSON.stringify(usage),
    attempts,
    error === undefined ? null : error instanceof Error ? error.message : String(error),
    new Date().toISOString(),
    new Date().toISOString(),
    chunkId,
  );
}

function completeHierarchicalRun(
  db: Database.Database,
  runId: string,
  status: string,
  plan: SemanticViewPlan,
  usage: LlmUsage,
): void {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM hierarchical_planning_chunks
    WHERE run_id = ?
  `).get(runId) as { completed: number | null; failed: number | null };
  db.prepare(`
    UPDATE hierarchical_planning_runs
    SET status = ?,
        completed_chunks = ?,
        failed_chunks = ?,
        result_json = ?,
        usage_json = ?,
        updated_at = ?,
        completed_at = ?
    WHERE id = ?
  `).run(
    status,
    counts.completed ?? 0,
    counts.failed ?? 0,
    JSON.stringify(plan),
    JSON.stringify(usage),
    new Date().toISOString(),
    new Date().toISOString(),
    runId,
  );
}
