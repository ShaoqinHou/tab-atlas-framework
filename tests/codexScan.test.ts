import { describe, expect, it } from 'vitest';
import { addUserAnnotation } from '../src/annotations/service.js';
import {
  createCodexScanJob,
  resumeCodexScanJob,
  runCodexResourceScan,
  CODEX_RESOURCE_ANALYSIS_RECIPE,
  type CodexResourceScanBatchOutput,
} from '../src/agent/scanService.js';
import { searchResources } from '../src/agent/tools.js';
import { planSemanticView } from '../src/ai/planSemanticView.js';
import { openDatabase } from '../src/db/index.js';
import { runDeterministicExtraction } from '../src/extract/deterministic.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import type { LlmProvider } from '../src/llm/types.js';
import { buildResourceBrief, buildResourceBriefs } from '../src/resources/briefs.js';

function seedScanFixture() {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-17T00:00:00.000Z',
    tabs: [
      {
        browser: 'chrome',
        title: 'Fantasy equipment breakdown',
        url: 'https://example.com/fantasy-equipment',
      },
      {
        browser: 'chrome',
        title: 'Release checklist',
        url: 'https://example.com/release-checklist',
      },
    ],
  }, 'test');
  runDeterministicExtraction(db);
  const rows = db.prepare('SELECT id, title_best FROM resources ORDER BY title_best').all() as { id: string; title_best: string }[];
  const byTitle = Object.fromEntries(rows.map(row => [row.title_best, row.id]));
  return { db, byTitle };
}

