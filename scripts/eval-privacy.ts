import { addUserAnnotation } from '../src/annotations/service.js';
import { runAgentCommand } from '../src/agent/commandService.js';
import { createConversationThread, sendConversationMessage } from '../src/agent/conversationService.js';
import { runCodexResourceScan, type CodexResourceScanBatchOutput } from '../src/agent/scanService.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import type { LlmProvider } from '../src/llm/types.js';
import { buildResourceBrief } from '../src/resources/briefs.js';
import { redactUrlForPrompt } from '../src/security/urlPrivacy.js';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

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

const results: EvalResult[] = [];
results.push(await semanticPlannerPromptIsRedacted());
results.push(await scanPromptIsRedacted());
results.push(await conversationPromptIsRedacted());
results.push(youtubeVideoIdIsPreservedWithoutPrivateParams());

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Privacy evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Privacy evaluation passed: ${results.length}/${results.length} cases.`);

async function semanticPlannerPromptIsRedacted(): Promise<EvalResult> {
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
  return promptResult('Semantic planner prompt redaction', prompt);
}

async function scanPromptIsRedacted(): Promise<EvalResult> {
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
  return promptResult('Resource scan prompt redaction', prompt);
}

async function conversationPromptIsRedacted(): Promise<EvalResult> {
  const { db } = seedPrivateFixture();
  const thread = createConversationThread(db, 'Privacy eval');
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
  return promptResult('Conversation prompt redaction', prompt);
}

function youtubeVideoIdIsPreservedWithoutPrivateParams(): EvalResult {
  const redacted = redactUrlForPrompt('https://www.youtube.com/watch?v=abc123def45&si=SECRET123#frag');
  return result(
    'YouTube URL prompt projection',
    'video id remains; private params and fragments are removed',
    redacted,
    redacted.includes('v=abc123def45') && !redacted.includes('si=') && !redacted.includes('SECRET123') && !redacted.includes('#frag'),
  );
}

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
  }, 'privacy_eval');
  const resourceId = (db.prepare('SELECT id FROM resources').get() as { id: string }).id;
  const annotation = addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: resourceId,
    tags: ['project_reference'],
    description: 'inventory UI reference Bearer supersecretvalue api_key=descriptionsecret',
    decision: 'project_reference',
    source: 'focused_review',
  });
  return { db, resourceId, annotationId: annotation.id!, brief: buildResourceBrief(db, resourceId) };
}

function promptResult(caseName: string, prompt: string): EvalResult {
  const leaked = SECRET_MARKERS.filter(marker => prompt.includes(marker));
  const retainedContext = prompt.includes('inventory UI reference') && prompt.includes('https://example.com/private/report');
  return result(
    caseName,
    'secret markers are absent and useful local context remains',
    `leaked=${leaked.join(',') || '(none)'}; retainedContext=${retainedContext}`,
    leaked.length === 0 && retainedContext,
  );
}

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}
