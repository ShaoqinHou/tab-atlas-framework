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
});
