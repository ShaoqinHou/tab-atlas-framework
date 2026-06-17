import { expect, it } from 'vitest';
import { StubProvider } from '../src/llm/StubProvider.js';
import { planSemanticView } from '../src/ai/planSemanticView.js';

it('plans a semantic view where a user note outranks a misleading title', async () => {
  const provider = new StubProvider({
    commandText: 'Make a game inspiration board',
    views: [{
      name: 'Game inspiration',
      goal: 'Collect resources useful for game ideas, mechanics, UI, and art direction.',
      description: 'Includes non-game-looking resources when the user marked why they matter for a game.',
      inclusionRules: ['Include user-marked game/inspiration resources.', 'Include art/design resources only when user note connects them to game ideas.'],
      exclusionRules: ['Exclude pure art with no user game/inspiration clue.'],
      sections: ['Game-centered inspiration'],
      sortPolicy: 'user-marked first, then confidence',
      confidence: 0.93,
      memberships: [{
        targetKind: 'resource',
        targetId: 'res_watercolor',
        section: 'Game-centered inspiration',
        state: 'strong_include',
        confidence: 0.94,
        reason: 'The user note says this is a moodboard for forest level art direction.',
        evidenceRefs: ['user_annotation:ann_1']
      }]
    }],
    reviewQueues: [],
    explanation: 'The user annotation provides stronger evidence than the generic watercolor title.'
  });

  const result = await planSemanticView(provider, 'Make a game inspiration board', [{
    resourceId: 'res_watercolor',
    canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
    redactedUrl: 'https://www.youtube.com/watch?v=abc123def45',
    urlKind: 'youtube_video',
    host: 'youtube.com',
    title: 'Beautiful watercolor environments',
    browserGroupTitles: [],
    userAnnotations: [{
      id: 'ann_1',
      targetKind: 'resource',
      targetId: 'res_watercolor',
      tags: ['game', 'inspiration', 'art'],
      description: 'Use as moodboard for forest level art direction.',
      decision: 'inspiration',
      source: 'focused_review',
      createdAt: '2026-06-17T00:00:00.000Z'
    }],
    systemTags: ['youtube', 'video'],
    atomicItems: [],
    extractionStatus: 'metadata_only',
    evidence: [{ id: 'ev_title', kind: 'title', text: 'Beautiful watercolor environments', provenance: 'extension_snapshot', confidence: 0.4 }]
  }]);

  expect(result.value.views[0].memberships[0].state).toBe('strong_include');
  expect(result.value.views[0].memberships[0].evidenceRefs).toContain('user_annotation:ann_1');
});
