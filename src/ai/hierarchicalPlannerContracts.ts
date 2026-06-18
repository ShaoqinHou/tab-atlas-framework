import { z } from 'zod';
import { MembershipState, SemanticViewPlan } from '../shared/schemas.js';

export const SemanticChunkDecision = z.object({
  targetKind: z.enum(['resource', 'atomic_item']),
  targetId: z.string(),
  state: MembershipState,
  confidence: z.number().min(0).max(1).default(0.5),
  reason: z.string().default(''),
  evidenceRefs: z.array(z.string()).default([]),
});
export type SemanticChunkDecision = z.infer<typeof SemanticChunkDecision>;

export const SemanticChunkResult = z.object({
  commandText: z.string(),
  chunkId: z.string(),
  decisions: z.array(SemanticChunkDecision),
  unresolvedTargets: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type SemanticChunkResult = z.infer<typeof SemanticChunkResult>;

export const HierarchicalConflict = z.object({
  targetKind: z.enum(['resource', 'atomic_item']),
  targetId: z.string(),
  states: z.array(MembershipState),
  evidenceRefs: z.array(z.string()).default([]),
});
export type HierarchicalConflict = z.infer<typeof HierarchicalConflict>;

export const HierarchicalMergeInput = z.object({
  commandText: z.string(),
  chunkResults: z.array(SemanticChunkResult),
  conflicts: z.array(HierarchicalConflict).default([]),
});
export type HierarchicalMergeInput = z.infer<typeof HierarchicalMergeInput>;

export const HierarchicalSemanticPlanResult = z.object({
  mode: z.enum(['direct', 'hierarchical']),
  chunkCount: z.number().int().nonnegative(),
  splitChunkCount: z.number().int().nonnegative(),
  mergeInput: HierarchicalMergeInput.optional(),
  plan: SemanticViewPlan,
});
export type HierarchicalSemanticPlanResult = z.infer<typeof HierarchicalSemanticPlanResult>;

export function compactChunkDecisions(results: SemanticChunkResult[]): HierarchicalConflict[] {
  const byTarget = new Map<string, { targetKind: 'resource' | 'atomic_item'; targetId: string; states: Set<z.infer<typeof MembershipState>>; evidenceRefs: Set<string> }>();
  for (const result of results) {
    for (const decision of result.decisions) {
      const key = `${decision.targetKind}:${decision.targetId}`;
      const entry = byTarget.get(key) ?? {
        targetKind: decision.targetKind,
        targetId: decision.targetId,
        states: new Set<z.infer<typeof MembershipState>>(),
        evidenceRefs: new Set<string>(),
      };
      entry.states.add(decision.state);
      for (const ref of decision.evidenceRefs) entry.evidenceRefs.add(ref);
      byTarget.set(key, entry);
    }
  }
  return [...byTarget.values()]
    .filter(entry => entry.states.size > 1)
    .map(entry => ({
      targetKind: entry.targetKind,
      targetId: entry.targetId,
      states: [...entry.states],
      evidenceRefs: [...entry.evidenceRefs],
    }));
}
