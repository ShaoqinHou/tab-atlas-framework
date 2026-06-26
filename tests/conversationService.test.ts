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
  normalizeConversationActionPlan,
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
    const conversationPrompts: string[] = [];
    const semanticPrompts: string[] = [];
    const conversationProvider = queuedJsonProvider([{
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
    } satisfies AgentTurnPlan], conversationPrompts);
    const semanticProvider = queuedJsonProvider([semanticPlan], semanticPrompts);

    const snapshot = await sendConversationMessage(db, {
      threadId: thread.id,
      content: 'Make a forest inspiration board',
    }, { plannerProvider: conversationProvider, actionPlannerProvider: semanticProvider });

    expect(conversationPrompts).toHaveLength(1);
    expect(semanticPrompts).toHaveLength(1);
    expect(semanticPrompts[0]).toContain('Make a forest inspiration board');
    expect(snapshot.actions[0].status).toBe('succeeded');
    const result = snapshot.actions[0].result as { mode?: string; codexTurnSpent?: boolean; viewIds?: string[] };
    expect(result.mode).toBe('codex');
    expect(result.codexTurnSpent).toBe(true);
    expect(result.viewIds).toHaveLength(1);
    const view = db.prepare('SELECT origin FROM views WHERE id = ?').get(result.viewIds?.[0]) as { origin: string };
    expect(view.origin).toBe('codex');
  });

  it('binds same-turn review actions to the view created immediately before them', async () => {
    const { db, resourceId } = seed();
    const thread = createConversationThread(db);
    const evidenceRef = buildResourceBrief(db, resourceId).evidence[0].id;
    const semanticPlan: SemanticViewPlan = {
      commandText: 'Create watch later review workspace',
      views: [{
        name: 'Watch Later Review',
        goal: 'Review likely later items.',
        inclusionRules: ['Include likely later items.'],
        exclusionRules: [],
        sections: ['needs review'],
        confidence: 0.8,
        memberships: [{
          targetKind: 'resource',
          targetId: resourceId,
          state: 'needs_review',
          section: 'needs review',
          confidence: 0.5,
          reason: 'Needs focused review.',
          evidenceRefs: [evidenceRef],
        }],
      }],
      reviewQueues: [],
      explanation: 'Fixture plan.',
    };
    const conversationProvider = queuedJsonProvider([{
      reply: 'I will create the view and open review.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'action_plan_later',
        kind: 'plan_view',
        approval: 'preview',
        rationale: 'Create a later-review view.',
        commandText: 'Create watch later review workspace',
        candidateLimit: 50,
      }, {
        id: 'action_start_later_review',
        kind: 'start_review',
        approval: 'automatic',
        rationale: 'Open the needs-review lane for the created view.',
        queue: 'needs_review',
      }],
    } satisfies AgentTurnPlan]);
    const semanticProvider = queuedJsonProvider([semanticPlan]);

    const snapshot = await sendConversationMessage(db, {
      threadId: thread.id,
      content: 'Create watch later review workspace and open review.',
    }, { plannerProvider: conversationProvider, actionPlannerProvider: semanticProvider });
    const planAction = snapshot.actions.find(action => action.kind === 'plan_view');
    const reviewAction = snapshot.actions.find(action => action.kind === 'start_review');
    const viewId = (planAction?.result as { viewIds: string[] }).viewIds[0];
    const review = reviewAction?.result as { session: { sourceViewId?: string; totalItems: number }; current?: unknown };

    expect(reviewAction?.status).toBe('succeeded');
    expect(review.session.sourceViewId).toBe(viewId);
    expect(review.session.totalItems).toBe(1);
    expect(review.current).toBeTruthy();
  });

  it('persists obvious presentation-only commands without calling semantic planning', async () => {
    const { db, resourceId } = seed();
    const viewId = createAcceptedCandidateView(db, resourceId);
    const thread = createConversationThread(db);
    const provider: LlmProvider = {
      async complete() {
        throw new Error('Presentation-only command should not call Codex');
      },
    };

    const snapshot = await sendConversationMessage(db, {
      threadId: thread.id,
      content: 'Switch to gallery',
      activeViewId: viewId,
    }, { plannerProvider: provider });
    const assistant = snapshot.messages.find(message => message.role === 'assistant');
    const context = assistant?.context as { presentationPlan?: { actions: Array<{ kind: string; layout?: string }> } } | undefined;

    expect(snapshot.messages.map(message => message.content)).toContain('Switch to gallery');
    expect(context?.presentationPlan?.actions).toContainEqual({ kind: 'set_layout', layout: 'gallery' });
    expect(snapshot.actions).toHaveLength(0);
  });

  it('does not treat mixed semantic requests as presentation-only', async () => {
    const { db, resourceId } = seed();
    const viewId = createAcceptedCandidateView(db, resourceId);
    const thread = createConversationThread(db);
    const prompts: string[] = [];
    const provider = queuedProvider([noActionPlan('I will plan the new view.')], prompts);

    await sendConversationMessage(db, {
      threadId: thread.id,
      content: 'Create a new taxonomy and show it as a gallery',
      activeViewId: viewId,
    }, { plannerProvider: provider });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Create a new taxonomy and show it as a gallery');
  });

  it('composes gallery presentation and active-view refinement in one turn', async () => {
    const { db, resourceId } = seed();
    const viewId = createAcceptedCandidateView(db, resourceId);
    const thread = createConversationThread(db);
    const evidenceRef = buildResourceBrief(db, resourceId).evidence[0].id;
    const conversationProvider = queuedProvider([{
      reply: 'I will keep the gallery and refine the view.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'action_refine_exclude_tutorials',
        kind: 'refine_view',
        approval: 'preview',
        rationale: 'Exclude pure tutorials from the active view.',
        viewId,
        instruction: 'Exclude pure tutorials.',
      }],
    }]);
    const semanticProvider = queuedJsonProvider([semanticPlanFor(resourceId, evidenceRef, 'Refined inspiration')]);

    const snapshot = await sendConversationMessage(db, {
      threadId: thread.id,
      content: 'Switch to gallery and exclude pure tutorials.',
      activeViewId: viewId,
      currentLayout: 'board',
      currentFilters: { states: 'visible' },
    }, { plannerProvider: conversationProvider, actionPlannerProvider: semanticProvider });
    const assistant = [...snapshot.messages].reverse().find(message => message.role === 'assistant');
    const context = assistant?.context as { presentationPlan?: { actions: Array<{ kind: string; layout?: string }> } } | undefined;

    expect(context?.presentationPlan?.actions).toContainEqual({ kind: 'set_layout', layout: 'gallery' });
    expect(snapshot.actions[0]).toMatchObject({ kind: 'refine_view', status: 'succeeded' });
  });

  it('normalizes new workspace requests to plan_view even with an active view', () => {
    const plan = normalizeConversationActionPlan({
      reply: 'I will build that workspace.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'model_refine_wrongly',
        kind: 'refine_view',
        approval: 'preview',
        rationale: 'The model tried to reuse the active view.',
        viewId: 'view_active',
        instruction: 'Build a TabAtlas project board with sections.',
      }],
    }, 'Build a TabAtlas project board with sections.', 'view_active');

    expect(plan.actions[0]).toMatchObject({
      kind: 'plan_view',
      approval: 'preview',
      commandText: 'Build a TabAtlas project board with sections.',
    });
  });

  it('keeps explicit active-view refinement as refine_view', () => {
    const plan = normalizeConversationActionPlan({
      reply: 'I will refine this view.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'model_refine_active',
        kind: 'refine_view',
        approval: 'preview',
        rationale: 'The user asked for a refinement.',
        viewId: 'view_active',
        instruction: 'Make this view stricter.',
      }],
    }, 'Make this view stricter.', 'view_active');

    expect(plan.actions[0]).toMatchObject({
      kind: 'refine_view',
      viewId: 'view_active',
    });
  });

  it('fills empty scan actions from relevant video context and keeps them bounded', () => {
    const plan = normalizeConversationActionPlan({
      reply: 'I can improve evidence for those videos.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'model_scan_empty',
        kind: 'scan_resources',
        approval: 'confirm',
        rationale: 'Scan the relevant videos only.',
        resourceIds: [],
        limit: 100,
        force: false,
      }],
    }, 'What do we know inside these videos?', undefined, {
      resources: [
        { id: 'res_video_one', title: 'Useful walkthrough - YouTube', urlKind: 'youtube_video', host: 'www.youtube.com' },
        { id: 'res_article', title: 'Related article', urlKind: 'web_page', host: 'example.com' },
        { id: 'res_video_two', title: 'Transcript candidate', urlKind: 'web_page', host: 'video.example.com' },
      ],
    });

    expect(plan.actions[0]).toMatchObject({
      kind: 'scan_resources',
      resourceIds: ['res_video_one', 'res_video_two'],
      limit: 2,
    });
  });

  it('removes stale review source when a turn creates a new view first', () => {
    const plan = normalizeConversationActionPlan({
      reply: 'I will create a later-review view and open review.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'model_plan_later',
        kind: 'plan_view',
        approval: 'preview',
        rationale: 'Create a new later-review workspace.',
        commandText: 'Create watch later review workspace.',
        candidateLimit: 50,
      }, {
        id: 'model_review_later',
        kind: 'start_review',
        approval: 'automatic',
        rationale: 'Open review after creating the new workspace.',
        queue: 'unmarked',
        sourceViewId: 'view_active',
      }],
    }, 'Find opened-later tabs and open a review lane for them.', 'view_active');

    expect(plan.actions[1]).toMatchObject({ kind: 'start_review', queue: 'unmarked' });
    expect(plan.actions[1]).not.toHaveProperty('sourceViewId');
  });

  it('removes placeholder review source IDs before execution', () => {
    const plan = normalizeConversationActionPlan({
      reply: 'I will plan and review.',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'model_review_placeholder',
        kind: 'start_review',
        approval: 'automatic',
        rationale: 'Review the future planned view.',
        queue: 'unmarked',
        sourceViewId: 'pending:planned_view',
      }],
    }, 'Open a review lane for the planned view.');

    expect(plan.actions[0]).toMatchObject({ kind: 'start_review', queue: 'unmarked' });
    expect(plan.actions[0]).not.toHaveProperty('sourceViewId');
  });

  it('supplies active-view context to semantic conversation planning', async () => {
    const { db, resourceId } = seed();
    const viewId = createAcceptedCandidateView(db, resourceId);
    const thread = createConversationThread(db);
    const prompts: string[] = [];
    const provider = queuedProvider([noActionPlan('I will make it stricter.')], prompts);

    await sendConversationMessage(db, {
      threadId: thread.id,
      content: 'Keep this layout but make the view stricter.',
      activeViewId: viewId,
      currentLayout: 'gallery',
      currentFilters: { states: 'weak_include' },
    }, { plannerProvider: provider });

    expect(prompts[0]).toContain('"activeViewId": "' + viewId + '"');
    expect(prompts[0]).toContain('"currentLayout": "gallery"');
    expect(prompts[0]).toContain('"latestRevisionId"');
    expect(prompts[0]).toContain('"membershipCounts"');
  });

  it('presentation review commands carry the active source view', async () => {
    const { db, resourceId } = seed();
    const viewId = createAcceptedCandidateView(db, resourceId);
    db.prepare(`
      UPDATE memberships
      SET state = 'needs_review'
      WHERE view_id = ?
    `).run(viewId);
    const thread = createConversationThread(db);
    const provider: LlmProvider = {
      async complete() {
        throw new Error('Review presentation command should not require semantic planning');
      },
    };

    const snapshot = await sendConversationMessage(db, {
      threadId: thread.id,
      content: 'Review the uncertain items in this view.',
      activeViewId: viewId,
    }, { plannerProvider: provider });
    const assistant = snapshot.messages.find(message => message.role === 'assistant');
    const context = assistant?.context as { presentationPlan?: { actions: Array<{ kind: string; sourceViewId?: string }> } } | undefined;

    expect(context?.presentationPlan?.actions).toContainEqual({
      kind: 'open_review',
      queue: 'needs_review',
      sourceViewId: viewId,
    });
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

  it('ignores nonexistent review source views at execution time', async () => {
    const { db } = seed();
    const thread = createConversationThread(db);
    const persisted = persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'Open review.',
        questions: [],
        assumptions: [],
        actions: [{
          id: 'action_review_invalid_source',
          kind: 'start_review',
          approval: 'automatic',
          rationale: 'Open review without trusting an invalid source.',
          queue: 'unmarked',
          sourceViewId: 'view_missing',
        }],
      },
    });

    const action = await runPersistedAgentAction(db, persisted.actions[0].id);
    const session = action.result as { session: { sourceViewId?: string } };

    expect(action.status).toBe('succeeded');
    expect(session.session.sourceViewId).toBeUndefined();
  });

  it('rejects empty scan actions instead of creating a whole-library scan', async () => {
    const { db } = seed();
    const thread = createConversationThread(db);
    const persisted = persistAgentTurnPlan(db, {
      threadId: thread.id,
      plan: {
        reply: 'Proposed unsafe scan.',
        questions: [],
        assumptions: [],
        actions: [{
          id: 'action_empty_scan',
          kind: 'scan_resources',
          approval: 'confirm',
          rationale: 'Missing explicit resource IDs.',
          resourceIds: [],
          limit: 100,
          force: false,
        }],
      },
    });

    const action = await confirmAgentAction(db, persisted.actions[0].id);
    const jobs = db.prepare('SELECT id FROM jobs WHERE kind = ?').all('codex_scan') as Array<{ id: string }>;

    expect(action.status).toBe('failed');
    expect(action.error).toContain('requires explicit resourceIds');
    expect(jobs).toHaveLength(0);
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
