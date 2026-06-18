import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { validateAgentTurnPlan, type AgentAction, type AgentTurnPlan } from './actionProtocol.js';

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

export function appendConversationMessage(
  db: Database.Database,
  input: {
    threadId: string;
    role: ConversationMessageRecord['role'];
    content: string;
    context?: unknown;
  },
): ConversationMessageRecord {
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

export function persistAgentTurnPlan(
  db: Database.Database,
  input: { threadId: string; assistantMessageId?: string; plan: AgentTurnPlan },
): AgentTurnPlan {
  const plan = validateAgentTurnPlan(input.plan);
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO agent_actions
      (id, thread_id, message_id, action_kind, approval, status, action_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const action of plan.actions) {
      insert.run(
        action.id,
        input.threadId,
        input.assistantMessageId ?? null,
        action.kind,
        action.approval,
        JSON.stringify(action),
        now,
        now,
      );
    }
  });
  tx();
  return plan;
}

export function updateAgentAction(
  db: Database.Database,
  input: {
    actionId: string;
    status: 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    result?: unknown;
    error?: string;
  },
): AgentAction {
  const row = db.prepare(`SELECT action_json FROM agent_actions WHERE id = ?`).get(input.actionId) as { action_json: string } | undefined;
  if (!row) throw new Error(`Agent action not found: ${input.actionId}`);
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
  return JSON.parse(row.action_json) as AgentAction;
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

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
