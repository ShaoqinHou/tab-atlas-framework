import { z } from 'zod';

export const FeedbackScopeMode = z.enum(['view_revision', 'intent', 'global']);
export type FeedbackScopeMode = z.infer<typeof FeedbackScopeMode>;

export const FeedbackIntentScope = z.object({
  mode: FeedbackScopeMode.default('intent'),
  sourceViewId: z.string().optional(),
  sourceRevisionId: z.string().optional(),
  sourceCommandText: z.string().default(''),
  sourceGoal: z.string().default(''),
  sourceRules: z.array(z.string()).default([]),
  intentTerms: z.array(z.string()).default([]),
});
export type FeedbackIntentScope = z.infer<typeof FeedbackIntentScope>;

export interface FeedbackScopeMatch {
  applies: boolean;
  score: number;
  reason: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'group',
  'in', 'include', 'into', 'is', 'it', 'make', 'of', 'on', 'or', 'the', 'this',
  'to', 'view', 'with', 'without', 'my', 'all', 'only',
]);

export function buildFeedbackIntentScope(input: {
  mode?: FeedbackScopeMode;
  sourceViewId?: string;
  sourceRevisionId?: string;
  sourceCommandText?: string;
  sourceGoal?: string;
  sourceRules?: string[];
}): FeedbackIntentScope {
  const sourceCommandText = input.sourceCommandText ?? '';
  const sourceGoal = input.sourceGoal ?? '';
  const sourceRules = input.sourceRules ?? [];
  return FeedbackIntentScope.parse({
    mode: input.mode ?? 'intent',
    sourceViewId: input.sourceViewId,
    sourceRevisionId: input.sourceRevisionId,
    sourceCommandText,
    sourceGoal,
    sourceRules,
    intentTerms: tokenizeIntent([sourceCommandText, sourceGoal, ...sourceRules].join(' ')),
  });
}

export function matchFeedbackScope(
  scopeInput: FeedbackIntentScope,
  current: { commandText: string; viewId?: string; revisionId?: string },
): FeedbackScopeMatch {
  const scope = FeedbackIntentScope.parse(scopeInput);
  if (scope.mode === 'global') return { applies: true, score: 1, reason: 'global feedback' };
  if (scope.mode === 'view_revision') {
    const sameRevision = Boolean(scope.sourceRevisionId && current.revisionId === scope.sourceRevisionId);
    const sameView = Boolean(scope.sourceViewId && current.viewId === scope.sourceViewId);
    return {
      applies: sameRevision || sameView,
      score: sameRevision ? 1 : sameView ? 0.95 : 0,
      reason: sameRevision ? 'same view revision' : sameView ? 'same view lineage' : 'different view',
    };
  }

  const currentTerms = new Set(tokenizeIntent(current.commandText));
  const sourceTerms = new Set(scope.intentTerms);
  if (!sourceTerms.size || !currentTerms.size) {
    return { applies: false, score: 0, reason: 'insufficient intent context' };
  }
  const overlap = [...sourceTerms].filter(term => currentTerms.has(term));
  const containment = overlap.length / Math.min(sourceTerms.size, currentTerms.size);
  const union = new Set([...sourceTerms, ...currentTerms]).size;
  const jaccard = union ? overlap.length / union : 0;
  const score = Math.max(containment, jaccard);
  return {
    applies: score >= 0.34 || overlap.length >= 2,
    score,
    reason: overlap.length ? `shared intent terms: ${overlap.join(', ')}` : 'no shared intent terms',
  };
}

export function tokenizeIntent(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_ -]+/g, ' ')
      .split(/\s+/)
      .map(term => term.trim())
      .filter(term => term.length > 2 && !STOP_WORDS.has(term)),
  )].sort();
}
