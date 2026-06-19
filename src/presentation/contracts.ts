import { z } from 'zod';
import { MembershipState, UrlKind } from '../shared/schemas.js';

export const WorkspaceLayout = z.enum([
  'board',
  'gallery',
  'map',
  'timeline',
  'compact',
]);
export type WorkspaceLayout = z.infer<typeof WorkspaceLayout>;

export const EvidenceStrength = z.enum([
  'user_direct',
  'user_feedback',
  'verified_content',
  'generated_analysis',
  'title_only',
]);
export type EvidenceStrength = z.infer<typeof EvidenceStrength>;

export const CardVisualKind = z.enum([
  'video',
  'article',
  'repository',
  'document',
  'search',
  'atomic_item',
  'unknown',
]);
export type CardVisualKind = z.infer<typeof CardVisualKind>;

export const PresentationMedia = z.object({
  thumbnailUrl: z.string().url().optional(),
  embedUrl: z.string().url().optional(),
  aspectRatio: z.number().positive().default(16 / 9),
  source: z.enum(['youtube', 'open_graph', 'local_artifact', 'none']).default('none'),
});
export type PresentationMedia = z.infer<typeof PresentationMedia>;

export const VisualResourceCard = z.object({
  targetKind: z.enum(['resource', 'atomic_item']),
  targetId: z.string(),
  parentResourceId: z.string().optional(),
  title: z.string(),
  host: z.string(),
  urlKind: UrlKind,
  openUrl: z.string().optional(),
  visualKind: CardVisualKind,
  media: PresentationMedia.optional(),
  summary: z.string().optional(),
  userSignal: z.string().optional(),
  chips: z.array(z.string()).max(8).default([]),
  state: MembershipState,
  section: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidenceStrength: EvidenceStrength,
  evidenceRefs: z.array(z.string()).default([]),
  extractionStatus: z.string(),
  attention: z.enum(['none', 'weak', 'conflict', 'review']).default('none'),
  atomicItemCount: z.number().int().min(0).default(0),
});
export type VisualResourceCard = z.infer<typeof VisualResourceCard>;

export const VisualSection = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  totalCount: z.number().int().min(0),
  visibleCount: z.number().int().min(0),
  collapsedByDefault: z.boolean().default(false),
  cards: z.array(VisualResourceCard),
});
export type VisualSection = z.infer<typeof VisualSection>;

export const WorkspaceStat = z.object({
  id: z.string(),
  label: z.string(),
  value: z.number().int().min(0),
  tone: z.enum(['neutral', 'positive', 'warning', 'danger']).default('neutral'),
});
export type WorkspaceStat = z.infer<typeof WorkspaceStat>;

export const ViewWorkspaceArtifact = z.object({
  kind: z.literal('semantic_view_workspace'),
  viewName: z.string(),
  goal: z.string(),
  commandText: z.string(),
  layout: WorkspaceLayout.default('board'),
  headline: z.string(),
  subhead: z.string(),
  stats: z.array(WorkspaceStat),
  sections: z.array(VisualSection),
  reviewLane: z.array(VisualResourceCard),
  hiddenExcludedCount: z.number().int().min(0),
  suggestedPrompts: z.array(z.string()).max(6).default([]),
  availableLayouts: z.array(WorkspaceLayout).default(['board', 'gallery', 'map', 'compact']),
  generatedAt: z.string(),
});
export type ViewWorkspaceArtifact = z.infer<typeof ViewWorkspaceArtifact>;

export const ViewSectionPage = z.object({
  viewId: z.string(),
  sectionId: z.string(),
  title: z.string(),
  totalCount: z.number().int().min(0),
  cursor: z.number().int().min(0),
  nextCursor: z.number().int().min(0).nullable(),
  limit: z.number().int().positive(),
  cards: z.array(VisualResourceCard),
});
export type ViewSectionPage = z.infer<typeof ViewSectionPage>;

export const InspectorTab = z.enum(['overview', 'evidence', 'notes', 'related']);
export type InspectorTab = z.infer<typeof InspectorTab>;

