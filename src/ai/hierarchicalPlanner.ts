import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CheckpointStore } from '../acceptance/checkpointStore.js';
import type { LlmProvider, LlmUsage } from '../llm/types.js';
import { runStructured } from '../llm/runStructured.js';
import {
  SemanticViewPlan,
  type MembershipState,
  type ResourceBrief as ResourceBriefType,
} from '../shared/schemas.js';
import { projectResourceBriefsForPrompt, redactSensitiveText } from '../security/urlPrivacy.js';
import { planSemanticView, type PlanSemanticViewOptions } from './planSemanticView.js';
import {
  compactChunkDecisions,
  HierarchicalMergeInput,
  SemanticChunkResult,
  type SemanticChunkResult as SemanticChunkResultType,
} from './hierarchicalPlannerContracts.js';

export interface HierarchicalPlanningOptions extends PlanSemanticViewOptions {
  maxDirectResources?: number;
  maxDirectPromptBytes?: number;
  chunkSize?: number;
  checkpointPath?: string;
}

export interface HierarchicalPlanningResult {
  value: SemanticViewPlan;
  usage: LlmUsage;
  attempts: number;
  mode: 'direct' | 'hierarchical';
  chunkCount: number;
  splitChunkCount: number;
  checkpointPath?: string;
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
    };
  }

  const checkpointPath = options.checkpointPath ?? path.join(process.cwd(), '.local', 'hierarchical-semantic-chunks.json');
  const store = new CheckpointStore<SemanticChunkResultType>(checkpointPath);
  const system = await fs.readFile(new URL('../../knowledge/prompts/semantic-view-planner.system.md', import.meta.url), 'utf8');
  const chunks = chunkBriefs(briefs, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const usage: LlmUsage = {};
  const results: SemanticChunkResultType[] = [];
  let attempts = 0;
  let splitChunkCount = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? [];
    const chunkId = chunkIdFor(commandText, chunk, index);
    const cached = store.get(chunkId);
    if (cached?.status === 'passed' && cached.result) {
      results.push(cached.result);
      continue;
    }
    store.start(chunkId);
    try {
      const result = await runChunk(provider, commandText, chunkId, chunk, system);
      accumulateUsage(usage, result.usage);
      attempts += result.attempts;
      store.pass(chunkId, result.value);
      results.push(result.value);
    } catch (error) {
      if (chunk.length <= 1) {
        store.fail(chunkId, error);
        throw error;
      }
      splitChunkCount += 1;
      store.fail(chunkId, error);
      const midpoint = Math.ceil(chunk.length / 2);
      const left = chunk.slice(0, midpoint);
      const right = chunk.slice(midpoint);
      for (const [suffix, split] of [['a', left], ['b', right]] as const) {
        const splitId = `${chunkId}-${suffix}`;
        const cachedSplit = store.get(splitId);
        if (cachedSplit?.status === 'passed' && cachedSplit.result) {
          results.push(cachedSplit.result);
          continue;
        }
        store.start(splitId);
        const splitResult = await runChunk(provider, commandText, splitId, split, system);
        accumulateUsage(usage, splitResult.usage);
        attempts += splitResult.attempts;
        store.pass(splitId, splitResult.value);
        results.push(splitResult.value);
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
    semanticValidate: planValidator(briefs),
  });
  accumulateUsage(usage, merged.usage);
  attempts += merged.attempts;
  return {
    value: surfaceUnresolvedTargets(merged.value, results),
    usage,
    attempts,
    mode: 'hierarchical',
    chunkCount: results.length,
    splitChunkCount,
    checkpointPath,
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
    return errors;
  };
}

function surfaceUnresolvedTargets(plan: SemanticViewPlan, chunks: SemanticChunkResultType[]): SemanticViewPlan {
  const unresolved = new Set(chunks.flatMap(chunk => chunk.unresolvedTargets));
  if (!unresolved.size || !plan.views[0]) return plan;
  const existing = new Set(plan.views.flatMap(view => view.memberships.map(membership => membership.targetId)));
  const additions = [...unresolved]
    .filter(targetId => !existing.has(targetId))
    .map(targetId => ({
      targetKind: 'resource' as const,
      targetId,
      state: 'needs_review' as MembershipState,
      confidence: 0.35,
      reason: 'Chunk planning marked this target unresolved; review before accepting.',
      evidenceRefs: [`planner:unresolved:${targetId}`],
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

function chunkIdFor(commandText: string, briefs: ResourceBriefType[], index: number): string {
  const hash = crypto.createHash('sha256')
    .update(commandText)
    .update('\0')
    .update(briefs.map(brief => brief.resourceId).join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `semantic_chunk_${index + 1}_${hash}`;
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