describe('Codex resource scan', () => {
  it('writes codex_resource_analysis artifacts that resource search can use', async () => {
    const { db, byTitle } = seedScanFixture();
    const resourceId = byTitle['Fantasy equipment breakdown'];
    const evidenceRef = buildResourceBrief(db, resourceId).evidence[0].id;
    const provider = scanProvider({
      [resourceId]: {
        resourceId,
        summary: 'Game inventory UI inspiration from equipment selection patterns.',
        contentKind: 'article',
        userPurposeGuess: 'inspiration',
        topics: ['inventory UI', 'game UI inspiration'],
        suggestedTags: ['game', 'ui', 'inspiration'],
        confidence: 0.86,
        evidenceRefs: [evidenceRef],
        missingEvidence: [],
        reviewReason: '',
        atomicItems: [],
      },
    });

    const result = await runCodexResourceScan(db, provider, {
      resourceIds: [resourceId],
      limit: 1,
      batchSize: 1,
      force: true,
    });

    expect(result.artifactsWritten).toBe(1);
    const artifact = db.prepare(`
      SELECT text_excerpt, json_payload
      FROM extraction_artifacts
      WHERE resource_id = ? AND recipe_id = ?
    `).get(resourceId, CODEX_RESOURCE_ANALYSIS_RECIPE) as { text_excerpt: string; json_payload: string };
    expect(artifact.text_excerpt).toContain('inventory UI');
    expect(JSON.parse(artifact.json_payload).suggestedTags).toContain('ui');

    const search = searchResources(db, {
      query: 'game UI inspiration',
      filters: { annotationStatus: 'any', limit: 10 },
    });
    expect(search.matches[0].resourceId).toBe(resourceId);
    expect(search.matches[0].reasons).toContain('extracted evidence matches "ui"');
  });

  it('stores justified atomic items and passes them into semantic view planning', async () => {
    const { db, byTitle } = seedScanFixture();
    const resourceId = byTitle['Fantasy equipment breakdown'];
    const evidenceRef = buildResourceBrief(db, resourceId).evidence[0].id;
    const provider = scanProvider({
      [resourceId]: {
        resourceId,
        summary: 'Dense video with several reusable ideas.',
        contentKind: 'youtube_video',
        userPurposeGuess: 'reference',
        topics: ['AI papers', 'reading list'],
        suggestedTags: ['papers', 'reference'],
        confidence: 0.81,
        evidenceRefs: [evidenceRef],
        missingEvidence: [],
        reviewReason: '',
        atomicItems: [{
          itemKind: 'paper',
          name: 'Graph Transformer Paper',
          summary: 'A paper mentioned by title that should be tracked separately.',
          evidenceRefs: [evidenceRef],
          confidence: 0.74,
        }],
      },
    });

    await runCodexResourceScan(db, provider, {
      resourceIds: [resourceId],
      limit: 1,
      batchSize: 1,
      force: true,
    });

    const brief = buildResourceBrief(db, resourceId);
    expect(brief.atomicItems).toHaveLength(1);
    expect(brief.atomicItems[0].name).toBe('Graph Transformer Paper');

    let plannerPrompt = '';
    const plannerProvider: LlmProvider = {
      async complete(prompt) {
        plannerPrompt = prompt;
        return {
          text: JSON.stringify({
            commandText: 'AI papers to read',
            views: [{
              name: 'AI papers',
              goal: 'Collect individual papers to read.',
              inclusionRules: ['Include atomic paper items.'],
              exclusionRules: [],
              sections: [],
              confidence: 0.9,
              memberships: [{
                targetKind: 'atomic_item',
                targetId: brief.atomicItems[0].itemId,
                state: 'strong_include',
                confidence: 0.86,
                reason: 'The atomic item is a paper to read.',
                evidenceRefs: [evidenceRef],
              }],
            }],
            reviewQueues: [],
            explanation: 'Selected the atomic item instead of only the parent resource.',
          }),
          usage: { quotaTurns: 1 },
        };
      },
    };

    const plan = await planSemanticView(plannerProvider, 'AI papers to read', [brief]);
    expect(plannerPrompt).toContain('Graph Transformer Paper');
    expect(plan.value.views[0].memberships[0].targetKind).toBe('atomic_item');
  });

  it('keeps user annotations higher priority than conflicting Codex suggested tags', async () => {
    const { db, byTitle } = seedScanFixture();
    const annotatedId = byTitle['Fantasy equipment breakdown'];
    const scannedOnlyId = byTitle['Release checklist'];
    addUserAnnotation(db, {
      targetKind: 'resource',
      targetId: annotatedId,
      tags: ['project_reference'],
      description: 'Use this as the tab-manager project reference even if it looks generic.',
      decision: 'project_reference',
      source: 'focused_review',
    });
    const briefs = buildResourceBriefs(db, [annotatedId, scannedOnlyId]);
    const evidenceById = Object.fromEntries(briefs.map(brief => [brief.resourceId, brief.evidence[0].id]));
    const provider = scanProvider({
      [annotatedId]: {
        resourceId: annotatedId,
        summary: 'Codex would otherwise treat this as an ignore candidate.',
        contentKind: 'article',
        userPurposeGuess: 'ignore_candidate',
        topics: ['generic equipment'],
        suggestedTags: ['ignore'],
        confidence: 0.7,
        evidenceRefs: [evidenceById[annotatedId]],
        missingEvidence: [],
        reviewReason: '',
        atomicItems: [],
      },
      [scannedOnlyId]: {
        resourceId: scannedOnlyId,
        summary: 'Release workflow project reference.',
        contentKind: 'docs',
        userPurposeGuess: 'project_reference',
        topics: ['project_reference'],
        suggestedTags: ['project_reference'],
        confidence: 0.7,
        evidenceRefs: [evidenceById[scannedOnlyId]],
        missingEvidence: [],
        reviewReason: '',
        atomicItems: [],
      },
    });

    await runCodexResourceScan(db, provider, {
      resourceIds: [annotatedId, scannedOnlyId],
      limit: 2,
      batchSize: 2,
      force: true,
    });

    const search = searchResources(db, {
      query: 'project_reference',
      filters: { annotationStatus: 'any', limit: 10 },
    });
    expect(search.matches[0].resourceId).toBe(annotatedId);
    expect(search.matches[0].reasons).toContain('user annotation matches "project_reference"');
  });

  it('uses dependency hashes so unchanged extraction does not rescan but changed notes do', async () => {
    const { db, byTitle } = seedScanFixture();
    const resourceId = byTitle['Fantasy equipment breakdown'];
    const evidenceRef = buildResourceBrief(db, resourceId).evidence[0].id;
    const provider = scanProvider({
      [resourceId]: {
        resourceId,
        summary: 'Reusable game equipment reference.',
        contentKind: 'article',
        userPurposeGuess: 'reference',
        topics: ['equipment'],
        suggestedTags: ['reference'],
        confidence: 0.7,
        evidenceRefs: [evidenceRef],
        missingEvidence: [],
        reviewReason: '',
        atomicItems: [],
      },
    });

    const first = await runCodexResourceScan(db, provider, { resourceIds: [resourceId], limit: 1 });
    expect(first.resourcesScanned).toBe(1);

    runDeterministicExtraction(db, [resourceId]);
    const unchanged = await runCodexResourceScan(db, provider, { resourceIds: [resourceId], limit: 1 });
    expect(unchanged.resourcesScanned).toBe(0);
    expect(unchanged.resourcesSkippedFresh).toBe(1);

    addUserAnnotation(db, {
      targetKind: 'resource',
      targetId: resourceId,
      tags: ['project_reference'],
      description: 'Now treat this as project reference.',
      decision: 'project_reference',
      source: 'focused_review',
    });
    const changed = await runCodexResourceScan(db, provider, { resourceIds: [resourceId], limit: 1 });
    expect(changed.resourcesScanned).toBe(1);
  });

  it('replaces stale Codex atomic items with the current scan generation', async () => {
    const { db, byTitle } = seedScanFixture();
    const resourceId = byTitle['Fantasy equipment breakdown'];
    const evidenceRef = buildResourceBrief(db, resourceId).evidence[0].id;
    const analysis = (names: string[]) => scanProvider({
      [resourceId]: {
        resourceId,
        summary: 'Dense resource with atomic topics.',
        contentKind: 'article',
        userPurposeGuess: 'reference',
        topics: ['dense'],
        suggestedTags: ['reference'],
        confidence: 0.8,
        evidenceRefs: [evidenceRef],
        missingEvidence: [],
        reviewReason: '',
        atomicItems: names.map(name => ({
          itemKind: 'topic',
          name,
          summary: `${name} summary`,
          evidenceRefs: [evidenceRef],
          confidence: 0.7,
        })),
      },
    });

    await runCodexResourceScan(db, analysis(['One', 'Two', 'Three', 'Four']), { resourceIds: [resourceId], limit: 1, force: true });
    expect((db.prepare('SELECT COUNT(*) AS count FROM atomic_items WHERE resource_id = ?').get(resourceId) as { count: number }).count).toBe(4);

    await runCodexResourceScan(db, analysis(['One', 'Four']), { resourceIds: [resourceId], limit: 1, force: true });
    const items = db.prepare('SELECT name FROM atomic_items WHERE resource_id = ? ORDER BY name').all(resourceId) as { name: string }[];
    expect(items.map(item => item.name)).toEqual(['Four', 'One']);
  });

  it('resumes durable scan jobs without repeating completed items', async () => {
    const db = openDatabase(':memory:');
    importSnapshot(db, {
      capturedAt: '2026-06-17T00:00:00.000Z',
      tabs: Array.from({ length: 6 }, (_, index) => ({
        browser: 'chrome',
        title: `Resource ${index + 1}`,
        url: `https://example.com/resource-${index + 1}`,
      })),
    }, 'test');
    runDeterministicExtraction(db);
    let calls = 0;
    const provider = dynamicScanProvider(() => { calls += 1; });
    const created = createCodexScanJob(db, { limit: 6, batchSize: 3 });
    expect(created.resourcesQueued).toBe(6);

    const partial = await resumeCodexScanJob(db, provider, created.job.id, { maxItems: 2 });
    expect(partial.job.progress.succeeded).toBe(2);
    expect(partial.job.progress.pending).toBe(4);

    const resumed = await resumeCodexScanJob(db, provider, created.job.id, { maxItems: 10 });
    expect(resumed.job.status).toBe('succeeded');
    expect(resumed.job.progress.succeeded).toBe(6);
    expect(calls).toBe(6);
  });
});