export const TargetInspector = z.object({
  targetKind: z.enum(['resource', 'atomic_item']),
  targetId: z.string(),
  parentResourceId: z.string().optional(),
  title: z.string(),
  host: z.string(),
  urlKind: UrlKind,
  safeOpenUrl: z.string().optional(),
  visualKind: CardVisualKind,
  media: PresentationMedia.optional(),
  currentViewMembership: z.object({
    viewId: z.string(),
    membershipId: z.string(),
    state: MembershipState,
    section: z.string().optional(),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
    evidenceStrength: EvidenceStrength,
  }).optional(),
  summary: z.string().optional(),
  userNotes: z.array(z.object({
    id: z.string().optional(),
    tags: z.array(z.string()).default([]),
    description: z.string().optional(),
    decision: z.string(),
    source: z.string(),
    createdAt: z.string(),
  })).default([]),
  evidence: z.array(z.object({
    label: z.string(),
    kind: z.string(),
    text: z.string(),
    provenance: z.string(),
    confidence: z.number().min(0).max(1),
  })).default([]),
  technicalEvidenceRefs: z.array(z.string()).default([]),
  extractionStatus: z.string(),
  atomicItems: z.array(z.object({
    itemId: z.string(),
    itemKind: z.string(),
    name: z.string(),
    summary: z.string().optional(),
    confidence: z.number().min(0).max(1),
  })).default([]),
  relatedViews: z.array(z.object({
    viewId: z.string(),
    name: z.string(),
    state: MembershipState,
    section: z.string().optional(),
  })).default([]),
  relatedResources: z.array(z.object({
    resourceId: z.string(),
    title: z.string(),
    host: z.string(),
  })).default([]),
});
export type TargetInspector = z.infer<typeof TargetInspector>;

const ShowViewAction = z.object({
  kind: z.literal('show_view'),
  viewId: z.string(),
});

const SetLayoutAction = z.object({
  kind: z.literal('set_layout'),
  layout: WorkspaceLayout,
});

const FocusSectionAction = z.object({
  kind: z.literal('focus_section'),
  sectionId: z.string(),
});

const SetFiltersAction = z.object({
  kind: z.literal('set_filters'),
  states: z.array(MembershipState).default([]),
  tags: z.array(z.string()).default([]),
  query: z.string().default(''),
});

const OpenResourceAction = z.object({
  kind: z.literal('open_resource'),
  targetKind: z.enum(['resource', 'atomic_item']),
  targetId: z.string(),
  inspectorTab: z.enum(['overview', 'evidence', 'notes', 'related']).default('overview'),
});

const ShowExplanationAction = z.object({
  kind: z.literal('show_explanation'),
  viewId: z.string(),
  targetKind: z.enum(['resource', 'atomic_item']),
  targetId: z.string(),
});

const OpenReviewAction = z.object({
  kind: z.literal('open_review'),
  queue: z.enum(['unmarked', 'weak', 'conflict', 'needs_review', 'ambiguous', 'extraction_failure']),
  sourceViewId: z.string().optional(),
});

const CompareRevisionsAction = z.object({
  kind: z.literal('compare_revisions'),
  viewId: z.string(),
  leftRevisionId: z.string(),
  rightRevisionId: z.string(),
});

export const PresentationAction = z.discriminatedUnion('kind', [
  ShowViewAction,
  SetLayoutAction,
  FocusSectionAction,
  SetFiltersAction,
  OpenResourceAction,
  ShowExplanationAction,
  OpenReviewAction,
  CompareRevisionsAction,
]);
export type PresentationAction = z.infer<typeof PresentationAction>;

export const AgentPresentationPlan = z.object({
  reply: z.string(),
  actions: z.array(PresentationAction).default([]),
});
export type AgentPresentationPlan = z.infer<typeof AgentPresentationPlan>;

const PRESENTATION_ACTIONS = new Set([
  'show_view',
  'set_layout',
  'focus_section',
  'set_filters',
  'open_resource',
  'show_explanation',
  'open_review',
  'compare_revisions',
]);

export function assertPresentationActionsNonDestructive(actions: PresentationAction[]): void {
  for (const action of actions) {
    if (!PRESENTATION_ACTIONS.has(action.kind)) {
      throw new Error(`Unsupported or state-changing presentation action: ${(action as { kind: string }).kind}`);
    }
  }
}
