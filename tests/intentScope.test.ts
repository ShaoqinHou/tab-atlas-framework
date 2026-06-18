import { describe, expect, it } from 'vitest';
import { buildFeedbackIntentScope, matchFeedbackScope } from '../src/preferences/intentScope.js';

describe('intent-scoped feedback', () => {
  it('applies feedback to a semantically similar future command', () => {
    const scope = buildFeedbackIntentScope({
      sourceCommandText: 'Make a strict game UI inspiration board',
      sourceGoal: 'Collect inventory and interface design ideas for games',
      sourceRules: ['Include game interface examples', 'Exclude generic coding tutorials'],
    });
    const match = matchFeedbackScope(scope, {
      commandText: 'Show my best game interface and inventory UI inspiration',
    });
    expect(match.applies).toBe(true);
    expect(match.score).toBeGreaterThan(0.3);
  });

  it('does not turn a purpose-specific rejection into a universal category', () => {
    const scope = buildFeedbackIntentScope({
      sourceCommandText: 'Collect painting tutorials I should follow step by step',
      sourceGoal: 'Practical painting lessons',
      sourceRules: ['Exclude videos that are only visual moodboards'],
    });
    const match = matchFeedbackScope(scope, {
      commandText: 'Make a game level art-direction inspiration moodboard',
    });
    expect(match.applies).toBe(false);
  });

  it('supports explicit global and same-view scopes', () => {
    const globalScope = buildFeedbackIntentScope({ mode: 'global' });
    expect(matchFeedbackScope(globalScope, { commandText: 'anything' }).applies).toBe(true);

    const viewScope = buildFeedbackIntentScope({ mode: 'view_revision', sourceViewId: 'view_1' });
    expect(matchFeedbackScope(viewScope, { commandText: 'anything', viewId: 'view_1' }).applies).toBe(true);
    expect(matchFeedbackScope(viewScope, { commandText: 'anything', viewId: 'view_2' }).applies).toBe(false);
  });
});
