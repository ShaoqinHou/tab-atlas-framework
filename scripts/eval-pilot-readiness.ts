import fs from 'node:fs';
import path from 'node:path';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

const root = process.cwd();
const results: EvalResult[] = [
  onboardingPromptVisibleFromAsk(),
  reviewControlsCannotBeCoveredByShortcutLegend(),
  knowledgeMinerEvidenceReadiness(),
  requestedSectionFidelity(),
  prehumanRunnerOwnsRuntimeIsolation(),
];

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Pilot readiness evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Pilot readiness evaluation passed: ${results.length}/${results.length} cases.`);

function onboardingPromptVisibleFromAsk(): EvalResult {
  const main = read('web-ui/main.js');
  const css = read('web-ui/workspace.css');
  return result(
    'Onboarding discoverability',
    'Ask page renders a compact setup prompt with one next action and a continue command',
    [
      main.includes('renderSetupPrompt'),
      main.includes('Setup incomplete'),
      main.includes('Continue setup'),
      main.includes('openSetupPanel'),
      css.includes('.setup-prompt'),
    ].join(','),
    main.includes('renderSetupPrompt')
      && main.includes('Setup incomplete')
      && main.includes('Continue setup')
      && main.includes('openSetupPanel')
      && css.includes('.setup-prompt'),
  );
}

function reviewControlsCannotBeCoveredByShortcutLegend(): EvalResult {
  const css = read('web-ui/workspace.css');
  const review = read('web-ui/review.js');
  return result(
    'Review control overlap',
    'decision buttons remain above normal flow and shortcut legend is not absolutely over controls',
    [
      css.includes('.decision-grid'),
      css.includes('z-index: 2'),
      css.includes('.shortcut-legend'),
      css.includes('position: static'),
      review.includes('data-review-decision'),
    ].join(','),
    css.includes('.decision-grid')
      && css.includes('z-index: 2')
      && css.includes('.shortcut-legend')
      && css.includes('position: static')
      && review.includes('data-review-decision'),
  );
}

function knowledgeMinerEvidenceReadiness(): EvalResult {
  const conversation = read('src/agent/conversationService.ts');
  const planner = read('knowledge/prompts/semantic-view-planner.system.md');
  return result(
    'Knowledge Miner evidence readiness',
    'inside-video requests distinguish known evidence, metadata-only resources, missing transcripts, and one bounded scan action',
    [
      conversation.includes('known atomic items'),
      conversation.includes('metadata-only videos'),
      conversation.includes('unavailable transcripts'),
      conversation.includes('exactly one bounded scan_resources action'),
      planner.includes('Do not turn metadata-only titles into detailed facts'),
    ].join(','),
    conversation.includes('known atomic items')
      && conversation.includes('metadata-only videos')
      && conversation.includes('unavailable transcripts')
      && conversation.includes('exactly one bounded scan_resources action')
      && planner.includes('Do not turn metadata-only titles into detailed facts'),
  );
}

function requestedSectionFidelity(): EvalResult {
  const planner = read('knowledge/prompts/semantic-view-planner.system.md');
  const conversation = read('src/agent/conversationService.ts');
  const requested = [
    'extension',
    'receiver',
    'Codex',
    'storage',
    'extraction',
    'transcripts',
    'security',
    'UX',
    'installation',
    'packaging',
    'testing',
  ];
  return result(
    'Requested section fidelity',
    'explicit section dimensions are preserved or transparently merged instead of collapsed into Other',
    `sections=${requested.join(',')}; planner=${planner.includes('Explicit user-requested section dimensions')}; conversation=${conversation.includes('preserve supported section dimensions')}`,
    planner.includes('Explicit user-requested section dimensions')
      && planner.includes('Do not create empty sections')
      && planner.includes('Do not collapse unrelated categories into a generic Other bucket')
      && conversation.includes('preserve supported section dimensions')
      && conversation.includes('do not collapse unrelated categories into a generic bucket'),
  );
}

function prehumanRunnerOwnsRuntimeIsolation(): EvalResult {
  const runner = read('scripts/roleplay-prehuman.ts');
  return result(
    'Pre-human runner isolation',
    'runner sets roleplay profile, clone database, isolated bootstrap directory, and production before/after checks',
    [
      runner.includes('TABATLAS_RUNTIME_PROFILE'),
      runner.includes('roleplay'),
      runner.includes('environment-clone'),
      runner.includes('productionBefore'),
      runner.includes('productionAfter'),
      runner.includes('TABATLAS_BOOTSTRAP_DIR'),
    ].join(','),
    runner.includes('TABATLAS_RUNTIME_PROFILE')
      && runner.includes('roleplay')
      && runner.includes('environment-clone')
      && runner.includes('productionBefore')
      && runner.includes('productionAfter')
      && runner.includes('TABATLAS_BOOTSTRAP_DIR'),
  );
}

function read(filePath: string): string {
  return fs.readFileSync(path.join(root, filePath), 'utf8');
}

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}
