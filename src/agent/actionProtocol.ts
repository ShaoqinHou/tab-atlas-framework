import { z } from 'zod';
import { PresentationAction } from '../presentation/contracts.js';

export const AgentActionApproval = z.enum(['automatic', 'preview', 'confirm']);

const BaseAction = z.object({
  id: z.string().min(1),
  rationale: z.string().min(1),
});

const PlanViewAction = BaseAction.extend({
  kind: z.literal('plan_view'),
  approval: z.literal('preview'),
  commandText: z.string().min(1),
  candidateLimit: z.number().int().positive().max(500).default(200),
});

const RefineViewAction = BaseAction.extend({
  kind: z.literal('refine_view'),
  approval: z.literal('preview'),
  viewId: z.string(),
  instruction: z.string().min(1),
});

const StartReviewAction = BaseAction.extend({
  kind: z.literal('start_review'),
  approval: z.literal('automatic'),
  queue: z.string().default('unmarked'),
  sourceViewId: z.string().optional(),
});

const ScanResourcesAction = BaseAction.extend({
  kind: z.literal('scan_resources'),
  approval: z.literal('confirm'),
  resourceIds: z.array(z.string()).default([]),
  limit: z.number().int().positive().max(1000).default(100),
  force: z.boolean().default(false),
});

const AddAnnotationAction = BaseAction.extend({
  kind: z.literal('add_annotation'),
  approval: z.literal('confirm'),
  resourceId: z.string(),
  tags: z.array(z.string()).default([]),
  description: z.string().optional(),
  decision: z.enum([
    'important',
    'watch_later',
    'project_reference',
    'inspiration',
    'archive_later',
    'ignore',
    'needs_deeper_read',
    'none',
  ]).default('none'),
});

const ExplainMembershipAction = BaseAction.extend({
  kind: z.literal('explain_membership'),
  approval: z.literal('automatic'),
  viewId: z.string(),
  resourceId: z.string(),
});

const AcceptViewAction = BaseAction.extend({
  kind: z.literal('accept_view'),
  approval: z.literal('confirm'),
  viewId: z.string(),
  revisionId: z.string().optional(),
});

export const AgentAction = z.discriminatedUnion('kind', [
  PlanViewAction,
  RefineViewAction,
  StartReviewAction,
  ScanResourcesAction,
  AddAnnotationAction,
  ExplainMembershipAction,
  AcceptViewAction,
]);
export type AgentAction = z.infer<typeof AgentAction>;

export const AgentTurnPlan = z.object({
  reply: z.string(),
  actions: z.array(AgentAction).default([]),
  presentationActions: z.array(PresentationAction).optional(),
  questions: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
});
export type AgentTurnPlan = z.infer<typeof AgentTurnPlan>;

export function validateAgentTurnPlan(raw: unknown): AgentTurnPlan {
  const parsed = AgentTurnPlan.parse(raw);
  const plan = { ...parsed, presentationActions: parsed.presentationActions ?? [] };
  const ids = new Set<string>();
  for (const action of plan.actions) {
    if (ids.has(action.id)) throw new Error(`Duplicate agent action id: ${action.id}`);
    ids.add(action.id);
  }
  return plan;
}

export function actionsReadyWithoutConfirmation(plan: AgentTurnPlan): AgentAction[] {
  return plan.actions.filter(action => action.approval === 'automatic' || action.approval === 'preview');
}

export function actionsRequiringConfirmation(plan: AgentTurnPlan): AgentAction[] {
  return plan.actions.filter(action => action.approval === 'confirm');
}
