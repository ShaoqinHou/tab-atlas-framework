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
import { runAgentCommand } from './commandService.js';
import { createCodexScanJob } from './scanService.js';
import { addUserAnnotation, getUserAnnotationById } from '../annotations/service.js';
import { getReviewNext } from '../review/service.js';
import { explainMembership } from './tools.js';
import { acceptViewRevision, getLatestViewRevision } from '../views/feedbackService.js';
import { applyViewPlan, previewView } from '../views/service.js';

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
}

export interface SendConversationMessageOptions {
  plannerProvider: LlmProvider;
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
  const context = buildConversationContext(db, input.content);
  const plan = await planConversationTurn(options.plannerProvider, history, context);
  const assistant = appendConversationMessage(db, {
    threadId: input.threadId,
    role: 'assistant',
    content: plan.reply,
    context: { questions: plan.questions, assumptions: plan.assumptions, retrievedContext: context },
  });
  persistAgentTurnPlan(db, { threadId: input.threadId, assistantMessageId: assistant.id, plan });
  for (const action of actionsReadyWithoutConfirmation(plan)) {
    await runPersistedAgentAction(db, action.id, { plannerProvider: options.plannerProvider });
  }
  return getConversationSnapshot(db, input.threadId);
}

export async function planConversationTurn(
  provider: LlmProvider,
  history: ConversationMessageRecord[],
  context: unknown,
): Promise<AgentTurnPlanValue> {
  const prompt = [
    'You are the TabAtlas conversational agent.',
    'Use only local TabAtlas context supplied here. Do not browse pages, mutate browser tabs, inspect cookies, parse sessions, run shell commands, or invent transcript content.',
    'Return a JSON AgentTurnPlan with reply, actions, questions, and assumptions.',
    'Allowed action kinds: plan_view, refine_view, start_review, scan_resources, add_annotation, explain_membership, accept_view.',
    'Preview/read actions may use approval automatic or preview. Annotations, broad scans, and view acceptance must use approval confirm.',
    '',
    'Conversation history:',
    JSON.stringify(history.map(message => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })), null, 2),
    '',
    'Retrieved local context:',
    JSON.stringify(context, null, 2),
  ].join('\n');

  const planned = await runStructured(provider, prompt, AgentTurnPlan, {
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
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO agent_actions
      (id, thread_id, message_id, action_kind, approval, status, idempotency_key, action_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const action of plan.actions) {
      const existing = db.prepare('SELECT id FROM agent_actions WHERE id = ?').get(action.id) as { id: string } | undefined;
      if (existing) throw new Error(`Duplicate agent action id: ${action.id}`);
      insert.run(
        action.id,
        input.threadId,
        input.assistantMessageId ?? null,
        action.kind,
        action.approval,
        action.id,
        JSON.stringify(action),
        now,
        now,
      );
    }
  });
  tx();
  return plan;
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

export function cancelAgentAction(db: Database.Database, actionId: string): AgentActionRecord {
  const record = getAgentAction(db, actionId);
  if (record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled') return record;
  updateAgentAction(db, { actionId, status: 'cancelled', result: { cancelled: true } });
  return getAgentAction(db, actionId);
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
      return runAgentCommand(db, requirePlannerProvider(options, action.kind), {
        text: action.commandText,
        mode: 'codex',
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
      return runAgentCommand(db, requirePlannerProvider(options, action.kind), {
        text: [
          `Refine existing view "${preview.name}".`,
          preview.goal ? `Existing goal: ${preview.goal}` : '',
          `User refinement: ${action.instruction}`,
        ].filter(Boolean).join(' '),
        mode: 'codex',
        candidateLimit: 200,
        seedResourceIds,
        parentRevisionId: parentRevision?.id,
      });
    }
    case 'start_review':
      return getReviewNext(db, { queue: action.queue, preload: 2 });
    case 'scan_resources':
      return createCodexScanJob(db, {
        resourceIds: action.resourceIds,
        limit: action.limit,
        force: action.force,
      }, {
        jobId: idempotentActionObjectId('job_agent', action.id),
      });
    case 'add_annotation':
      {
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
      }
    case 'explain_membership':
      return explainMembership(db, {
        resourceId: action.resourceId,
        viewId: action.viewId,
      });
    case 'accept_view':
      if (action.revisionId) return acceptViewRevision(db, action.revisionId);
      return applyViewPlan(db, action.viewId, 'accepted');
    default:
      return assertNever(action);
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
    SELECT id, thread_id, message_id, action_kind, approval, status, idempotency_key, execution_token,
           execution_started_at, action_json, result_json, error, created_at, updated_at, finished_at
    FROM agent_actions
    WHERE thread_id = ?
    ORDER BY created_at, id
  `).all(threadId) as AgentActionRow[];
  return rows.map(actionFromRow);
}

export function getAgentAction(db: Database.Database, actionId: string): AgentActionRecord {
  const row = db.prepare(`
    SELECT id, thread_id, message_id, action_kind, approval, status, idempotency_key, execution_token,
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

function buildConversationContext(db: Database.Database, message: string): unknown {
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
    resources: resources.map(resource => ({
      id: resource.id,
      title: resource.title_best,
      urlKind: resource.url_kind,
      host: resource.host,
      redactedUrl: resource.redacted_url,
    })),
    views: views.map(view => ({
      id: view.id,
      name: view.name,
      status: view.status,
      createdAt: view.created_at,
    })),
  };
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
