import { expect, it } from 'vitest';
import { StubProvider } from '../src/llm/StubProvider.js';
import { categorizeBatch } from '../src/ai/categorizeBatch.js';

it('categorizes a batch with stub provider', async () => {
  const provider = new StubProvider({
    resourceAnalyses: [{ resourceId: 'res_1', summary: 'Codex docs', contentKind: 'docs', confidence: 0.9, evidenceRefs: ['ev_1'], atomicItems: [] }],
    proposedTags: [{ name: 'Codex', description: 'OpenAI local coding agent material', confidence: 0.9 }],
    proposedViews: [{ name: 'Codex and coding agents', description: 'Resources about Codex and coding agents', rationale: 'Evidence mentions Codex', confidence: 0.9 }],
    memberships: [{ resourceId: 'res_1', viewName: 'Codex and coding agents', confidence: 0.9, reason: 'Title mentions Codex', evidenceRefs: ['ev_1'] }],
    lowConfidence: []
  });

  const result = await categorizeBatch(provider, [{
    resourceId: 'res_1',
    canonicalUrl: 'https://developers.openai.com/codex/cli',
    urlKind: 'docs',
    host: 'developers.openai.com',
    title: 'Codex CLI',
    browserGroupTitles: ['Research'],
    evidence: [{ id: 'ev_1', kind: 'title', text: 'Codex CLI', provenance: 'extension_snapshot', confidence: 0.8 }]
  }]);

  expect(result.value.proposedViews[0].name).toContain('Codex');
});
