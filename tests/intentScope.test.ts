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

  it('keeps project-board corrections out of separate painting-tutorial views', () => {
    const scope = buildFeedbackIntentScope({
      sourceCommandText: 'Plan a new board-style view named TabAtlas Project Board with sections extension, receiver, Codex, storage, extraction, transcripts, security, UX, installation, packaging, and testing.',
      sourceGoal: 'Organize supplied TabAtlas project resources into a board-style view by implementation area while preserving user annotations, review cautions, and conflicts.',
      sourceRules: [
        'Include localhost edge resources whose titles match requested TabAtlas implementation sections.',
        'Do not claim video transcript content when the brief only says transcript not attempted.',
        'Do not create unsupported empty sections merely because they were requested.',
      ],
    });

    const match = matchFeedbackScope(scope, {
      commandText: 'Plan a separate view named Practical Painting Tutorials for painting-learning resources, keeping it separate from the TabAtlas Project Board.',
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
