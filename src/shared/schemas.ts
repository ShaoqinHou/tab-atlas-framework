import { z } from 'zod';

export const BrowserName = z.enum(['chrome', 'edge', 'unknown']);

export const RawTabObservation = z.object({
  browser: BrowserName.default('unknown'),
  capturedAt: z.string().optional(),
  windowId: z.union([z.number(), z.string()]).optional(),
  windowFocused: z.boolean().optional(),
  tabId: z.union([z.number(), z.string()]).optional(),
  index: z.number().optional(),
  active: z.boolean().optional(),
  pinned: z.boolean().optional(),
  audible: z.boolean().optional(),
  muted: z.boolean().optional(),
  discarded: z.boolean().optional(),
  autoDiscardable: z.boolean().optional(),
  incognito: z.boolean().optional(),
  groupId: z.union([z.number(), z.string()]).optional(),
  groupTitle: z.string().optional().default(''),
  groupColor: z.string().optional().default(''),
  groupCollapsed: z.boolean().optional(),
  title: z.string().optional().default(''),
  url: z.string().url(),
});

export type RawTabObservation = z.infer<typeof RawTabObservation>;

export const SnapshotInput = z.object({
  capturedAt: z.string().optional(),
  tabs: z.array(RawTabObservation).optional(),
  rows: z.array(RawTabObservation).optional(),
  Results: z.unknown().optional(),
});

export type SnapshotInput = z.infer<typeof SnapshotInput>;

export const UrlKind = z.enum([
  'youtube_video',
  'youtube_short',
  'youtube_playlist',
  'github_repo',
  'github_issue',
  'github_pull',
  'github_file',
  'pdf',
  'docs',
  'search',
  'login',
  'web_page',
  'unknown',
]);

export type UrlKind = z.infer<typeof UrlKind>;

export const AnnotationDecision = z.enum([
  'important',
  'watch_later',
  'project_reference',
  'inspiration',
  'archive_later',
  'ignore',
  'needs_deeper_read',
  'none',
]);

export type AnnotationDecision = z.infer<typeof AnnotationDecision>;

export const UserAnnotationSource = z.enum([
  'focused_review',
  'resource_detail',
  'agent_chat',
  'bulk_edit',
  'import',
]);

export type UserAnnotationSource = z.infer<typeof UserAnnotationSource>;

export const UserAnnotation = z.object({
  id: z.string().optional(),
  targetKind: z.enum(['resource', 'atomic_item']),
  targetId: z.string(),
  tags: z.array(z.string()).default([]),
  description: z.string().optional(),
  decision: AnnotationDecision.default('none'),
  source: UserAnnotationSource,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

export type UserAnnotation = z.infer<typeof UserAnnotation>;

export const MembershipState = z.enum([
  'strong_include',
  'weak_include',
  'conflict',
  'exclude',
  'needs_review',
]);

export type MembershipState = z.infer<typeof MembershipState>;

export const AtomicItemBrief = z.object({
  itemId: z.string(),
  itemKind: z.string(),
  name: z.string(),
  summary: z.string().optional(),
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type AtomicItemBrief = z.infer<typeof AtomicItemBrief>;

export const ResourceBrief = z.object({
  resourceId: z.string(),
  canonicalUrl: z.string(),
  redactedUrl: z.string().optional(),
  urlKind: UrlKind,
  host: z.string(),
  title: z.string().optional(),
  browserGroupTitles: z.array(z.string()).default([]),
  userAnnotations: z.array(UserAnnotation).default([]).describe('Must be placed before extracted evidence in prompts.'),
  systemTags: z.array(z.string()).default([]),
  summary: z.string().optional(),
  atomicItems: z.array(AtomicItemBrief).default([]),
  extractionStatus: z.enum([
    'not_started',
    'metadata_only',
    'partial',
    'complete',
    'blocked_auth_required',
    'blocked_size_limit',
    'blocked_robots_or_terms',
    'blocked_policy',
    'failed_network',
    'failed_parse',
    'manual_needed',
  ]).default('not_started'),
  evidence: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    text: z.string(),
    provenance: z.string(),
    confidence: z.number().min(0).max(1).default(0.5),
  })).default([]),
});

export type ResourceBrief = z.infer<typeof ResourceBrief>;

export const CategorizeBatchOutput = z.object({
  resourceAnalyses: z.array(z.object({
    resourceId: z.string(),
    summary: z.string(),
    contentKind: z.string(),
    confidence: z.number().min(0).max(1),
    evidenceRefs: z.array(z.string()),
    atomicItems: z.array(z.object({
      name: z.string(),
      itemKind: z.string(),
      summary: z.string(),
      confidence: z.number().min(0).max(1),
      evidenceRefs: z.array(z.string()),
    })).default([]),
  })),
  proposedTags: z.array(z.object({
    name: z.string(),
    description: z.string(),
    confidence: z.number().min(0).max(1),
  })),
  proposedViews: z.array(z.object({
    name: z.string(),
    description: z.string(),
    rationale: z.string(),
    confidence: z.number().min(0).max(1),
  })),
  memberships: z.array(z.object({
    resourceId: z.string(),
    viewName: z.string(),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
    evidenceRefs: z.array(z.string()),
  })),
  lowConfidence: z.array(z.object({
    resourceId: z.string(),
    reason: z.string(),
    neededEvidence: z.array(z.string()),
  })),
});

export type CategorizeBatchOutput = z.infer<typeof CategorizeBatchOutput>;

export const SemanticViewPlan = z.object({
  commandText: z.string(),
  views: z.array(z.object({
    name: z.string(),
    goal: z.string(),
    description: z.string().optional(),
    inclusionRules: z.array(z.string()),
    exclusionRules: z.array(z.string()),
    sections: z.array(z.string()).default([]),
    sortPolicy: z.string().optional(),
    confidence: z.number().min(0).max(1),
    memberships: z.array(z.object({
      targetKind: z.enum(['resource', 'atomic_item']),
      targetId: z.string(),
      section: z.string().optional(),
      state: MembershipState,
      confidence: z.number().min(0).max(1),
      reason: z.string(),
      evidenceRefs: z.array(z.string()),
      conflict: z.string().optional(),
    })),
  })).min(1),
  reviewQueues: z.array(z.object({
    queueName: z.string(),
    reason: z.string(),
    targetIds: z.array(z.string()),
  })).default([]),
  explanation: z.string(),
});

export type SemanticViewPlan = z.infer<typeof SemanticViewPlan>;

export const ReviewQueueItem = z.object({
  resourceId: z.string(),
  queueName: z.string(),
  status: z.enum(['pending', 'skipped', 'completed', 'dismissed']),
  reason: z.string(),
  priority: z.number(),
  lastPresentedAt: z.string().optional(),
  skippedCount: z.number().int().min(0).default(0),
});

export type ReviewQueueItem = z.infer<typeof ReviewQueueItem>;
