import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import {
  AgentAction,
  AgentTurnPlan,
  actionsReadyWithoutConfirmation,
  validateAgentTurnPlan,
  type AgentAction as AgentActionValue,
  type AgentTurnPlan as AgentTurnPlanValue,
} from './actionProtocol.js';
import { runStructured } from '../llm/runStructured.js';
import type { LlmProvider } from '../llm/types.js';
import { runAgentCommand, type RunAgentCommandInput } from './commandService.js';
import { createCodexScanJob } from './scanService.js';
import { addUserAnnotation, getUserAnnotationById } from '../annotations/service.js';
import { createReviewSession } from '../review/sessionService.js';
import { explainMembership } from './tools.js';
import { acceptViewRevision, getLatestViewRevision } from '../views/feedbackService.js';
import { applyViewPlan, createUserCommand, persistSemanticViewPlan, previewView } from '../views/service.js';
import { redactSensitiveText, redactUrlForPrompt } from '../security/urlPrivacy.js';
import { withPromptManifestRecorder } from '../security/promptManifest.js';
import { isPresentationOnlyCommand, planPresentationActionsFromText } from '../presentation/actionPlanner.js';
import { getViewWorkspace } from '../presentation/workspaceService.js';
import { materializeAgentTurnPlan } from './actionIdentity.js';
import {
  claimActionEffect,
  completeActionEffect,
  failActionEffect,
  recoverStaleRunningEffects,
  type ActionEffectKind,
} from './actionEffectLedger.js';

