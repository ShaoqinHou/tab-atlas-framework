import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import {
  appendConversationMessage,
  cancelAgentAction,
  confirmAgentAction,
  createConversationThread,
  getConversationSnapshot,
  persistAgentTurnPlan,
  runPersistedAgentAction,
  sendConversationMessage,
} from '../src/agent/conversationService.js';
import type { AgentTurnPlan } from '../src/agent/actionProtocol.js';
import type { LlmProvider } from '../src/llm/types.js';
import { buildResourceBrief } from '../src/resources/briefs.js';
import { createUserCommand, persistSemanticViewPlan } from '../src/views/service.js';
import type { SemanticViewPlan } from '../src/shared/schemas.js';

function seed() {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-18T00:00:00.000Z',
    tabs: [{
      browser: 'chrome',
      title: 'Forest moodboard',
      url: 'https://example.com/forest',
      groupTitle: 'Inspiration',
    }],
  }, 'test');
  const resourceId = (db.prepare('SELECT id FROM resources').get() as { id: string }).id;
  return { db, resourceId };
}

function queuedProvider(plans: AgentTurnPlan[], prompts: string[] = []): LlmProvider {
  return {
    async complete(prompt) {
      prompts.push(prompt);
      const plan = plans.shift();
      if (!plan) throw new Error('No queued plan');
      return { text: JSON.stringify(plan), usage: { quotaTurns: 1 } };
    },
  };
}

function queuedJsonProvider(outputs: unknown[], prompts: string[] = []): LlmProvider {
  return {
    async complete(prompt) {
      prompts.push(prompt);
      const output = outputs.shift();
      if (!output) throw new Error('No queued output');
      return { text: JSON.stringify(output), usage: { quotaTurns: 1 } };
    },
  };
}

function noActionPlan(reply = 'Done.'): AgentTurnPlan {
  return { reply, actions: [], questions: [], assumptions: [] };
}

function semanticPlanFor(resourceId: string, evidenceRef: string, name: string): SemanticViewPlan {
  return {
    commandText: 'Make a forest inspiration board',
    views: [{
      name,
      goal: 'Collect forest inspiration resources.',
      inclusionRules: ['Include forest inspiration.'],
      exclusionRules: ['Exclude unrelated resources.'],
      sections: [],
      confidence: 0.91,
      memberships: [{
        targetKind: 'resource',
        targetId: resourceId,
        state: 'strong_include',
        confidence: 0.91,
        reason: 'Codex selected the forest moodboard resource.',
        evidenceRefs: [evidenceRef],
      }],
    }],
    reviewQueues: [],
    explanation: 'Codex planned the conversational view.',
  };
}

function createAcceptedCandidateView(db: ReturnType<typeof openDatabase>, resourceId: string) {
  const brief = buildResourceBrief(db, resourceId);
  const evidenceRef = brief.evidence[0].id;
  const commandId = createUserCommand(db, 'Make inspiration board');
  const persisted = persistSemanticViewPlan(db, commandId, {
    commandText: 'Make inspiration board',
    views: [{
      name: 'Inspiration board',
      goal: 'Collect inspiration links.',
      inclusionRules: ['Include inspiration.'],
      exclusionRules: [],
      sections: [],
      confidence: 0.8,
      memberships: [{
        targetKind: 'resource',
        targetId: resourceId,
        state: 'strong_include',
        confidence: 0.8,
        reason: 'Fixture evidence.',
        evidenceRefs: [evidenceRef],
      }],
    }],
    reviewQueues: [],
    explanation: 'Fixture.',
  });
  return persisted.viewIds[0];
}

