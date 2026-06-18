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

    await confirmAgentAction(db, 'action_annotation');
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

    await sendConversationMessage(db, { threadId: thread.id, content: 'Scan it' }, { plannerProvider: provider });
    expect((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count).toBe(0);

    await confirmAgentAction(db, 'action_scan');
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

    await sendConversationMessage(db, { threadId: thread.id, content: 'Accept it' }, { plannerProvider: provider });
    expect((db.prepare('SELECT status FROM views WHERE id = ?').get(viewId) as { status: string }).status).toBe('proposed');

    await confirmAgentAction(db, 'action_accept');
    expect((db.prepare('SELECT status FROM views WHERE id = ?').get(viewId) as { status: string }).status).toBe('accepted');
  });

  it('cancelling an action does not execute it', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    persistAgentTurnPlan(db, {
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

    cancelAgentAction(db, 'action_cancel_annotation');
    await confirmAgentAction(db, 'action_cancel_annotation');

    expect((db.prepare('SELECT COUNT(*) AS count FROM user_annotations').get() as { count: number }).count).toBe(0);
    expect(getConversationSnapshot(db, thread.id).actions[0].status).toBe('cancelled');
  });

  it('confirming an action executes exactly once and replay is idempotent', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    persistAgentTurnPlan(db, {
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

    await confirmAgentAction(db, 'action_once');
    await confirmAgentAction(db, 'action_once');

    expect((db.prepare('SELECT COUNT(*) AS count FROM user_annotations').get() as { count: number }).count).toBe(1);
    expect(getConversationSnapshot(db, thread.id).actions[0].status).toBe('succeeded');
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
