import { describe, expect, it } from 'vitest';
import { repairSemanticViewPlanCandidate } from '../src/ai/semanticViewPlanRepair.js';
import { SemanticViewPlan } from '../src/shared/schemas.js';

describe('semantic view plan repair', () => {
  it('normalizes common real-provider schema near-misses before validation', () => {
    const repaired = repairSemanticViewPlanCandidate('Make a focused game UI inspiration view.', {
      views: [{
        viewId: 'game-ui',
        title: 'Game UI inspiration',
        description: 'Collect inventory interface examples.',
        inclusionRules: ['Include inventory interface examples.'],
        exclusionRules: ['Exclude unrelated art.'],
        sections: [{ sectionId: 'inventory', title: 'Inventory UI' }],
        confidence: '0.82',
        memberships: [{
          resourceId: 'res_inventory',
          section: { title: 'Inventory UI' },
          state: 'included',
          confidence: '0.9',
          reason: 'Annotated as inventory UI inspiration.',
          evidenceIds: ['user_annotation:res_inventory'],
        }, {
          resourceId: 'res_art',
          section: null,
          state: 'exclude',
          confidence: 0.7,
          reason: 'Art-only page is unrelated.',
          evidenceIds: [],
        }],
      }],
      reviewQueue: [{
        name: 'ambiguous',
        question: 'Review uncertain items.',
        resourceIds: ['res_art'],
      }],
    });

    const parsed = SemanticViewPlan.parse(repaired);
    expect(parsed.commandText).toBe('Make a focused game UI inspiration view.');
    expect(parsed.explanation).toContain('supplied evidence');
    expect(parsed.views[0].name).toBe('Game UI inspiration');
    expect(parsed.views[0].sections).toEqual(['Inventory UI']);
    expect(parsed.views[0].memberships[0]).toMatchObject({
      targetKind: 'resource',
      targetId: 'res_inventory',
      section: 'Inventory UI',
      state: 'strong_include',
      evidenceRefs: ['user_annotation:res_inventory'],
    });
    expect(parsed.views[0].memberships[1].section).toBeUndefined();
    expect(parsed.reviewQueues[0]).toMatchObject({
      queueName: 'ambiguous',
      targetIds: ['res_art'],
    });
  });
});
