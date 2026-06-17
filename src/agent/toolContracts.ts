import { z } from 'zod';
import { ResourceBrief, SemanticViewPlan, UserAnnotation } from '../shared/schemas.js';

export const SearchResourcesInput = z.object({
  query: z.string(),
  filters: z.object({
    urlKinds: z.array(z.string()).optional(),
    annotationStatus: z.enum(['any', 'marked', 'unmarked']).default('any'),
    limit: z.number().int().positive().max(500).default(80),
  }).default({ annotationStatus: 'any', limit: 80 }),
});

export const SearchResourcesOutput = z.object({
  matches: z.array(z.object({
    resourceId: z.string(),
    score: z.number(),
    reasons: z.array(z.string()),
  })),
});

export const GetResourceBriefsInput = z.object({
  resourceIds: z.array(z.string()).min(1),
  include: z.array(z.enum(['userAnnotations', 'extractionArtifacts', 'atomicItems', 'existingMemberships'])).default(['userAnnotations', 'extractionArtifacts']),
});

export const GetResourceBriefsOutput = z.object({
  briefs: z.array(ResourceBrief),
});

export const PlanSemanticViewInput = z.object({
  commandText: z.string(),
  candidateResourceIds: z.array(z.string()),
  options: z.object({
    maxViews: z.number().int().positive().max(12).default(4),
    allowWeakMatches: z.boolean().default(true),
    askReviewForAmbiguous: z.boolean().default(true),
  }).default({ maxViews: 4, allowWeakMatches: true, askReviewForAmbiguous: true }),
});

export const PlanSemanticViewOutput = SemanticViewPlan;

export const AddUserAnnotationInput = UserAnnotation.omit({ createdAt: true, updatedAt: true }).extend({
  createdAt: z.string().optional(),
});

export const ReviewNextInput = z.object({
  queue: z.string().default('unmarked'),
  preload: z.number().int().min(0).max(5).default(2),
  filters: z.object({ urlKinds: z.array(z.string()).optional() }).optional(),
});

export const ReviewNextOutput = z.object({
  current: ResourceBrief.nullable(),
  next: z.array(ResourceBrief),
});

export const SubmitReviewDecisionInput = z.object({
  resourceId: z.string(),
  action: z.enum(['save_and_next', 'skip', 'mark_ignore', 'complete']),
  tags: z.array(z.string()).default([]),
  description: z.string().optional(),
  decision: z.enum(['important', 'watch_later', 'project_reference', 'inspiration', 'archive_later', 'ignore', 'needs_deeper_read', 'none']).default('none'),
});

export const ExplainMembershipInput = z.object({
  resourceId: z.string(),
  viewId: z.string(),
});

export const ExplainMembershipOutput = z.object({
  resourceId: z.string(),
  viewId: z.string(),
  explanation: z.string(),
  evidenceRefs: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export const AgentToolContracts = {
  searchResources: { input: SearchResourcesInput, output: SearchResourcesOutput },
  getResourceBriefs: { input: GetResourceBriefsInput, output: GetResourceBriefsOutput },
  planSemanticView: { input: PlanSemanticViewInput, output: PlanSemanticViewOutput },
  addUserAnnotation: { input: AddUserAnnotationInput, output: UserAnnotation },
  getReviewNext: { input: ReviewNextInput, output: ReviewNextOutput },
  submitReviewDecision: { input: SubmitReviewDecisionInput, output: ReviewNextOutput },
  explainMembership: { input: ExplainMembershipInput, output: ExplainMembershipOutput },
} as const;
