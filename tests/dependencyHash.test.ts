import { describe, expect, it } from 'vitest';
import { computeResourceKnowledgeDependencyHash } from '../src/knowledge/dependencyHash.js';
import type { ResourceBrief } from '../src/shared/schemas.js';

function brief(): ResourceBrief {
  return {
    resourceId: 'res_1',
    canonicalUrl: 'https://example.com/article',
    redactedUrl: 'https://example.com/article',
    urlKind: 'web_page',
    host: 'example.com',
    title: 'A useful article',
    browserGroupTitles: ['Research', 'Ideas'],
    userAnnotations: [{
      id: 'ann_1',
      targetKind: 'resource',
      targetId: 'res_1',
      tags: ['Inspiration', 'Game'],
      description: 'Use this for a forest level moodboard.',
      decision: 'inspiration',
      source: 'focused_review',
      createdAt: '2026-06-18T00:00:00.000Z',
    }],
    systemTags: ['web_page'],
    summary: 'A useful article',
    atomicItems: [],
    extractionStatus: 'complete',
    evidence: [{
      id: 'ev_title_1',
      kind: 'title',
      text: 'A useful article',
      provenance: 'extension_snapshot',
      confidence: 0.45,
    }],
  };
}

describe('resource knowledge dependency hash', () => {
  it('is stable across irrelevant list ordering and whitespace', () => {
    const first = brief();
    const second = brief();
    second.browserGroupTitles = ['Ideas', 'Research'];
    second.userAnnotations[0].tags = ['game', 'inspiration'];
    second.userAnnotations[0].description = '  Use this for a forest level   moodboard. ';
    expect(computeResourceKnowledgeDependencyHash(second)).toBe(computeResourceKnowledgeDependencyHash(first));
  });

  it('changes when user-authored meaning changes', () => {
    const first = brief();
    const second = brief();
    second.userAnnotations[0].description = 'Use this only as an architecture reference.';
    expect(computeResourceKnowledgeDependencyHash(second)).not.toBe(computeResourceKnowledgeDependencyHash(first));
  });

  it('does not become stale because its own Codex scan output changed', () => {
    const first = brief();
    const second = brief();
    second.evidence.push({
      id: 'art_res_1_codex_resource_analysis_v1',
      kind: 'codex_resource_analysis',
      text: 'A new Codex summary and suggested tags.',
      provenance: 'codex',
      confidence: 0.9,
    });
    second.atomicItems.push({
      itemId: 'item_1',
      itemKind: 'idea',
      name: 'Derived idea',
      summary: 'Generated during the scan.',
      evidenceRefs: ['ev_title_1'],
      confidence: 0.8,
    });
    expect(computeResourceKnowledgeDependencyHash(second)).toBe(computeResourceKnowledgeDependencyHash(first));
  });
});