function scanProvider(byResourceId: Record<string, CodexResourceScanBatchOutput['resources'][number]>): LlmProvider {
  return {
    async complete(prompt) {
      const ids = [...prompt.matchAll(/"resourceId": "([^"]+)"/g)].map(match => match[1]);
      return {
        text: JSON.stringify({
          resources: [...new Set(ids)].map(id => byResourceId[id]).filter(Boolean),
        }),
        usage: { quotaTurns: 1, inputTokens: 50, outputTokens: 100 },
      };
    },
  };
}

function dynamicScanProvider(onCall?: () => void): LlmProvider {
  return {
    async complete(prompt) {
      onCall?.();
      const ids = [...prompt.matchAll(/"resourceId": "([^"]+)"/g)].map(match => match[1]);
      return {
        text: JSON.stringify({
          resources: [...new Set(ids)].map(resourceId => ({
            resourceId,
            summary: `Scanned ${resourceId}.`,
            contentKind: 'unknown',
            userPurposeGuess: 'needs_review',
            topics: [],
            suggestedTags: [],
            confidence: 0.5,
            evidenceRefs: [],
            missingEvidence: ['human review'],
            reviewReason: 'Low-confidence test scan.',
            atomicItems: [],
          })),
        }),
        usage: { quotaTurns: 1 },
      };
    },
  };
}
