import { describe, expect, it } from 'vitest';
import { addUserAnnotation } from '../src/annotations/service.js';
import { runAgentCommand } from '../src/agent/commandService.js';
import { openDatabase } from '../src/db/index.js';
import { runDeterministicExtraction } from '../src/extract/deterministic.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import type { LlmProvider } from '../src/llm/types.js';

function seedCommandFixture() {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-17T00:00:00.000Z',
    tabs: [
      {
        browser: 'chrome',
        title: 'Beautiful watercolor environments',
        url: 'https://www.youtube.com/watch?v=watercolor01',
      },
      {
        browser: 'chrome',
        title: 'Gameplay mechanics breakdown',
        url: 'https://example.com/gameplay-mechanics',
      },
      {
        browser: 'edge',
        title: 'Ambient album',
        url: 'https://example.com/ambient-album',
      },
    ],
  }, 'test');
  runDeterministicExtraction(db);
  const rows = db.prepare('SELECT id, title_best FROM resources ORDER BY title_best').all() as { id: string; title_best: string }[];
  const byTitle = Object.fromEntries(rows.map(row => [row.title_best, row.id]));
  return { db, byTitle };
}

describe('agent command service', () => {
  it('creates a stored proposed view from a natural language command', async () => {
    const { db, byTitle } = seedCommandFixture();
    addUserAnnotation(db, {
      targetKind: 'resource',
      targetId: byTitle['Beautiful watercolor environments'],
      tags: ['inspiration'],
      description: 'Forest level moodboard for game art direction.',
      decision: 'inspiration',
      source: 'focused_review',
    });

    const result = await runAgentCommand(db, 'heuristic', {
      text: 'Make a strict game inspiration group',
    });

    expect(result.commandId).toMatch(/^cmd_/);
    expect(result.viewIds).toHaveLength(1);
    expect(result.summary.strong_include).toBeGreaterThanOrEqual(2);
    expect(result.message).toContain('Preview before accepting');
    const viewCount = db.prepare('SELECT COUNT(*) AS count FROM views').get() as { count: number };
    expect(viewCount.count).toBe(1);
  });

  it('user annotation evidence changes loose inspiration summary', async () => {
    const { db, byTitle } = seedCommandFixture();
    const withoutAnnotation = await runAgentCommand(db, 'heuristic', {
      text: 'Make a loose group mainly game inspiration but welcome all marked inspiration',
      dryRun: true,
    });
    addUserAnnotation(db, {
      targetKind: 'resource',
      targetId: byTitle['Ambient album'],
      tags: ['inspiration', 'music'],
      description: 'Atmosphere reference.',
      decision: 'inspiration',
      source: 'focused_review',
    });
    const withAnnotation = await runAgentCommand(db, 'heuristic', {
      text: 'Make a loose group mainly game inspiration but welcome all marked inspiration',
      dryRun: true,
    });

    expect(withAnnotation.summary.strong_include).toBeGreaterThan(withoutAnnotation.summary.strong_include);
  });

  it('dry-run returns a plan without persisting command or view rows', async () => {
    const { db } = seedCommandFixture();
    const result = await runAgentCommand(db, 'heuristic', {
      text: 'Make a loose inspiration board',
      dryRun: true,
    });

    expect(result.commandId).toBeNull();
    expect(result.viewIds).toEqual([]);
    expect(result.plan.views[0].name).toContain('Loose');
    const commands = db.prepare('SELECT COUNT(*) AS count FROM user_commands').get() as { count: number };
    const views = db.prepare('SELECT COUNT(*) AS count FROM views').get() as { count: number };
    expect(commands.count).toBe(0);
    expect(views.count).toBe(0);
  });

  it('does not call a provider in heuristic mode', async () => {
    const { db } = seedCommandFixture();
    const throwingProvider: LlmProvider = {
      async complete() {
        throw new Error('provider should not be called');
      },
    };

    const result = await runAgentCommand(db, throwingProvider, {
      text: 'Make a loose inspiration board',
      mode: 'heuristic',
      dryRun: true,
    });

    expect(result.codexTurnSpent).toBe(false);
    expect(result.plan.views[0].name).toContain('Loose');
  });

  it('calls a provider in codex mode, persists the view, and logs agent_runs', async () => {
    const { db, byTitle } = seedCommandFixture();
    let calls = 0;
    const provider: LlmProvider = {
      async complete() {
        calls += 1;
        return {
          text: JSON.stringify({
            commandText: 'Make a game inspiration group',
            views: [{
              name: 'Codex game inspiration',
              goal: 'Collect game inspiration resources.',
              inclusionRules: ['Include resources useful for game ideas.'],
              exclusionRules: ['Exclude unrelated resources.'],
              sections: [],
              confidence: 0.9,
              memberships: [{
                targetKind: 'resource',
                targetId: byTitle['Gameplay mechanics breakdown'],
                state: 'strong_include',
                confidence: 0.9,
                reason: 'Codex selected this gameplay mechanics resource.',
                evidenceRefs: ['fixture_ref'],
              }],
            }],
            reviewQueues: [],
            explanation: 'Codex planned the view.',
          }),
          usage: { quotaTurns: 1, inputTokens: 10, outputTokens: 20 },
        };
      },
    };

    const result = await runAgentCommand(db, provider, {
      text: 'Make a game inspiration group',
      mode: 'codex',
    });

    expect(calls).toBe(1);
    expect(result.mode).toBe('codex');
    expect(result.codexTurnSpent).toBe(true);
    expect(result.validationStatus).toBe('passed');
    expect(result.providerLabel).toBe('Object');
    expect(result.viewIds).toHaveLength(1);
    expect(result.summary.strong_include).toBe(1);

    const run = db.prepare('SELECT provider, validation_status, usage_json FROM agent_runs LIMIT 1').get() as {
      provider: string;
      validation_status: string;
      usage_json: string;
    };
    expect(run.provider).toBe('Object');
    expect(run.validation_status).toBe('passed');
    expect(JSON.parse(run.usage_json).quotaTurns).toBe(1);
  });

  it('reasks after invalid codex JSON and then persists the corrected plan', async () => {
    const { db, byTitle } = seedCommandFixture();
    let calls = 0;
    const provider: LlmProvider = {
      async complete() {
        calls += 1;
        if (calls === 1) return { text: 'not json', usage: { quotaTurns: 1 } };
        return {
          text: JSON.stringify({
            commandText: 'Make an art inspiration group',
            views: [{
              name: 'Codex art inspiration',
              goal: 'Collect art inspiration.',
              inclusionRules: ['Include visual resources.'],
              exclusionRules: ['Exclude unrelated resources.'],
              sections: [],
              confidence: 0.8,
              memberships: [{
                targetKind: 'resource',
                targetId: byTitle['Beautiful watercolor environments'],
                state: 'strong_include',
                confidence: 0.88,
                reason: 'Codex selected the watercolor resource as visual inspiration.',
                evidenceRefs: ['fixture_ref'],
              }],
            }],
            reviewQueues: [],
            explanation: 'Corrected JSON after reask.',
          }),
          usage: { quotaTurns: 1 },
        };
      },
    };

    const result = await runAgentCommand(db, provider, {
      text: 'Make an art inspiration group',
      mode: 'codex',
    });

    expect(calls).toBe(2);
    expect(result.validationStatus).toBe('passed');
    expect(result.summary.strong_include).toBe(1);
    const run = db.prepare('SELECT validation_status, usage_json FROM agent_runs LIMIT 1').get() as { validation_status: string; usage_json: string };
    expect(run.validation_status).toBe('passed');
    expect(JSON.parse(run.usage_json).quotaTurns).toBe(2);
  });
});
