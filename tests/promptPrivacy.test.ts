import { describe, expect, it } from 'vitest';
import { addUserAnnotation } from '../src/annotations/service.js';
import { runAgentCommand } from '../src/agent/commandService.js';
import { createConversationThread, sendConversationMessage } from '../src/agent/conversationService.js';
import { runCodexResourceScan, type CodexResourceScanBatchOutput } from '../src/agent/scanService.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import type { LlmProvider } from '../src/llm/types.js';
import { buildResourceBrief } from '../src/resources/briefs.js';
import { redactUrlForPrompt } from '../src/security/urlPrivacy.js';

const SECRET_MARKERS = [
  'SECRET123',
  'api_key=abc',
  'tok_private',
  'supersecretvalue',
  'descriptionsecret',
  'groupsecretvalue',
  'chatsecret',
  'chatbearersecret',
  'commandsecret',
  'user:pass',
  'sk-titleSecret000000000000',
  '#frag',
];

function seedPrivateFixture() {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-18T00:00:00.000Z',
    tabs: [{
      browser: 'chrome',
      title: 'Signed inventory UI reference sk-titleSecret000000000000',
      url: 'https://user:pass@example.com/private/report?X-Amz-Signature=SECRET123&api_key=abc&token=tok_private#frag',
      groupTitle: 'Inventory group Bearer groupsecretvalue',
    }],
  }, 'test');
  const resourceId = (db.prepare('SELECT id FROM resources').get() as { id: string }).id;
  const annotation = addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: resourceId,
    tags: ['project_reference'],
    description: 'inventory UI reference Bearer supersecretvalue api_key=descriptionsecret',
    decision: 'project_reference',
    source: 'focused_review',
  });
  const brief = buildResourceBrief(db, resourceId);
  return { db, resourceId, annotationId: annotation.id!, brief };
}

function expectPromptRedacted(prompt: string): void {
  for (const marker of SECRET_MARKERS) {
    expect(prompt, `prompt leaked ${marker}`).not.toContain(marker);
  }
  expect(prompt).toContain('inventory UI reference');
  expect(prompt).toContain('https://example.com/private/report');
}

describe('Codex prompt privacy', () => {
  it('redacts semantic planner resource briefs and command text before provider calls', async () => {
    const { db, resourceId, annotationId } = seedPrivateFixture();
    let prompt = '';
    const provider: LlmProvider = {
      async complete(input) {
        prompt = input;
        return {
          text: JSON.stringify({
            commandText: 'Group inventory UI reference',
            views: [{
              name: 'Inventory references',
              goal: 'Collect inventory UI reference material.',
              inclusionRules: ['Include inventory UI references.'],
              exclusionRules: [],
              sections: [],
              confidence: 0.82,
              memberships: [{
                targetKind: 'resource',
                targetId: resourceId,
                state: 'strong_include',
                confidence: 0.82,
                reason: 'User annotation marks this as a project reference.',
                evidenceRefs: [`user_annotation:${annotationId}`],
              }],
            }],
            reviewQueues: [],
            explanation: 'Selected from local annotations.',
          }),
          usage: { quotaTurns: 1 },
        };
      },
    };

    await runAgentCommand(db, provider, {
      text: 'Group inventory UI reference https://example.com/private/report?token=commandsecret#frag',
      mode: 'codex',
      dryRun: true,
    });

    expectPromptRedacted(prompt);
  });

  it('redacts scan prompts before provider calls', async () => {
    const { db, resourceId, brief } = seedPrivateFixture();
    const evidenceRef = brief.evidence.find(evidence => evidence.kind === 'url')?.id ?? brief.evidence[0].id;
    let prompt = '';
    const analysis: CodexResourceScanBatchOutput['resources'][number] = {
      resourceId,
      summary: 'Inventory UI project reference.',
      contentKind: 'article',
      userPurposeGuess: 'project_reference',
      topics: ['inventory UI'],
      suggestedTags: ['project_reference'],
      confidence: 0.72,
      evidenceRefs: [evidenceRef],
      missingEvidence: [],
      reviewReason: '',
      atomicItems: [],
    };
    const provider: LlmProvider = {
      async complete(input) {
        prompt = input;
        return { text: JSON.stringify({ resources: [analysis] }), usage: { quotaTurns: 1 } };
      },
    };

    await runCodexResourceScan(db, provider, { resourceIds: [resourceId], force: true, limit: 1 });

    expectPromptRedacted(prompt);
  });

  it('redacts conversation history and retrieved context before provider calls', async () => {
    const { db } = seedPrivateFixture();
    const thread = createConversationThread(db, 'Private prompt test');
    let prompt = '';
    const provider: LlmProvider = {
      async complete(input) {
        prompt = input;
        return {
          text: JSON.stringify({ reply: 'I can use the local context.', actions: [], questions: [], assumptions: [] }),
          usage: { quotaTurns: 1 },
        };
      },
    };

    await sendConversationMessage(db, {
      threadId: thread.id,
      content: 'inventory UI reference https://example.com/private/report?token=chatsecret#frag Bearer chatbearersecret',
    }, { plannerProvider: provider });

    expectPromptRedacted(prompt);
  });

  it('keeps YouTube video IDs while dropping private parameters', () => {
    const redacted = redactUrlForPrompt('https://www.youtube.com/watch?v=abc123def45&si=SECRET123#frag');
    expect(redacted).toContain('v=abc123def45');
    expect(redacted).not.toContain('si=');
    expect(redacted).not.toContain('SECRET123');
    expect(redacted).not.toContain('#frag');
  });
});
