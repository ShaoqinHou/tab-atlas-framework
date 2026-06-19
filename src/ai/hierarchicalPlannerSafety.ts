import crypto from 'node:crypto';
import type { ResourceBrief } from '../shared/schemas.js';
import { projectResourceBriefsForPrompt, PROMPT_REDACTION_VERSION } from '../security/urlPrivacy.js';
import type { SemanticChunkResult } from './hierarchicalPlannerContracts.js';

export interface HierarchicalPlannerIdentity {
  commandText: string;
  model: string;
  reasoningEffort: string;
  providerRole: string;
  providerScopeKey: string;
  redactionVersion?: string;
  plannerVersion?: string;
}

export interface TargetDescriptor {
  targetKind: 'resource' | 'atomic_item';
  targetId: string;
}

/**
 * Fingerprints the prompt-safe evidence, not just resource IDs. A user note,
 * extracted artifact, feedback decision, adapter output, planner version, or
 * model setting change therefore invalidates stale chunk checkpoints.
 */
export function hierarchicalEvidenceFingerprint(
  briefs: ResourceBrief[],
  identity: HierarchicalPlannerIdentity,
): string {
  const payload = {
    identity: {
      commandText: identity.commandText.trim(),
      model: identity.model,
      reasoningEffort: identity.reasoningEffort,
      providerRole: identity.providerRole,
      providerScopeKey: identity.providerScopeKey,
      redactionVersion: identity.redactionVersion ?? PROMPT_REDACTION_VERSION,
      plannerVersion: identity.plannerVersion ?? 'hierarchical-planner-v2',
    },
    briefs: projectResourceBriefsForPrompt(briefs).map(brief => ({
      resourceId: brief.resourceId,
      canonicalUrl: brief.canonicalUrl,
      redactedUrl: brief.redactedUrl,
      urlKind: brief.urlKind,
      host: brief.host,
      title: brief.title,
      browserGroupTitles: [...brief.browserGroupTitles].sort(),
      userAnnotations: [...brief.userAnnotations]
        .map(annotation => ({
          id: annotation.id,
          tags: [...annotation.tags].sort(),
          description: annotation.description,
          decision: annotation.decision,
          source: annotation.source,
          updatedAt: annotation.updatedAt,
          createdAt: annotation.createdAt,
        }))
        .sort((a, b) => `${a.id ?? ''}:${a.createdAt}`.localeCompare(`${b.id ?? ''}:${b.createdAt}`)),
      atomicItems: [...brief.atomicItems]
        .map(item => ({
          itemId: item.itemId,
          itemKind: item.itemKind,
          name: item.name,
          summary: item.summary,
          evidenceRefs: [...item.evidenceRefs].sort(),
          confidence: item.confidence,
        }))
        .sort((a, b) => a.itemId.localeCompare(b.itemId)),
      evidence: [...brief.evidence]
        .map(evidence => ({
          id: evidence.id,
          kind: evidence.kind,
          text: evidence.text,
          provenance: evidence.provenance,
          confidence: evidence.confidence,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    })).sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
  };
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function chunkCheckpointKey(input: {
  runFingerprint: string;
  ordinal: number;
  briefs: ResourceBrief[];
}): string {
  const targetIds = input.briefs.flatMap(brief => [
    `resource:${brief.resourceId}`,
    ...brief.atomicItems.map(item => `atomic_item:${item.itemId}`),
  ]).sort();
  return crypto.createHash('sha256')
    .update(input.runFingerprint)
    .update('\0')
    .update(String(input.ordinal))
    .update('\0')
    .update(targetIds.join('\0'))
    .digest('hex');
}

/**
 * Every resource in a chunk must be explicitly classified or marked
 * unresolved. Atomic items are optional candidates, but any returned atomic
 * item must belong to the chunk. This prevents silent resource loss.
 */
export function validateSemanticChunkCoverage(
  result: SemanticChunkResult,
  briefs: ResourceBrief[],
): string[] {
  const errors: string[] = [];
  const targetMap = targetDescriptorMap(briefs);
  const requiredResourceIds = new Set(briefs.map(brief => brief.resourceId));
  const decisionKeys = new Set<string>();
  const coveredResourceIds = new Set<string>();
  const unresolved = new Set(result.unresolvedTargets);

  for (const decision of result.decisions) {
    const key = `${decision.targetKind}:${decision.targetId}`;
    if (decisionKeys.has(key)) errors.push(`duplicate chunk decision ${key}`);
    decisionKeys.add(key);
    const expected = targetMap.get(decision.targetId);
    if (!expected) {
      errors.push(`unknown chunk target ${key}`);
      continue;
    }
    if (expected.targetKind !== decision.targetKind) {
      errors.push(`target kind mismatch for ${decision.targetId}: expected ${expected.targetKind}, got ${decision.targetKind}`);
    }
    if (expected.targetKind === 'resource') coveredResourceIds.add(expected.targetId);
  }

  for (const targetId of unresolved) {
    const descriptor = targetMap.get(targetId);
    if (!descriptor) errors.push(`unknown unresolved target ${targetId}`);
    if (descriptor?.targetKind === 'resource') coveredResourceIds.add(targetId);
  }

  for (const resourceId of requiredResourceIds) {
    if (!coveredResourceIds.has(resourceId)) {
      errors.push(`resource ${resourceId} is missing from decisions and unresolvedTargets`);
    }
  }
  return errors;
}

export function unresolvedTargetDescriptors(
  results: SemanticChunkResult[],
  briefs: ResourceBrief[],
): TargetDescriptor[] {
  const targetMap = targetDescriptorMap(briefs);
  const descriptors = new Map<string, TargetDescriptor>();
  for (const targetId of results.flatMap(result => result.unresolvedTargets)) {
    const descriptor = targetMap.get(targetId);
    if (!descriptor) throw new Error(`Unknown unresolved target: ${targetId}`);
    descriptors.set(`${descriptor.targetKind}:${descriptor.targetId}`, descriptor);
  }
  return [...descriptors.values()].sort((a, b) => (
    a.targetKind.localeCompare(b.targetKind) || a.targetId.localeCompare(b.targetId)
  ));
}

function targetDescriptorMap(briefs: ResourceBrief[]): Map<string, TargetDescriptor> {
  const targets = new Map<string, TargetDescriptor>();
  for (const brief of briefs) {
    targets.set(brief.resourceId, { targetKind: 'resource', targetId: brief.resourceId });
    for (const item of brief.atomicItems) {
      const existing = targets.get(item.itemId);
      if (existing && existing.targetKind !== 'atomic_item') {
        throw new Error(`Target ID collision between resource and atomic item: ${item.itemId}`);
      }
      targets.set(item.itemId, { targetKind: 'atomic_item', targetId: item.itemId });
    }
  }
  return targets;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}
