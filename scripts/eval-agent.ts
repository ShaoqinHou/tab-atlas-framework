import { Command } from 'commander';
import { addUserAnnotation } from '../src/annotations/service.js';
import { runAgentCommand } from '../src/agent/commandService.js';
import { searchResources } from '../src/agent/tools.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { CodexSdkProvider, type CodexSdkProviderConfig } from '../src/llm/CodexSdkProvider.js';
import type { LlmProvider } from '../src/llm/types.js';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

const program = new Command();
program
  .option('--provider <provider>', 'codex or stub', process.env.TABATLAS_EVAL_AGENT_PROVIDER ?? 'codex')
  .option('--reasoning-effort <effort>', 'minimal, low, medium, high, or xhigh', process.env.TABATLAS_EVAL_REASONING_EFFORT ?? 'low')
  .parse(process.argv);

const opts = program.opts<{ provider: string; reasoningEffort: string }>();
const db = openDatabase(':memory:');
const ids = seedFixtures();
const provider = createProvider(opts.provider, readReasoningEffort(opts.reasoningEffort));
const results: EvalResult[] = [];

results.push(retrievesProjectReference());
results.push(retrievesAnnotatedGameUiCandidate());
results.push(await plansGameUiViewThroughAgent(provider));

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Agent evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Agent evaluation passed: ${results.length}/${results.length} cases.`);

function seedFixtures() {
  importSnapshot(db, {
    capturedAt: '2026-06-18T00:00:00.000Z',
    tabs: [
      { browser: 'chrome', title: 'Inventory UI layout breakdown', url: 'https://www.youtube.com/watch?v=inventory01', groupTitle: 'Game UI' },
      { browser: 'chrome', title: 'Combat mechanics design notes', url: 'https://example.com/combat-mechanics', groupTitle: 'Game Ideas' },
      { browser: 'chrome', title: 'Color composition reference', url: 'https://example.com/color-composition', groupTitle: 'Art Ideas' },
      { browser: 'edge', title: 'TabAtlas local receiver architecture', url: 'https://github.com/example/tabatlas', groupTitle: 'Tab manager project' },
      { browser: 'chrome', title: 'Untitled random page', url: 'https://example.com/random', groupTitle: 'Inbox' },
    ],
  }, 'agent_eval');

  const rows = db.prepare('SELECT id, title_best FROM resources').all() as { id: string; title_best: string }[];
  const byTitle = Object.fromEntries(rows.map(row => [row.title_best, row.id]));
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: byTitle['Inventory UI layout breakdown'],
    tags: ['inspiration', 'game-ui'],
    description: 'Strong inventory UI reference for game interface design.',
    decision: 'inspiration',
    source: 'focused_review',
  });
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: byTitle['TabAtlas local receiver architecture'],
    tags: ['project_reference'],
    description: 'Receiver architecture reference for the tab-manager project.',
    decision: 'project_reference',
    source: 'focused_review',
  });
  return {
    inventory: byTitle['Inventory UI layout breakdown'],
    project: byTitle['TabAtlas local receiver architecture'],
    art: byTitle['Color composition reference'],
  };
}

function retrievesProjectReference(): EvalResult {
  const search = searchResources(db, {
    query: 'tab-manager receiver architecture project reference',
    filters: { annotationStatus: 'any', limit: 5 },
  });
  const first = search.matches[0];
  return result(
    'Retrieval ranks project reference',
    'annotated receiver architecture resource is first',
    `${first?.resourceId ?? '(none)'} / ${first?.reasons.join('; ') ?? '(none)'}`,
    first?.resourceId === ids.project && first.reasons.some(reason => reason.includes('user annotation')),
  );
}

function retrievesAnnotatedGameUiCandidate(): EvalResult {
  const search = searchResources(db, {
    query: 'game ui inventory interface inspiration',
    filters: { annotationStatus: 'any', limit: 5 },
  });
  const rank = search.matches.findIndex(match => match.resourceId === ids.inventory);
  return result(
    'Retrieval includes annotated game UI candidate',
    'inventory UI resource is retrieved in top two with annotation evidence',
    `rank=${rank}; ${search.matches.map(match => `${match.resourceId}:${match.reasons.join('|')}`).join(', ')}`,
    rank >= 0 && rank < 2 && search.matches[rank].reasons.some(reason => reason.includes('user annotation')),
  );
}

async function plansGameUiViewThroughAgent(provider: LlmProvider): Promise<EvalResult> {
  const command = 'Make a focused game UI inspiration view. Include inventory interface examples and exclude unrelated art.';
  const output = await runAgentCommand(db, provider, {
    text: command,
    mode: 'codex',
    dryRun: true,
    candidateLimit: 5,
  });
  const memberships = output.plan.views.flatMap(view => view.memberships);
  const inventory = memberships.find(membership => membership.targetId === ids.inventory);
  const art = memberships.find(membership => membership.targetId === ids.art);
  const pass = output.mode === 'codex'
    && output.validationStatus === 'passed'
    && output.codexTurnSpent
    && Boolean(inventory)
    && inventory?.state !== 'exclude'
    && Boolean(inventory?.evidenceRefs.length)
    && art?.state !== 'strong_include';
  return result(
    'Codex-mode agent plans game UI view',
    'agent command uses Codex path and includes inventory UI with evidence without strongly including unrelated art',
    `mode=${output.mode}; validation=${output.validationStatus}; codexTurnSpent=${output.codexTurnSpent}; inventory=${inventory?.state ?? '(missing)'} refs=${inventory?.evidenceRefs.join(',') ?? '(none)'}; art=${art?.state ?? '(missing)'}`,
    pass,
  );
}

function createProvider(provider: string, reasoningEffort: CodexSdkProviderConfig['reasoningEffort']): LlmProvider {
  if (provider === 'stub') return stubProvider();
  if (provider !== 'codex') throw new Error(`Unsupported provider: ${provider}`);
  return new CodexSdkProvider({
    reasoningEffort,
    reuseThread: false,
    workingDirectory: process.cwd(),
  });
}

function stubProvider(): LlmProvider {
  return {
    async complete() {
      return {
        text: JSON.stringify({
          commandText: 'Make a focused game UI inspiration view.',
          views: [{
            name: 'Game UI inspiration',
            goal: 'Collect game interface references.',
            inclusionRules: ['Include game UI and inventory interface examples.'],
            exclusionRules: ['Exclude unrelated art-only references.'],
            sections: ['Inventory UI'],
            confidence: 0.9,
            memberships: [{
              targetKind: 'resource',
              targetId: ids.inventory,
              section: 'Inventory UI',
              state: 'strong_include',
              confidence: 0.9,
              reason: 'Annotated as a strong inventory UI reference.',
              evidenceRefs: [`user_annotation:${ids.inventory}`],
            }, {
              targetKind: 'resource',
              targetId: ids.art,
              state: 'exclude',
              confidence: 0.7,
              reason: 'Color composition reference is not specifically game UI.',
              evidenceRefs: [],
            }],
          }],
          reviewQueues: [],
          explanation: 'Stubbed eval plan.',
        }),
        usage: { quotaTurns: 1 },
      };
    },
  };
}

function readReasoningEffort(value: string): CodexSdkProviderConfig['reasoningEffort'] {
  if (value === 'minimal' || value === 'low' || value === 'high' || value === 'xhigh') return value;
  return 'medium';
}

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}