describe('persistent conversational agent actions', () => {
  it('conversation thread survives database reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-conversation-test-'));
    const dbPath = path.join(dir, 'tabatlas.sqlite');
    const db = openDatabase(dbPath);
    const thread = createConversationThread(db, 'Restartable');
    appendConversationMessage(db, { threadId: thread.id, role: 'user', content: 'Hello' });
    db.close();

    const reopened = openDatabase(dbPath);
    const snapshot = getConversationSnapshot(reopened, thread.id);

    expect(snapshot.thread.title).toBe('Restartable');
    expect(snapshot.messages[0].content).toBe('Hello');
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('supplies previous messages to the next Codex turn', async () => {
    const { db } = seed();
    const thread = createConversationThread(db, 'History');
    const prompts: string[] = [];
    const provider = queuedProvider([
      noActionPlan('First response.'),
      noActionPlan('Second response.'),
    ], prompts);

    await sendConversationMessage(db, { threadId: thread.id, content: 'First user turn' }, { plannerProvider: provider });
    await sendConversationMessage(db, { threadId: thread.id, content: 'Second user turn' }, { plannerProvider: provider });

    expect(prompts[1]).toContain('First user turn');
    expect(prompts[1]).toContain('First response.');
    expect(prompts[1]).toContain('Second user turn');
  });

  it('rejects duplicate action IDs', () => {
    const { db } = seed();
    const thread = createConversationThread(db);

    expect(() => persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'Duplicate IDs.',
        questions: [],
        assumptions: [],
        actions: [
          { id: 'action_dup', kind: 'start_review', approval: 'automatic', rationale: 'Review.', queue: 'unmarked' },
          { id: 'action_dup', kind: 'start_review', approval: 'automatic', rationale: 'Review again.', queue: 'unmarked' },
        ],
      },
    })).toThrow(/Duplicate agent action id/);
  });

  it('materializes repeated model action IDs into distinct server action IDs across assistant turns', () => {
    const { db } = seed();
    const thread = createConversationThread(db);
    const firstAssistant = appendConversationMessage(db, { threadId: thread.id, role: 'assistant', content: 'First.' });
    const secondAssistant = appendConversationMessage(db, { threadId: thread.id, role: 'assistant', content: 'Second.' });
    const plan: AgentTurnPlan = {
      reply: 'Review.',
      questions: [],
      assumptions: [],
      actions: [{ id: 'action_1', kind: 'start_review', approval: 'automatic', rationale: 'Review.', queue: 'unmarked' }],
    };

    const first = persistAgentTurnPlan(db, { threadId: thread.id, assistantMessageId: firstAssistant.id, plan });
    const second = persistAgentTurnPlan(db, { threadId: thread.id, assistantMessageId: secondAssistant.id, plan });
    const actions = getConversationSnapshot(db, thread.id).actions;

    expect(first.actions[0].id).toMatch(/^action_[a-f0-9]{24}$/);
    expect(second.actions[0].id).toMatch(/^action_[a-f0-9]{24}$/);
    expect(first.actions[0].id).not.toBe('action_1');
    expect(first.actions[0].id).not.toBe(second.actions[0].id);
    expect(actions.map(action => action.modelActionKey)).toEqual(['action_1', 'action_1']);
  });

  it('retries the same assistant turn without duplicating actions', () => {
    const { db } = seed();
    const thread = createConversationThread(db);
    const assistant = appendConversationMessage(db, { threadId: thread.id, role: 'assistant', content: 'Retryable.' });
    const plan: AgentTurnPlan = {
      reply: 'Review.',
      questions: [],
      assumptions: [],
      actions: [{ id: 'action_retry_model', kind: 'start_review', approval: 'automatic', rationale: 'Review.', queue: 'unmarked' }],
    };

    const first = persistAgentTurnPlan(db, { threadId: thread.id, assistantMessageId: assistant.id, plan });
    const second = persistAgentTurnPlan(db, { threadId: thread.id, assistantMessageId: assistant.id, plan });
    const actions = getConversationSnapshot(db, thread.id).actions;

    expect(first.actions[0].id).toBe(second.actions[0].id);
    expect(actions).toHaveLength(1);
    expect(actions[0].modelActionKey).toBe('action_retry_model');
  });

  it('executes read actions without confirmation', async () => {
    const { db } = seed();
    const thread = createConversationThread(db);
    const provider = queuedProvider([{
      reply: 'Opening review queue.',
      questions: [],
      assumptions: [],
      actions: [{ id: 'action_review', kind: 'start_review', approval: 'automatic', rationale: 'Load queue.', queue: 'unmarked' }],
    }]);

    const snapshot = await sendConversationMessage(db, { threadId: thread.id, content: 'Review something' }, { plannerProvider: provider });

    expect(snapshot.actions[0].status).toBe('succeeded');
    expect(snapshot.actions[0].result).toHaveProperty('current');
  });

  it('executes conversational plan_view actions through Codex semantic planning', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const evidenceRef = buildResourceBrief(db, resourceId).evidence[0].id;
    const prompts: string[] = [];
    const semanticPlan: SemanticViewPlan = {
      commandText: 'Make a forest inspiration board',
      views: [{
        name: 'Codex forest inspiration',
        goal: 'Collect forest inspiration resources.',
        inclusionRules: ['Include forest inspiration.'],
        exclusionRules: ['Exclude unrelated resources.'],
        sections: [],
        confidence: 0.91,
        memberships: [{
          targetKind: 'resource',
          targetId: resourceId,
          state: 'strong_include',
          confidence: 0.91,
          reason: 'Codex selected the forest moodboard resource.',
          evidenceRefs: [evidenceRef],
        }],
      }],
      reviewQueues: [],
      explanation: 'Codex planned the conversational view.',
    };
    const provider = queuedJsonProvider([{
      reply: 'I will preview that view.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'action_plan_view_codex',
        kind: 'plan_view',
        approval: 'preview',
        rationale: 'Create a proposed view from the request.',
        commandText: 'Make a forest inspiration board',
        candidateLimit: 50,
      }],
    } satisfies AgentTurnPlan, semanticPlan], prompts);

    const snapshot = await sendConversationMessage(db, {
      threadId: thread.id,
      content: 'Make a forest inspiration board',
    }, { plannerProvider: provider });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Make a forest inspiration board');
    expect(snapshot.actions[0].status).toBe('succeeded');
    const result = snapshot.actions[0].result as { mode?: string; codexTurnSpent?: boolean; viewIds?: string[] };
    expect(result.mode).toBe('codex');
    expect(result.codexTurnSpent).toBe(true);
    expect(result.viewIds).toHaveLength(1);
    const view = db.prepare('SELECT origin FROM views WHERE id = ?').get(result.viewIds?.[0]) as { origin: string };
    expect(view.origin).toBe('codex');
  });

  it('concurrent plan_view execution creates one deterministic view set', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const evidenceRef = buildResourceBrief(db, resourceId).evidence[0].id;
    let calls = 0;
    const provider = queuedJsonProvider([semanticPlanFor(resourceId, evidenceRef, 'Concurrent view')]);
    const originalComplete = provider.complete.bind(provider);
    provider.complete = async (...args) => {
      calls += 1;
      return originalComplete(...args);
    };
    const persisted = persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'I can plan that.',
        questions: [],
        assumptions: [],
        actions: [{
          id: 'action_plan_concurrent',
          kind: 'plan_view',
          approval: 'preview',
          rationale: 'Preview a view.',
          commandText: 'Make a forest inspiration board',
          candidateLimit: 50,
        }],
      },
    });
    const actionId = persisted.actions[0].id;

    await Promise.all([
      runPersistedAgentAction(db, actionId, { plannerProvider: provider }),
      runPersistedAgentAction(db, actionId, { plannerProvider: provider }),
    ]);

    const viewRows = db.prepare('SELECT id FROM views').all() as Array<{ id: string }>;
    expect(calls).toBe(1);
    expect(viewRows).toHaveLength(1);
    expect(viewRows[0].id).toMatch(/^view_agent_0_/);
  });

  it('plan_view replay after persisted views returns identical IDs without calling Codex again', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const evidenceRef = buildResourceBrief(db, resourceId).evidence[0].id;
    const provider = queuedJsonProvider([semanticPlanFor(resourceId, evidenceRef, 'Crash replay view')]);
    const persisted = persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'I can plan that.',
        questions: [],
        assumptions: [],
        actions: [{
          id: 'action_plan_crash_replay',
          kind: 'plan_view',
          approval: 'preview',
          rationale: 'Preview a view.',
          commandText: 'Make a forest inspiration board',
          candidateLimit: 50,
        }],
      },
    });
    const actionId = persisted.actions[0].id;
    const first = await runPersistedAgentAction(db, actionId, { plannerProvider: provider });
    const firstViewIds = (first.result as { viewIds: string[] }).viewIds;
    db.prepare(`
      UPDATE agent_actions
      SET status = 'approved', result_json = NULL, error = NULL, finished_at = NULL,
          execution_token = NULL, execution_started_at = NULL
      WHERE id = ?
    `).run(actionId);
    db.prepare(`
      UPDATE action_effects
      SET status = 'running', result_json = NULL, completed_at = NULL, stale_after = ?
      WHERE action_id = ?
    `).run(new Date(Date.now() - 1000).toISOString(), actionId);
    const throwingProvider: LlmProvider = {
      async complete() {
        throw new Error('Codex should not be called on replay');
      },
    };

    const replayed = await runPersistedAgentAction(db, actionId, { plannerProvider: throwingProvider });
    const replayViewIds = (replayed.result as { viewIds: string[]; replayed: boolean }).viewIds;

    expect(replayViewIds).toEqual(firstViewIds);
    expect((replayed.result as { replayed: boolean }).replayed).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS count FROM views').get() as { count: number }).count).toBe(1);
  });

  it('keeps annotation actions proposed until confirmed', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const provider = queuedProvider([{
      reply: 'I can add that note.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'action_annotation',
        kind: 'add_annotation',
        approval: 'confirm',
        rationale: 'User asked to mark it.',
        resourceId,
        tags: ['inspiration'],
        description: 'Forest level moodboard.',
        decision: 'inspiration',
      }],
    }]);

    const snapshot = await sendConversationMessage(db, { threadId: thread.id, content: 'Mark this as inspiration' }, { plannerProvider: provider });
    const before = db.prepare('SELECT COUNT(*) AS count FROM user_annotations').get() as { count: number };

    expect(snapshot.actions[0].status).toBe('proposed');
    expect(before.count).toBe(0);

    await confirmAgentAction(db, snapshot.actions[0].id);
    const after = db.prepare('SELECT COUNT(*) AS count FROM user_annotations').get() as { count: number };
    expect(after.count).toBe(1);
  });

  it('keeps scan actions proposed until confirmed', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const provider = queuedProvider([{
      reply: 'I can scan this resource.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'action_scan',
        kind: 'scan_resources',
        approval: 'confirm',
        rationale: 'Needs deeper evidence.',
        resourceIds: [resourceId],
        limit: 1,
        force: false,
      }],
    }]);

    const snapshot = await sendConversationMessage(db, { threadId: thread.id, content: 'Scan it' }, { plannerProvider: provider });
    expect((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count).toBe(0);

    await confirmAgentAction(db, snapshot.actions[0].id);
    expect((db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE kind = ?').get('codex_scan') as { count: number }).count).toBe(1);
  });

  it('keeps view acceptance proposed until confirmed', async () => {
    const { db, resourceId } = seed();
    const viewId = createAcceptedCandidateView(db, resourceId);
    const thread = createConversationThread(db);
    const provider = queuedProvider([{
      reply: 'I can accept this view.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'action_accept',
        kind: 'accept_view',
        approval: 'confirm',
        rationale: 'Accept proposed view.',
        viewId,
      }],
    }]);

    const snapshot = await sendConversationMessage(db, { threadId: thread.id, content: 'Accept it' }, { plannerProvider: provider });
    expect((db.prepare('SELECT status FROM views WHERE id = ?').get(viewId) as { status: string }).status).toBe('proposed');

    await confirmAgentAction(db, snapshot.actions[0].id);
    expect((db.prepare('SELECT status FROM views WHERE id = ?').get(viewId) as { status: string }).status).toBe('accepted');
  });

  it('cancelling an action does not execute it', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const persisted = persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'Proposed annotation.',
        questions: [],
        assumptions: [],
        actions: [{
          id: 'action_cancel_annotation',
          kind: 'add_annotation',
          approval: 'confirm',
          rationale: 'Mark resource.',
          resourceId,
          tags: ['inspiration'],
          decision: 'inspiration',
        }],
      },
    });

    const actionId = persisted.actions[0].id;
    cancelAgentAction(db, actionId);
    await confirmAgentAction(db, actionId);

    expect((db.prepare('SELECT COUNT(*) AS count FROM user_annotations').get() as { count: number }).count).toBe(0);
    expect(getConversationSnapshot(db, thread.id).actions[0].status).toBe('cancelled');
  });

  it('confirming an action executes exactly once and replay is idempotent', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const persisted = persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'Proposed annotation.',
        questions: [],
        assumptions: [],
        actions: [{
          id: 'action_once',
          kind: 'add_annotation',
          approval: 'confirm',
          rationale: 'Mark once.',
          resourceId,
          tags: ['inspiration'],
          decision: 'inspiration',
        }],
      },
    });

    const actionId = persisted.actions[0].id;
    await confirmAgentAction(db, actionId);
    await confirmAgentAction(db, actionId);

    expect((db.prepare('SELECT COUNT(*) AS count FROM user_annotations').get() as { count: number }).count).toBe(1);
    expect(getConversationSnapshot(db, thread.id).actions[0].status).toBe('succeeded');
  });

  it('claims confirmed action execution atomically under concurrent confirmation', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const persisted = persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'Proposed annotation.',
        questions: [],
        assumptions: [],
        actions: [{
          id: 'action_concurrent_once',
          kind: 'add_annotation',
          approval: 'confirm',
          rationale: 'Mark once under concurrent confirmation.',
          resourceId,
          tags: ['inspiration'],
          decision: 'inspiration',
        }],
      },
    });

    const actionId = persisted.actions[0].id;
    await Promise.all([
      confirmAgentAction(db, actionId),
      confirmAgentAction(db, actionId),
    ]);

    const annotations = db.prepare('SELECT COUNT(*) AS count FROM user_annotations').get() as { count: number };
    const action = getConversationSnapshot(db, thread.id).actions[0];
    expect(annotations.count).toBe(1);
    expect(action.status).toBe('succeeded');
    expect(action.idempotencyKey).toBe(actionId);
    expect(action.executionToken).toBeTruthy();
  });

  it('replays annotation action side effects by action id after an interrupted status reset', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const persisted = persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'Proposed annotation.',
        questions: [],
        assumptions: [],
        actions: [{
          id: 'action_replay_annotation',
          kind: 'add_annotation',
          approval: 'confirm',
          rationale: 'Mark idempotently.',
          resourceId,
          tags: ['inspiration'],
          decision: 'inspiration',
        }],
      },
    });

    const actionId = persisted.actions[0].id;
    await confirmAgentAction(db, actionId);
    db.prepare(`
      UPDATE agent_actions
      SET status = 'approved', result_json = NULL, error = NULL, finished_at = NULL,
          execution_token = NULL, execution_started_at = NULL
      WHERE id = ?
    `).run(actionId);
    await confirmAgentAction(db, actionId);

    const annotations = db.prepare('SELECT id FROM user_annotations').all() as Array<{ id: string }>;
    const action = getConversationSnapshot(db, thread.id).actions[0];
    expect(annotations).toHaveLength(1);
    expect(annotations[0].id).toBe(idempotentActionObjectIdForTest('ann_agent', actionId));
    expect(action.status).toBe('succeeded');
  });

  it('replays scan action job creation by action id after an interrupted status reset', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const persisted = persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'Proposed scan.',
        questions: [],
        assumptions: [],
        actions: [{
          id: 'action_replay_scan',
          kind: 'scan_resources',
          approval: 'confirm',
          rationale: 'Scan idempotently.',
          resourceIds: [resourceId],
          limit: 1,
          force: false,
        }],
      },
    });

    const actionId = persisted.actions[0].id;
    await confirmAgentAction(db, actionId);
    db.prepare(`
      UPDATE agent_actions
      SET status = 'approved', result_json = NULL, error = NULL, finished_at = NULL,
          execution_token = NULL, execution_started_at = NULL
      WHERE id = ?
    `).run(actionId);
    await confirmAgentAction(db, actionId);

    const jobs = db.prepare('SELECT id FROM jobs WHERE kind = ?').all('codex_scan') as Array<{ id: string }>;
    const action = getConversationSnapshot(db, thread.id).actions[0];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(idempotentActionObjectIdForTest('job_agent', actionId));
    expect(action.status).toBe('succeeded');
  });

  it('rejects unsupported arbitrary action operations', async () => {
    const { db } = seed();
    const thread = createConversationThread(db);
    db.prepare(`
      INSERT INTO agent_actions
        (id, thread_id, action_kind, approval, status, action_json, created_at, updated_at)
      VALUES
        ('action_bad', ?, 'delete_everything', 'confirm', 'proposed', ?, ?, ?)
    `).run(
      thread.id,
      JSON.stringify({ id: 'action_bad', kind: 'delete_everything', approval: 'confirm', rationale: 'Bad.' }),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    await expect(confirmAgentAction(db, 'action_bad')).rejects.toThrow();
  });
});

function idempotentActionObjectIdForTest(prefix: string, actionId: string): string {
  const digest = crypto.createHash('sha256').update(actionId).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}