export interface ConversationThreadRecord {
  id: string;
  title?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageRecord {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  context?: unknown;
  createdAt: string;
}

export interface AgentActionRecord {
  id: string;
  threadId: string;
  messageId?: string;
  modelActionKey?: string;
  actionOrdinal?: number;
  kind: AgentActionValue['kind'];
  approval: AgentActionValue['approval'];
  status: 'proposed' | 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  action: AgentActionValue;
  result?: unknown;
  error?: string;
  idempotencyKey: string;
  executionToken?: string;
  executionStartedAt?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface ConversationSnapshot {
  thread: ConversationThreadRecord;
  messages: ConversationMessageRecord[];
  actions: AgentActionRecord[];
}

export interface SendConversationMessageInput {
  threadId: string;
  content: string;
  activeViewId?: string;
  currentLayout?: string;
  currentFilters?: unknown;
}

export interface SendConversationMessageOptions {
  plannerProvider: LlmProvider;
  actionPlannerProvider?: LlmProvider;
  deferActionExecution?: boolean;
}

export interface AgentActionExecutionOptions {
  plannerProvider?: LlmProvider;
}

export function createConversationThread(
  db: Database.Database,
  title?: string,
): ConversationThreadRecord {
  const id = `thread_${nanoid()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO conversation_threads (id, title, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
  `).run(id, title ?? null, now, now);
  return { id, title, status: 'active', createdAt: now, updatedAt: now };
}

export function getConversationThread(db: Database.Database, threadId: string): ConversationThreadRecord {
  const row = db.prepare(`
    SELECT id, title, status, created_at, updated_at
    FROM conversation_threads
    WHERE id = ?
  `).get(threadId) as {
    id: string;
    title: string | null;
    status: string;
    created_at: string;
    updated_at: string;
  } | undefined;
  if (!row) throw new Error(`Conversation thread not found: ${threadId}`);
  return {
    id: row.id,
    title: row.title ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getConversationSnapshot(db: Database.Database, threadId: string): ConversationSnapshot {
  return {
    thread: getConversationThread(db, threadId),
    messages: listConversationMessages(db, threadId),
    actions: listAgentActions(db, threadId),
  };
}

export function appendConversationMessage(
  db: Database.Database,
  input: {
    threadId: string;
    role: ConversationMessageRecord['role'];
    content: string;
    context?: unknown;
  },
): ConversationMessageRecord {
  getConversationThread(db, input.threadId);
  const id = `message_${nanoid()}`;
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO conversation_messages (id, thread_id, role, content, context_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.threadId,
    input.role,
    input.content,
    input.context === undefined ? null : JSON.stringify(input.context),
    createdAt,
  );
  db.prepare(`UPDATE conversation_threads SET updated_at = ? WHERE id = ?`).run(createdAt, input.threadId);
  return { id, threadId: input.threadId, role: input.role, content: input.content, context: input.context, createdAt };
}

export async function sendConversationMessage(
  db: Database.Database,
  input: SendConversationMessageInput,
  options: SendConversationMessageOptions,
): Promise<ConversationSnapshot> {
  appendConversationMessage(db, {
    threadId: input.threadId,
    role: 'user',
    content: input.content,
  });
  const history = listConversationMessages(db, input.threadId);
  const context = buildConversationContext(db, input.content, input);
  const presentationPlan = planPresentationTurn(db, input);
  if (presentationPlan && isPresentationOnlyCommand(input.content)) {
    appendConversationMessage(db, {
      threadId: input.threadId,
      role: 'assistant',
      content: presentationPlan.reply,
      context: { presentationPlan, retrievedContext: context },
    });
    return getConversationSnapshot(db, input.threadId);
  }
  const planned = await planConversationTurn(db, options.plannerProvider, history, context);
  const plan = normalizeConversationActionPlan(
    mergePresentationActions(planned, presentationPlan?.actions ?? []),
    input.content,
    input.activeViewId,
    context,
  );
  const assistant = appendConversationMessage(db, {
    threadId: input.threadId,
    role: 'assistant',
    content: plan.reply,
    context: {
      questions: plan.questions,
      assumptions: plan.assumptions,
      retrievedContext: context,
      presentationPlan: (plan.presentationActions ?? []).length
        ? { reply: presentationPlan?.reply ?? 'Updated the workspace presentation.', actions: plan.presentationActions ?? [] }
        : undefined,
    },
  });
  const persistedPlan = persistAgentTurnPlan(db, { threadId: input.threadId, assistantMessageId: assistant.id, plan });
  const readyActions = actionsReadyWithoutConfirmation(persistedPlan);
  const executionOptions = {
    plannerProvider: options.actionPlannerProvider ?? options.plannerProvider,
  };
  if (options.deferActionExecution) {
    void runReadyActionsSequentially(db, readyActions.map(action => action.id), executionOptions)
      .catch(() => undefined);
  } else {
    await runReadyActionsSequentially(db, readyActions.map(action => action.id), executionOptions);
  }
  return getConversationSnapshot(db, input.threadId);
}

async function runReadyActionsSequentially(
  db: Database.Database,
  actionIds: string[],
  options: AgentActionExecutionOptions,
): Promise<void> {
  let latestCreatedViewId: string | undefined;
  for (const actionId of actionIds) {
    if (latestCreatedViewId) attachReviewActionToCreatedView(db, actionId, latestCreatedViewId);
    const record = await runPersistedAgentAction(db, actionId, options);
    latestCreatedViewId = firstViewIdFromActionResult(record.result) ?? latestCreatedViewId;
  }
}

function attachReviewActionToCreatedView(db: Database.Database, actionId: string, sourceViewId: string): void {
  const record = getAgentAction(db, actionId);
  if (record.action.kind !== 'start_review') return;
  if (record.action.sourceViewId && viewExists(db, record.action.sourceViewId)) return;
  const action = { ...record.action, sourceViewId };
  db.prepare(`
    UPDATE agent_actions
    SET action_json = ?, updated_at = ?
    WHERE id = ? AND status IN ('proposed', 'approved')
  `).run(JSON.stringify(action), new Date().toISOString(), actionId);
}

function firstViewIdFromActionResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as { viewIds?: unknown; createdViewIds?: unknown; viewId?: unknown };
  if (Array.isArray(record.viewIds) && typeof record.viewIds[0] === 'string') return record.viewIds[0];
  if (Array.isArray(record.createdViewIds) && typeof record.createdViewIds[0] === 'string') return record.createdViewIds[0];
  return typeof record.viewId === 'string' ? record.viewId : undefined;
}

function planPresentationTurn(
  db: Database.Database,
  input: SendConversationMessageInput,
): ReturnType<typeof planPresentationActionsFromText> | null {
  if (!input.activeViewId) return null;
  try {
    const workspace = getViewWorkspace(db, input.activeViewId, { maxCardsPerSection: 100 });
    const plan = planPresentationActionsFromText(input.content, {
      activeViewId: input.activeViewId,
      workspace,
    });
    return plan.actions.length ? plan : null;
  } catch {
    return null;
  }
}

export async function planConversationTurn(
  db: Database.Database,
  provider: LlmProvider,
  history: ConversationMessageRecord[],
  context: unknown,
): Promise<AgentTurnPlanValue> {
  const prompt = [
    'You are the TabAtlas conversational agent.',
    'Use only local TabAtlas context supplied here. Do not browse pages, mutate browser tabs, inspect cookies, parse sessions, run shell commands, or invent transcript content.',
    'Return a JSON AgentTurnPlan with reply, actions, presentationActions, questions, and assumptions.',
    'Allowed action kinds: plan_view, refine_view, start_review, scan_resources, add_annotation, explain_membership, accept_view.',
    'Use refine_view only when the user explicitly asks to refine, adjust, exclude from, or change this/current/active view. If the user asks for a new board, workspace, collection, project space, or later-review view, use plan_view even when an activeViewId is supplied.',
    'When a request reviews weak, conflicting, or uncertain items in the active view, include sourceViewId on start_review.',
    'For requests about information inside videos, state evidence readiness in plain language: known atomic items, transcript/description evidence, metadata-only videos, videos needing targeted extraction or scan, and unavailable transcripts.',
    'When evidence is insufficient for inside-video details, offer exactly one bounded scan_resources action for the relevant resource IDs. Do not scan the whole library.',
    'When users explicitly list desired project sections, preserve supported section dimensions or explain any merge; do not collapse unrelated categories into a generic bucket.',
    'Preview/read actions may use approval automatic or preview. Annotations, broad scans, and view acceptance must use approval confirm.',
    '',
    'Conversation history:',
    JSON.stringify(history.map(message => ({
      role: message.role,
      content: redactSensitiveText(message.content),
      createdAt: message.createdAt,
    })), null, 2),
    '',
    'Retrieved local context:',
    JSON.stringify(context, null, 2),
  ].join('\n');

  const planned = await runStructured(withPromptManifestRecorder(db, provider, 'conversation_planner', {
    historyCount: history.length,
  }), prompt, AgentTurnPlan, {
    maxRetries: 2,
    semanticValidate: plan => validateActionPlan(plan),
  });
  return validateAgentTurnPlan(planned.value);
}

export function persistAgentTurnPlan(
  db: Database.Database,
  input: { threadId: string; assistantMessageId?: string; plan: AgentTurnPlanValue },
): AgentTurnPlanValue {
  getConversationThread(db, input.threadId);
  const plan = validateAgentTurnPlan(input.plan);
  const materialized = materializeAgentTurnPlan({
    threadId: input.threadId,
    assistantMessageId: input.assistantMessageId,
    plan,
  });
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO agent_actions
      (id, thread_id, message_id, model_action_key, action_ordinal, action_kind, approval, status, idempotency_key, action_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const tx = db.transaction(() => {
    for (const materializedAction of materialized.actions) {
      const { action } = materializedAction;
      insert.run(
        action.id,
        input.threadId,
        input.assistantMessageId ?? null,
        materializedAction.modelActionKey,
        materializedAction.actionOrdinal,
        action.kind,
        action.approval,
        materializedAction.idempotencyKey,
        JSON.stringify(action),
        now,
        now,
      );
    }
  });
  tx();
  return materialized.plan;
}

export async function confirmAgentAction(
  db: Database.Database,
  actionId: string,
  options: AgentActionExecutionOptions = {},
): Promise<AgentActionRecord> {
  const record = getAgentAction(db, actionId);
  if (record.status === 'succeeded' || record.status === 'failed') return record;
  if (record.status === 'cancelled') return record;
  if (record.action.approval !== 'confirm') return runPersistedAgentAction(db, actionId, options);
  approveAgentAction(db, actionId);
  return runPersistedAgentAction(db, actionId, options);
}

export function normalizeConversationActionPlan(
  plan: AgentTurnPlanValue,
  userText: string,
  activeViewId?: string,
  context?: unknown,
): AgentTurnPlanValue {
  const candidateLimit = conversationCandidateLimit();
  const explicitRefinement = isExplicitActiveViewRefinementRequest(userText);
  const createsNewView = plan.actions.some(action => action.kind === 'plan_view')
    || plan.actions.some(action => action.kind === 'refine_view' && activeViewId && !explicitRefinement);
  return validateAgentTurnPlan({
    ...plan,
    actions: plan.actions.map(action => {
      if (action.kind === 'plan_view') {
        return { ...action, candidateLimit: Math.min(action.candidateLimit, candidateLimit) };
      }
      if (action.kind === 'refine_view' && activeViewId && !explicitRefinement) {
        return {
          id: action.id,
          kind: 'plan_view',
          approval: 'preview',
          rationale: 'The request asks for a new workspace, so it should create a separate preview instead of rewriting the active view.',
          commandText: userText,
          candidateLimit,
        };
      }
      if (action.kind === 'scan_resources') {
        const resourceIds = uniqueStrings(action.resourceIds);
        const fallbackIds = resourceIds.length ? resourceIds : fallbackScanResourceIds(context, userText);
        return {
          ...action,
          resourceIds: fallbackIds,
          limit: fallbackIds.length ? Math.min(action.limit, fallbackIds.length) : action.limit,
        };
      }
      if (action.kind === 'start_review' && createsNewView && action.sourceViewId === activeViewId) {
        const withoutStaleSource = { ...action };
        delete withoutStaleSource.sourceViewId;
        return withoutStaleSource;
      }
      if (action.kind === 'start_review' && action.sourceViewId && !action.sourceViewId.startsWith('view_')) {
        const withoutInvalidSource = { ...action };
        delete withoutInvalidSource.sourceViewId;
        return withoutInvalidSource;
      }
      return action;
    }),
  });
}

export async function retryAgentAction(
  db: Database.Database,
  actionId: string,
  options: AgentActionExecutionOptions = {},
): Promise<AgentActionRecord> {
  const record = getAgentAction(db, actionId);
  if (record.status !== 'failed') return record;
  const nextStatus = record.action.approval === 'confirm' ? 'approved' : 'proposed';
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE agent_actions
    SET status = ?, error = NULL, updated_at = ?, finished_at = NULL
    WHERE id = ? AND status = 'failed'
  `).run(nextStatus, now, actionId);
  return runPersistedAgentAction(db, actionId, options);
}

export function cancelAgentAction(db: Database.Database, actionId: string): AgentActionRecord {
  const record = getAgentAction(db, actionId);
  if (record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled') return record;
  updateAgentAction(db, { actionId, status: 'cancelled', result: { cancelled: true } });
  return getAgentAction(db, actionId);
}

export function recoverInterruptedAgentActions(
  db: Database.Database,
  input: { staleAfterMs?: number; now?: Date; recoverAllRunning?: boolean } = {},
): { recovered: number; staleRunning: number; buggedProposed: number; expectedProposed: number } {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - (input.staleAfterMs ?? Number(process.env.TABATLAS_ACTION_STALE_MS ?? 5 * 60 * 1000))).toISOString();
  recoverStaleRunningEffects(db, nowIso);
  let recovered = 0;
  let staleRunning = 0;
  let buggedProposed = 0;
  const expectedProposed = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_actions
    WHERE status = 'proposed' AND approval = 'confirm'
  `).get() as { count: number }).count;
  const running = db.prepare(`
    SELECT id, status, approval
    FROM agent_actions
    WHERE status = 'running'
      ${input.recoverAllRunning ? '' : 'AND updated_at < ?'}
  `).all(...(input.recoverAllRunning ? [] : [cutoff])) as Array<{ id: string; status: AgentActionRecord['status']; approval: AgentActionRecord['approval'] }>;
  for (const action of running) {
    const effect = latestEffectForAction(db, action.id);
    if (effect?.status === 'succeeded') {
      updateRecoveredAction(db, action.id, 'succeeded', effect.result_json ? parseJson(effect.result_json) : undefined, undefined, nowIso);
      recordRecovery(db, action, 'succeeded', 'effect_succeeded', { effectId: effect.id });
    } else {
      interruptIncompleteEffectsForAction(db, action.id, nowIso);
      updateRecoveredAction(db, action.id, 'failed', undefined, effect?.error ?? 'Interrupted while running; retry is available.', nowIso);
      recordRecovery(db, action, 'failed', effect?.status === 'failed' ? 'effect_failed' : 'stale_running_interrupted', { effectId: effect?.id });
    }
    staleRunning += 1;
    recovered += 1;
  }

  const proposed = db.prepare(`
    SELECT id, status, approval
    FROM agent_actions
    WHERE status = 'proposed' AND approval IN ('automatic', 'preview')
  `).all() as Array<{ id: string; status: AgentActionRecord['status']; approval: AgentActionRecord['approval'] }>;
  for (const action of proposed) {
    updateRecoveredAction(db, action.id, 'failed', undefined, 'Automatic action did not begin execution; retry is available.', nowIso);
    recordRecovery(db, action, 'failed', 'automatic_proposed_recovered', {});
    buggedProposed += 1;
    recovered += 1;
  }

  return { recovered, staleRunning, buggedProposed, expectedProposed };
}

export async function runPersistedAgentAction(
  db: Database.Database,
  actionId: string,
  options: AgentActionExecutionOptions = {},
): Promise<AgentActionRecord> {
  const claim = claimAgentActionForExecution(db, actionId);
  if (!claim.claimed) return claim.record;
  try {
    const result = await executeAgentAction(db, claim.record.action, options);
    finishClaimedAgentAction(db, { actionId, executionToken: claim.executionToken, status: 'succeeded', result });
  } catch (error) {
    finishClaimedAgentAction(db, {
      actionId,
      executionToken: claim.executionToken,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return getAgentAction(db, actionId);
}

export async function executeAgentAction(
  db: Database.Database,
  action: AgentActionValue,
  options: AgentActionExecutionOptions = {},
): Promise<unknown> {
  switch (action.kind) {
    case 'plan_view':
      return runViewPlanningEffect(db, action, options, {
        text: action.commandText,
        candidateLimit: action.candidateLimit,
      });
    case 'refine_view': {
      const preview = previewView(db, action.viewId);
      const parentRevision = getLatestViewRevision(db, action.viewId);
      const seedResourceIds = db.prepare(`
        SELECT DISTINCT target_id AS id
        FROM memberships
        WHERE view_id = ? AND target_kind = 'resource'
      `).all(action.viewId).map((row: unknown) => (row as { id: string }).id);
      return runViewPlanningEffect(db, action, options, {
        text: [
          `Refine existing view "${preview.name}".`,
          preview.goal ? `Existing goal: ${preview.goal}` : '',
          `User refinement: ${action.instruction}`,
        ].filter(Boolean).join(' '),
        candidateLimit: conversationCandidateLimit(),
        seedResourceIds,
        parentRevisionId: parentRevision?.id,
      });
    }
    case 'start_review':
      return createReviewSession(db, {
        type: action.queue === 'weak' || action.queue === 'needs_review'
          ? 'weak_matches'
          : action.queue === 'conflict'
            ? 'conflicts'
            : action.queue === 'ambiguous'
              ? 'ambiguous'
            : action.queue === 'extraction_failure'
              ? 'extraction_failures'
              : 'unmarked',
        title: `${action.queue.replace(/_/g, ' ')} review`,
        commandText: action.queue,
        sourceViewId: action.sourceViewId && viewExists(db, action.sourceViewId) ? action.sourceViewId : undefined,
        preload: 5,
      });
    case 'scan_resources':
      if (action.resourceIds.length === 0) {
        throw new Error('scan_resources requires explicit resourceIds; conversation actions must not scan the whole library');
      }
      return runActionEffect(db, action.id, 'scan_job_create', {
        resourceIds: action.resourceIds,
        limit: action.limit,
        force: action.force,
      }, () => createCodexScanJob(db, {
        resourceIds: action.resourceIds,
        limit: action.limit,
        force: action.force,
      }, {
        jobId: idempotentActionObjectId('job_agent', action.id),
      }));
    case 'add_annotation':
      return runActionEffect(db, action.id, 'annotation_write', {
        resourceId: action.resourceId,
        tags: action.tags,
        decision: action.decision,
      }, () => {
        const annotationId = idempotentActionObjectId('ann_agent', action.id);
        const existing = getUserAnnotationById(db, annotationId);
        if (existing) return existing;
        return addUserAnnotation(db, {
          id: annotationId,
          targetKind: 'resource',
          targetId: action.resourceId,
          tags: action.tags,
          description: action.description,
          decision: action.decision,
          source: 'agent_chat',
        });
      });
    case 'explain_membership':
      return explainMembership(db, {
        resourceId: action.resourceId,
        viewId: action.viewId,
      });
    case 'accept_view':
      return runActionEffect(db, action.id, 'view_accept', {
        viewId: action.viewId,
        revisionId: action.revisionId,
      }, () => {
        if (action.revisionId) return acceptViewRevision(db, action.revisionId);
        return applyViewPlan(db, action.viewId, 'accepted');
      });
    default:
      return assertNever(action);
  }
}

async function runViewPlanningEffect(
  db: Database.Database,
  action: Extract<AgentActionValue, { kind: 'plan_view' | 'refine_view' }>,
  options: AgentActionExecutionOptions,
  input: Omit<RunAgentCommandInput, 'mode' | 'dryRun'>,
): Promise<unknown> {
  const effectKind: ActionEffectKind = action.kind === 'refine_view' ? 'view_refinement_create' : 'view_plan_create';
  const idempotencyKey = `${action.id}:${effectKind}`;
  const commandId = idempotentActionObjectId('cmd_agent', action.id);
  const existingViewIds = viewIdsForCommand(db, commandId);
  if (existingViewIds.length) {
    const result = replayedViewPlanningResult(db, commandId, existingViewIds);
    try { completeActionEffect(db, idempotencyKey, result); } catch { /* effect may not exist yet */ }
    return result;
  }

  const claim = claimActionEffect(db, {
    actionId: action.id,
    effectKind,
    idempotencyKey,
    effectInput: input,
  });
  if (!claim.claimed) return claim.effect.result ?? { status: claim.effect.status };

  try {
    const dryRun = await runAgentCommand(db, requirePlannerProvider(options, action.kind), {
      ...input,
      mode: 'codex',
      dryRun: true,
    });
    createUserCommand(db, input.text, {
      mode: dryRun.mode,
      sourceActionId: action.id,
      candidateLimit: input.candidateLimit,
      seedResourceIds: input.seedResourceIds,
      parentRevisionId: input.parentRevisionId,
    }, commandId);
    const viewIds = dryRun.plan.views.map((_view, index) => idempotentActionObjectId(`view_agent_${index}`, action.id));
    const persisted = persistSemanticViewPlan(db, commandId, dryRun.plan, {
      origin: dryRun.mode,
      parentRevisionId: input.parentRevisionId,
      viewIds,
    });
    const result = {
      ...dryRun,
      commandId,
      viewIds: persisted.viewIds,
      previews: persisted.viewIds.map(viewId => previewView(db, viewId)),
      dryRun: false,
      replayed: false,
    };
    completeActionEffect(db, idempotencyKey, result);
    return result;
  } catch (error) {
    failActionEffect(db, idempotencyKey, error);
    throw error;
  }
}

function runActionEffect<T>(
  db: Database.Database,
  actionId: string,
  effectKind: ActionEffectKind,
  input: unknown,
  fn: () => T,
): T | unknown {
  const idempotencyKey = `${actionId}:${effectKind}`;
  const claim = claimActionEffect(db, { actionId, effectKind, idempotencyKey, effectInput: input });
  if (!claim.claimed) return claim.effect.result ?? { status: claim.effect.status };
  try {
    const result = fn();
    completeActionEffect(db, idempotencyKey, result);
    return result;
  } catch (error) {
    failActionEffect(db, idempotencyKey, error);
    throw error;
  }
}

export function updateAgentAction(
  db: Database.Database,
  input: {
    actionId: string;
    status: AgentActionRecord['status'];
    result?: unknown;
    error?: string;
  },
): AgentActionValue {
  const row = db.prepare(`SELECT action_json FROM agent_actions WHERE id = ?`).get(input.actionId) as { action_json: string } | undefined;
  if (!row) throw new Error(`Agent action not found: ${input.actionId}`);
  const action = AgentAction.parse(parseJson(row.action_json));
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE agent_actions
    SET status = ?, result_json = ?, error = ?, updated_at = ?, finished_at = ?
    WHERE id = ?
  `).run(
    input.status,
    input.result === undefined ? null : JSON.stringify(input.result),
    input.error ?? null,
    now,
    input.status === 'succeeded' || input.status === 'failed' || input.status === 'cancelled' ? now : null,
    input.actionId,
  );
  return action;
}

function approveAgentAction(db: Database.Database, actionId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE agent_actions
    SET status = 'approved', updated_at = ?
    WHERE id = ? AND approval = 'confirm' AND status = 'proposed'
  `).run(now, actionId);
}

type AgentActionClaim =
  | { claimed: true; record: AgentActionRecord; executionToken: string }
  | { claimed: false; record: AgentActionRecord };

function claimAgentActionForExecution(db: Database.Database, actionId: string): AgentActionClaim {
  const tx = db.transaction((): AgentActionClaim => {
    const before = getAgentAction(db, actionId);
    if (before.status === 'succeeded' || before.status === 'failed' || before.status === 'cancelled' || before.status === 'running') {
      return { claimed: false, record: before };
    }
    if (before.action.approval === 'confirm' && before.status !== 'approved') {
      return { claimed: false, record: before };
    }
    if (before.status !== 'proposed' && before.status !== 'approved') {
      return { claimed: false, record: before };
    }
    const now = new Date().toISOString();
    const executionToken = crypto.randomUUID();
    const changed = db.prepare(`
      UPDATE agent_actions
      SET status = 'running',
          execution_token = ?,
          execution_started_at = ?,
          idempotency_key = CASE WHEN idempotency_key = '' THEN id ELSE idempotency_key END,
          updated_at = ?
      WHERE id = ?
        AND status = ?
        AND (
          approval <> 'confirm'
          OR status = 'approved'
        )
    `).run(executionToken, now, now, actionId, before.status).changes;
    const after = getAgentAction(db, actionId);
    return changed === 1
      ? { claimed: true, record: after, executionToken }
      : { claimed: false, record: after };
  });
  return tx();
}

function finishClaimedAgentAction(
  db: Database.Database,
  input: {
    actionId: string;
    executionToken: string;
    status: 'succeeded' | 'failed';
    result?: unknown;
    error?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE agent_actions
    SET status = ?, result_json = ?, error = ?, updated_at = ?, finished_at = ?
    WHERE id = ? AND execution_token = ? AND status = 'running'
  `).run(
    input.status,
    input.result === undefined ? null : JSON.stringify(input.result),
    input.error ?? null,
    now,
    now,
    input.actionId,
    input.executionToken,
  );
}

function idempotentActionObjectId(prefix: string, actionId: string): string {
  const digest = crypto.createHash('sha256').update(actionId).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function viewIdsForCommand(db: Database.Database, commandId: string): string[] {
  const rows = db.prepare(`
    SELECT view_id
    FROM semantic_view_specs
    WHERE command_id = ?
    ORDER BY created_at, view_id
  `).all(commandId) as Array<{ view_id: string }>;
  return rows.map(row => row.view_id);
}

function replayedViewPlanningResult(db: Database.Database, commandId: string, viewIds: string[]): unknown {
  return {
    commandId,
    viewIds,
    previews: viewIds.map(viewId => previewView(db, viewId)),
    mode: 'codex',
    codexTurnSpent: false,
    validationStatus: 'passed',
    dryRun: false,
    replayed: true,
  };
}

function mergePresentationActions(
  plan: AgentTurnPlanValue,
  deterministicActions: NonNullable<ReturnType<typeof planPresentationActionsFromText>>['actions'],
): AgentTurnPlanValue {
  if (!deterministicActions.length) return plan;
  const seen = new Set((plan.presentationActions ?? []).map(action => JSON.stringify(action)));
  const presentationActions = [...(plan.presentationActions ?? [])];
  for (const action of deterministicActions) {
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    presentationActions.push(action);
  }
  return { ...plan, presentationActions };
}

export function listConversationMessages(
  db: Database.Database,
  threadId: string,
  limit = 100,
): ConversationMessageRecord[] {
  const rows = db.prepare(`
    SELECT id, thread_id, role, content, context_json, created_at
    FROM conversation_messages
    WHERE thread_id = ?
    ORDER BY created_at
    LIMIT ?
  `).all(threadId, limit) as Array<{
    id: string;
    thread_id: string;
    role: ConversationMessageRecord['role'];
    content: string;
    context_json: string | null;
    created_at: string;
  }>;
  return rows.map(row => ({
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    context: row.context_json ? parseJson(row.context_json) : undefined,
    createdAt: row.created_at,
  }));
}

export function listAgentActions(db: Database.Database, threadId: string): AgentActionRecord[] {
  const rows = db.prepare(`
    SELECT id, thread_id, message_id, model_action_key, action_ordinal, action_kind, approval, status, idempotency_key, execution_token,
           execution_started_at, action_json, result_json, error, created_at, updated_at, finished_at
    FROM agent_actions
    WHERE thread_id = ?
    ORDER BY created_at, id
  `).all(threadId) as AgentActionRow[];
  return rows.map(actionFromRow);
}

export function getAgentAction(db: Database.Database, actionId: string): AgentActionRecord {
  const row = db.prepare(`
    SELECT id, thread_id, message_id, model_action_key, action_ordinal, action_kind, approval, status, idempotency_key, execution_token,
           execution_started_at, action_json, result_json, error, created_at, updated_at, finished_at
    FROM agent_actions
    WHERE id = ?
  `).get(actionId) as AgentActionRow | undefined;
  if (!row) throw new Error(`Agent action not found: ${actionId}`);
  return actionFromRow(row);
}

type AgentActionRow = {
  id: string;
  thread_id: string;
  message_id: string | null;
  model_action_key: string | null;
  action_ordinal: number | null;
  action_kind: AgentActionValue['kind'];
  approval: AgentActionValue['approval'];
  status: AgentActionRecord['status'];
  idempotency_key: string;
  execution_token: string | null;
  execution_started_at: string | null;
  action_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

function actionFromRow(row: AgentActionRow): AgentActionRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id ?? undefined,
    modelActionKey: row.model_action_key ?? undefined,
    actionOrdinal: row.action_ordinal ?? undefined,
    kind: row.action_kind,
    approval: row.approval,
    status: row.status,
    action: AgentAction.parse(parseJson(row.action_json)),
    result: row.result_json ? parseJson(row.result_json) : undefined,
    error: row.error ?? undefined,
    idempotencyKey: row.idempotency_key || row.id,
    executionToken: row.execution_token ?? undefined,
    executionStartedAt: row.execution_started_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function latestEffectForAction(db: Database.Database, actionId: string): {
  id: string;
  status: string;
  result_json: string | null;
  error: string | null;
} | undefined {
  return db.prepare(`
    SELECT id, status, result_json, error
    FROM action_effects
    WHERE action_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(actionId) as { id: string; status: string; result_json: string | null; error: string | null } | undefined;
}

function interruptIncompleteEffectsForAction(db: Database.Database, actionId: string, nowIso: string): number {
  return db.prepare(`
    UPDATE action_effects
    SET status = 'failed',
        error = COALESCE(error, 'Interrupted while running; retry is available.'),
        updated_at = ?,
        completed_at = COALESCE(completed_at, ?)
    WHERE action_id = ?
      AND status IN ('pending', 'running')
  `).run(nowIso, nowIso, actionId).changes;
}

function updateRecoveredAction(
  db: Database.Database,
  actionId: string,
  status: 'succeeded' | 'failed',
  result: unknown,
  error: string | undefined,
  nowIso: string,
): void {
  db.prepare(`
    UPDATE agent_actions
    SET status = ?, result_json = ?, error = ?, updated_at = ?, finished_at = ?
    WHERE id = ?
  `).run(
    status,
    result === undefined ? null : JSON.stringify(result),
    error ?? null,
    nowIso,
    nowIso,
    actionId,
  );
}

function recordRecovery(
  db: Database.Database,
  action: { id: string; status: AgentActionRecord['status']; approval: AgentActionRecord['approval'] },
  recoveredStatus: AgentActionRecord['status'],
  reason: string,
  evidence: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO agent_action_recovery_events
      (id, action_id, prior_status, recovered_status, reason, evidence_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `recovery_${nanoid()}`,
    action.id,
    action.status,
    recoveredStatus,
    reason,
    JSON.stringify({ approval: action.approval, ...evidence }),
    new Date().toISOString(),
  );
}

function buildConversationContext(
  db: Database.Database,
  message: string,
  input: Pick<SendConversationMessageInput, 'activeViewId' | 'currentLayout' | 'currentFilters'> = {},
): unknown {
  const terms = message.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 3).slice(0, 8);
  const likeClauses = terms.map(() => 'LOWER(COALESCE(title_best, \'\') || \' \' || host || \' \' || redacted_url) LIKE ?');
  const params = terms.map(term => `%${term}%`);
  const resources = db.prepare(`
    SELECT id, title_best, url_kind, host, redacted_url
    FROM resources
    ${likeClauses.length ? `WHERE ${likeClauses.join(' OR ')}` : ''}
    ORDER BY last_seen_at DESC
    LIMIT 12
  `).all(...params) as Array<{ id: string; title_best: string | null; url_kind: string; host: string; redacted_url: string }>;
  const views = db.prepare(`
    SELECT id, name, status, created_at
    FROM views
    ORDER BY created_at DESC
    LIMIT 8
  `).all() as Array<{ id: string; name: string; status: string; created_at: string }>;
  return {
    activeView: input.activeViewId ? activeViewContext(db, input.activeViewId, {
      currentLayout: input.currentLayout,
      currentFilters: input.currentFilters,
    }) : undefined,
    resources: resources.map(resource => ({
      id: resource.id,
      title: resource.title_best ? redactSensitiveText(resource.title_best) : null,
      urlKind: resource.url_kind,
      host: resource.host,
      redactedUrl: redactUrlForPrompt(resource.redacted_url),
    })),
    views: views.map(view => ({
      id: view.id,
      name: view.name,
      status: view.status,
      createdAt: view.created_at,
    })),
  };
}

function activeViewContext(
  db: Database.Database,
  viewId: string,
  input: { currentLayout?: string; currentFilters?: unknown },
): unknown {
  try {
    const preview = previewView(db, viewId);
    const latestRevision = getLatestViewRevision(db, viewId);
    return {
      activeViewId: viewId,
      name: preview.name,
      goal: preview.goal,
      status: preview.status,
      latestRevisionId: latestRevision?.id,
      sections: Object.entries(preview.countsBySection).map(([section, count]) => ({ section, count })),
      membershipCounts: preview.countsByState,
      currentLayout: input.currentLayout,
      currentFilters: input.currentFilters,
    };
  } catch (error) {
    return {
      activeViewId: viewId,
      unavailable: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateActionPlan(plan: AgentTurnPlanValue): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const action of plan.actions) {
    if (ids.has(action.id)) errors.push(`duplicate action id ${action.id}`);
    ids.add(action.id);
  }
  return errors;
}

function isExplicitActiveViewRefinementRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(refine|make\s+(it|this)\s+|keep\s+this|change\s+this|adjust\s+this|reclassify|stricter|looser)\b/.test(lower)
    || /\b(exclude|remove|reject)\b/.test(lower)
    || /\b(this|current|active|existing)\s+(view|workspace|board)\b/.test(lower);
}

function conversationCandidateLimit(): number {
  const configured = Number(process.env.TABATLAS_CONVERSATION_CANDIDATE_LIMIT ?? 24);
  if (!Number.isFinite(configured) || configured <= 0) return 24;
  return Math.min(Math.floor(configured), 120);
}

function fallbackScanResourceIds(context: unknown, userText: string): string[] {
  const explicitIds = uniqueStrings([...userText.matchAll(/\bres_[a-z0-9]+\b/gi)].map(match => match[0]));
  if (explicitIds.length) return explicitIds.slice(0, 12);
  const resources = resourcesFromConversationContext(context);
  const videoResources = resources.filter(resource => {
    const searchable = `${resource.urlKind} ${resource.host} ${resource.title}`.toLowerCase();
    return /youtube|video|transcript/.test(searchable);
  });
  const candidates = videoResources.length ? videoResources : resources;
  return uniqueStrings(candidates.map(resource => resource.id)).slice(0, 12);
}

function resourcesFromConversationContext(context: unknown): Array<{ id: string; title: string; urlKind: string; host: string }> {
  if (!context || typeof context !== 'object') return [];
  const resources = (context as { resources?: unknown }).resources;
  if (!Array.isArray(resources)) return [];
  return resources.flatMap(resource => {
    if (!resource || typeof resource !== 'object') return [];
    const record = resource as { id?: unknown; title?: unknown; urlKind?: unknown; host?: unknown };
    if (typeof record.id !== 'string' || !record.id) return [];
    return [{
      id: record.id,
      title: typeof record.title === 'string' ? record.title : '',
      urlKind: typeof record.urlKind === 'string' ? record.urlKind : '',
      host: typeof record.host === 'string' ? record.host : '',
    }];
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function viewExists(db: Database.Database, viewId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM views WHERE id = ?').get(viewId));
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported agent action: ${JSON.stringify(value)}`);
}

function requirePlannerProvider(options: AgentActionExecutionOptions, actionKind: AgentActionValue['kind']): LlmProvider {
  if (!options.plannerProvider) {
    throw new Error(`${actionKind} requires a Codex planner provider`);
  }
  return options.plannerProvider;
}
