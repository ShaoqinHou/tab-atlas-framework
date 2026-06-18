import { z } from 'zod';

export const RetrievalSource = z.enum([
  'user_annotations',
  'membership_feedback',
  'fts',
  'extracted_evidence',
  'codex_scan',
  'browser_groups',
  'atomic_items',
  'recent',
]);
export type RetrievalSource = z.infer<typeof RetrievalSource>;

export const RetrievalQuery = z.object({
  source: RetrievalSource,
  query: z.string().default(''),
  weight: z.number().min(0).max(10).default(1),
  limit: z.number().int().positive().max(200).default(50),
});
export type RetrievalQuery = z.infer<typeof RetrievalQuery>;

export const RetrievalPlan = z.object({
  commandText: z.string(),
  queries: z.array(RetrievalQuery).min(1),
  includeUserMarkedForTaste: z.boolean().default(false),
  maxCandidates: z.number().int().positive().max(1000).default(200),
  maxPromptResources: z.number().int().positive().max(500).default(120),
});
export type RetrievalPlan = z.infer<typeof RetrievalPlan>;

export interface RetrievalCandidate {
  targetKind: 'resource' | 'atomic_item';
  targetId: string;
  resourceId: string;
  score: number;
  sources: RetrievalSource[];
  reasons: string[];
}

export interface RetrievalMetrics {
  candidateCount: number;
  selectedCount: number;
  sourceCoverage: Partial<Record<RetrievalSource, number>>;
  userMarkedRecall: number;
  knownRelevantRecall: number;
  atomicItemRecall: number;
  uncertainCount: number;
}

export function fallbackRetrievalPlan(commandText: string, maxCandidates = 200): RetrievalPlan {
  const lower = commandText.toLowerCase();
  const taste = /\b(inspiration|important|reference|later|project|ignore|archive|watch|moodboard|taste|purpose)\b/i.test(commandText);
  const terms = lower
    .replace(/[^a-z0-9_ -]+/g, ' ')
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length > 1)
    .slice(0, 16)
    .join(' ');
  return RetrievalPlan.parse({
    commandText,
    includeUserMarkedForTaste: taste,
    maxCandidates,
    maxPromptResources: Math.min(120, maxCandidates),
    queries: [
      { source: 'user_annotations', query: terms, weight: 6, limit: 100 },
      { source: 'membership_feedback', query: terms, weight: 5, limit: 80 },
      { source: 'atomic_items', query: terms, weight: 4, limit: 80 },
      { source: 'extracted_evidence', query: terms, weight: 3, limit: 100 },
      { source: 'codex_scan', query: terms, weight: 3, limit: 100 },
      { source: 'browser_groups', query: terms, weight: 2, limit: 80 },
      { source: 'fts', query: terms, weight: 2, limit: 100 },
      { source: 'recent', query: '', weight: 0.25, limit: 50 },
    ],
  });
}
