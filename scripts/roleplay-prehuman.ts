import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { openDatabase } from '../src/db/index.js';
import { readDatabaseIdentity } from '../src/runtime/databaseIdentity.js';
import { fingerprintDatabase, sameDatabaseFingerprint, type DatabaseFingerprint } from '../src/runtime/databaseFingerprint.js';
import {
  evaluateProductionReceiverGuard,
  type ProductionReceiverGuardState,
} from '../src/runtime/roleplayProductionGuard.js';

type ProductBrowser = 'chrome' | 'edge';

type VerificationCheck = {
  name: string;
  passed: boolean;
  critical?: boolean;
  detail?: string;
};

type StoryScores = {
  taskCompletion: number;
  visualComprehension: number;
  discoverability: number;
  trustControl: number;
};

type StoryResult = {
  story: string;
  result: 'passed' | 'failed';
  scores: StoryScores;
  elapsedMs: number;
  primaryClicks: number;
  help: string;
  helpRequired: 'none' | 'minor' | 'workaround' | 'failed';
  issues: string[];
  screenshots: string[];
  trace?: string;
  persistedResultIds: Record<string, string[]>;
  verificationChecks: VerificationCheck[];
  interactionApiBypasses: string[];
};

type BrowserCapture = {
  browser: ProductBrowser;
  executableVersion: string;
  executablePathHash: string;
  extensionId: string;
  challengeId: string;
  capabilityId: string;
  snapshotId: string;
  tabsOpened: number;
};

type RoleplayViewEvidence = {
  id: string;
  name: string;
  commandText: string;
  goal: string;
  sections: string[];
};

type RoleplayProvider = 'deterministic' | 'codex';
type RoleplayGate = 'deterministic_release' | 'live_resilience';

const program = new Command();
program
  .option('--source <path>', 'Production/source database path', path.join('data', 'tabatlas.sqlite'))
  .option('--workdir <path>', 'Local role-play evidence directory')
  .option('--port <port>', 'Role-play receiver port', '9786')
  .option('--replace', 'Replace an existing role-play clone')
  .option('--headful', 'Run the app and product browsers headed')
  .option('--story-timeout-ms <ms>', 'Per-story interaction timeout', '300000')
  .option('--provider <provider>', 'Role-play provider: deterministic or codex', process.env.TABATLAS_ROLEPLAY_PROVIDER ?? 'deterministic')
  .option('--resilience', 'Run the live Codex resilience probe instead of strict deterministic release stories')
  .parse(process.argv);

const opts = program.opts<{ source: string; workdir?: string; port: string; replace?: boolean; headful?: boolean; storyTimeoutMs: string; provider: string; resilience?: boolean }>();
const root = process.cwd();
const source = path.resolve(root, opts.source);
const roleplayProvider = readRoleplayProvider(opts.provider);
if (opts.resilience && roleplayProvider !== 'codex') throw new Error('--resilience requires --provider codex');
const roleplayGate: RoleplayGate = opts.resilience ? 'live_resilience' : 'deterministic_release';
const workdir = path.resolve(root, opts.workdir ?? path.join('.local', opts.resilience ? 'prehuman-roleplay-rc3-live' : 'prehuman-roleplay-rc3'));
const cloneDb = path.join(workdir, 'roleplay.sqlite');
const bootstrapDir = path.join(workdir, 'bootstrap');
const screenshotsDir = path.join(workdir, 'screenshots');
const tracesDir = path.join(workdir, 'traces');
const appProfileDir = path.join(workdir, 'app-browser-profile');
const port = Number(opts.port);
const baseUrl = `http://127.0.0.1:${port}`;
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const storyTimeoutMs = Number(opts.storyTimeoutMs);

function readRoleplayProvider(value: string): RoleplayProvider {
  if (value === 'deterministic' || value === 'codex') return value;
  throw new Error(`Unsupported --provider: ${value}`);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid --port: ${opts.port}`);
if (!Number.isInteger(storyTimeoutMs) || storyTimeoutMs < 10_000) throw new Error(`Invalid --story-timeout-ms: ${opts.storyTimeoutMs}`);
if (!fs.existsSync(source)) throw new Error(`Source database not found: ${source}`);
if (!await canBind(port)) throw new Error(`Role-play port ${port} is not available.`);

fs.mkdirSync(workdir, { recursive: true });
fs.rmSync(bootstrapDir, { recursive: true, force: true });
fs.rmSync(screenshotsDir, { recursive: true, force: true });
fs.rmSync(tracesDir, { recursive: true, force: true });
fs.rmSync(appProfileDir, { recursive: true, force: true });
fs.mkdirSync(bootstrapDir, { recursive: true });
fs.mkdirSync(screenshotsDir, { recursive: true });
fs.mkdirSync(tracesDir, { recursive: true });

const productionIdentity = readDatabaseIdentity(source);
if (!productionIdentity || productionIdentity.environment !== 'production') {
  throw new Error('Production/source database must have a production identity before role-play.');
}

const productionReceiver = await productionReceiverGuard(source, productionIdentity.databaseId);
if (productionReceiver.blocked) {
  writeBlockedRoleplayReport(productionReceiver);
  process.exit(1);
}
const productionBefore = fingerprintDatabase(source);
const fixtureServer = await startFixtureServer();
let receiver: ChildProcess | undefined;
let appContext: BrowserContext | undefined;
let appPage: Page | undefined;
const storyResults: StoryResult[] = [];
const captures: BrowserCapture[] = [];

try {
  await cloneSourceDatabase();
  const cloneIdentity = readDatabaseIdentity(cloneDb);
  if (!cloneIdentity || cloneIdentity.environment !== 'clone' || cloneIdentity.sourceDatabaseId !== productionIdentity.databaseId) {
    throw new Error('Role-play clone identity verification failed.');
  }

  receiver = startRoleplayReceiver();
  await waitForHealth(receiver, 30_000);
  appContext = await chromium.launchPersistentContext(appProfileDir, { headless: !opts.headful, viewport: { width: 1440, height: 900 } });
  appPage = await appContext.newPage();
  await bootstrapDashboard(appPage);
  captures.push(await captureThroughProductBrowser(appPage, 'chrome', fixtureServer.url));
  captures.push(await captureThroughProductBrowser(appPage, 'edge', fixtureServer.url));
  if (roleplayGate === 'live_resilience') {
    storyResults.push(await runLiveCodexResilienceProbe(appContext, appPage));
    storyResults.push(await runReturningUserStory(appContext!, appPage!, receiver!).catch(error => storyResult({
      story: 'Returning User',
      elapsedMs: 0,
      primaryClicks: 0,
      screenshots: [],
      helpRequired: 'failed',
      issues: [`P1 Returning User interaction failed: ${error instanceof Error ? error.message : String(error)}`],
      persistedResultIds: {},
      verificationChecks: [check('story interaction completed', false, true)],
      interactionApiBypasses: [],
    })));
  } else {
    storyResults.push(await runReviewSeeding(appPage));
    storyResults.push(await runCreativeCollectorStory(appContext, appPage));
    storyResults.push(await runProjectBuilderStory(appContext, appPage));
    storyResults.push(await runKnowledgeMinerStory(appContext, appPage));
    storyResults.push(await runSkepticalCuratorStory(appContext, appPage));
    storyResults.push(await runOpenedForLaterStory(appContext, appPage));
    storyResults.push(await runReturningUserStory(appContext!, appPage!, receiver!).catch(error => storyResult({
      story: 'Returning User',
      elapsedMs: 0,
      primaryClicks: 0,
      screenshots: [],
      helpRequired: 'failed',
      issues: [`P1 Returning User interaction failed: ${error instanceof Error ? error.message : String(error)}`],
      persistedResultIds: {},
      verificationChecks: [check('story interaction completed', false, true)],
      interactionApiBypasses: [],
    })));
  }
} finally {
  await appContext?.close().catch(() => undefined);
  if (receiver) await stopProcess(receiver);
  await fixtureServer.close();
}

const productionAfter = fingerprintDatabase(source);
const cloneAfter = fingerprintDatabase(cloneDb);
const verification = readVerificationSummary(cloneDb);
const productionUnchanged = sameDatabaseFingerprint(productionBefore, productionAfter);
const automaticOrphans = verification.orphanAutomaticActions;
const interactionApiBypasses = storyResults.flatMap(story => story.interactionApiBypasses.map(item => `${story.story}: ${item}`));
const p0p1Issues = [
  ...storyResults.flatMap(story => story.issues.filter(issue => /^P[01]/.test(issue))),
  ...(productionUnchanged ? [] : ['P0 production fingerprint changed during role-play']),
  ...(automaticOrphans.length ? ['P1 orphan automatic actions remained after role-play'] : []),
  ...(interactionApiBypasses.length ? ['P1 interaction-phase API bypasses were used'] : []),
  ...(verification.expectedConfirmActions ? [`P1 confirm-required actions remained proposed: ${verification.expectedConfirmActions}`] : []),
];
const ok = !p0p1Issues.length
  && productionUnchanged
  && interactionApiBypasses.length === 0
  && verification.expectedConfirmActions === 0
  && storyResults.every(story => story.result === 'passed'
    && story.scores.taskCompletion >= 4
    && story.scores.visualComprehension >= 3
    && story.scores.discoverability >= 3
    && story.scores.trustControl >= 3);

const metrics = {
  generatedAt: new Date().toISOString(),
  gate: roleplayGate,
  provider: roleplayProvider,
  sourceDatabaseId: productionIdentity.databaseId,
  cloneDatabaseId: cloneAfter.databaseId,
  productionReceiver,
  productionUnchanged,
  captures,
  stories: storyResults,
  verification,
  ok,
};
const issues = {
  p0p1Issues,
  storyIssues: storyResults.flatMap(story => story.issues.map(issue => ({ story: story.story, issue }))),
  interactionApiBypasses,
  orphanAutomaticActions: automaticOrphans,
};
const reportPath = path.join(workdir, 'report-redacted.md');
const metricsPath = path.join(workdir, 'metrics-redacted.json');
const issuesPath = path.join(workdir, 'issues-redacted.json');
fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
fs.writeFileSync(issuesPath, JSON.stringify(issues, null, 2));
fs.writeFileSync(reportPath, renderMarkdownReport({
  ok,
  gate: roleplayGate,
  provider: roleplayProvider,
  productionBefore,
  productionAfter,
  productionUnchanged,
  captures,
  storyResults,
  verification,
  issues,
}));
console.log(JSON.stringify({ ok, gate: roleplayGate, provider: roleplayProvider, reportPath, metricsPath, issuesPath, stories: storyResults.map(story => ({ story: story.story, result: story.result, scores: story.scores })) }, null, 2));
if (!ok) process.exit(1);

function writeBlockedRoleplayReport(productionReceiver: ProductionReceiverGuardState): void {
  const generatedAt = new Date().toISOString();
  const reason = productionReceiver.blockReason ?? 'Role-play blocked by production receiver safety guard.';
  const reportPath = path.join(workdir, 'report-redacted.md');
  const metricsPath = path.join(workdir, 'metrics-redacted.json');
  const issuesPath = path.join(workdir, 'issues-redacted.json');
  const metrics = {
    generatedAt,
    blocked: true,
    ok: false,
    sourceDatabaseId: productionIdentity?.databaseId ?? '(missing)',
    productionReceiver,
    captures: [],
    stories: [],
    verification: {
      conversations: 0,
      views: 0,
      reviewDecisions: 0,
      orphanAutomaticActions: [],
      expectedConfirmActions: 0,
    },
  };
  const issues = {
    p0p1Issues: [`P0 ${reason}`],
    storyIssues: [],
    orphanAutomaticActions: [],
  };
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  fs.writeFileSync(issuesPath, JSON.stringify(issues, null, 2));
  fs.writeFileSync(reportPath, [
    '# TabAtlas rc3 pre-human role-play',
    '',
    'Result: blocked',
    `Generated: ${generatedAt}`,
    `Reason: ${reason}`,
    `Production receiver running: ${productionReceiver.wasRunning}`,
    `Production receiver stopped: ${productionReceiver.stopped}`,
    `Production receiver restarted: ${productionReceiver.restarted}`,
    '',
    '## Real UI story results',
    '',
    'Not run. The production receiver safety guard blocked role-play before clone setup.',
    '',
  ].join('\n'));
  console.log(JSON.stringify({ ok: false, blocked: true, reason, reportPath, metricsPath, issuesPath }, null, 2));
}

async function bootstrapDashboard(page: Page): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const secret = await waitForBootstrapSecret(bootstrapDir, 10_000);
  await page.locator('#continueSetupButton').click({ timeout: 10_000 }).catch(() => undefined);
  await page.locator('#bootstrapSecret').fill(secret);
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/onboarding/bootstrap') && response.ok(), { timeout: 10_000 }),
    page.locator('#bootstrapButton').click(),
  ]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'visible', timeout: 10_000 });
  await screenshot(page, 'setup-bootstrapped');
}

async function captureThroughProductBrowser(page: Page, browserName: ProductBrowser, fixtureBaseUrl: string): Promise<BrowserCapture> {
  await openSettingsPanel(page, 'capture');
  const beforeSnapshot = latestSnapshotIdOrNull(cloneDb);
  const previousStatus = await page.locator('#captureStatus').innerText().catch(() => '');
  await page.locator('#pairingBrowser').selectOption(browserName);
  await page.locator('#createPairingButton').click();
  await page.waitForFunction(({ previous, browser }) => {
    const text = document.querySelector('#captureStatus')?.textContent ?? '';
    return text !== previous
      && text.includes(`"browser": "${browser}"`)
      && /challenge|secret|pair_/i.test(text);
  }, { previous: previousStatus, browser: browserName }, { timeout: 10_000 });
  const pairing = parsePairing(await page.locator('#captureStatus').innerText());
  const captured = await runProductBrowserCapture({
    browserName,
    fixtureBaseUrl,
    challengeId: pairing.challengeId,
    secret: pairing.secret,
    headless: !opts.headful,
  });
  await waitForNewSnapshot(beforeSnapshot, 60_000);
  await screenshot(page, `capture-${browserName}`);
  return {
    ...captured,
    challengeId: pairing.challengeId,
    capabilityId: challengeCapabilityId(cloneDb, pairing.challengeId),
    snapshotId: latestSnapshotId(cloneDb),
  };
}

async function runReviewSeeding(page: Page): Promise<StoryResult> {
  const started = Date.now();
  let clicks = 0;
  const screenshots: string[] = [];
  const issues: string[] = [];
  await page.getByTestId('nav-review').click(); clicks += 1;
  await page.locator('[data-review-start="unmarked"]').click({ timeout: 10_000 }); clicks += 1;
  await page.waitForSelector('.review-current [data-review-inspect]', { state: 'visible', timeout: 10_000 });
  const typingBefore = await page.locator('.review-current [data-review-inspect]').getAttribute('data-review-inspect');
  await page.locator('#reviewNote').fill('This note includes S and I while focus stays inside the text field.');
  const typingAfter = await page.locator('.review-current [data-review-inspect]').getAttribute('data-review-inspect');
  if (typingBefore !== typingAfter) issues.push('P1 typing in review note triggered shortcuts');
  const plan = [
    ['inspiration', '', ''],
    ['inspiration', '', ''],
    ['inspiration', '', ''],
    ['project_reference', '', ''],
    ['project_reference', '', ''],
    ['watch_later', '', ''],
    ['watch_later', '', ''],
    ['ignore', '', ''],
    ['important', 'needs-deeper-read', 'Needs deeper read before trusting the details.'],
    ['important', '', 'Written description with S and I retained safely.'],
    ['skip', '', ''],
    ['important', '', 'Recovered from the skipped item path by continuing review.'],
  ] as const;
  for (const [decision, tags, note] of plan) {
    await page.locator('#reviewTags').fill(tags);
    await page.locator('#reviewNote').fill(note);
    await page.locator(`[data-review-decision="${decision}"]`).click({ timeout: 10_000 });
    clicks += 1;
    await page.waitForTimeout(150);
  }
  screenshots.push(await screenshot(page, 'review-seeding'));
  const counts = reviewDecisionCounts(cloneDb);
  const pass = counts.total >= 11
    && counts.inspiration >= 3
    && counts.projectReference >= 2
    && counts.watchLater >= 2
    && counts.ignore >= 1
    && counts.needsDeeperRead >= 1
    && counts.skipped >= 1
    && !issues.length;
  if (!pass) issues.push(`P1 review seeding counts incomplete: ${JSON.stringify(counts)}`);
  return storyResult({
    story: 'Review seeding',
    elapsedMs: Date.now() - started,
    primaryClicks: clicks,
    screenshots,
    helpRequired: pass ? 'none' : 'failed',
    issues,
    persistedResultIds: { annotations: counts.annotationIds, reviewSessions: counts.sessionIds },
    verificationChecks: [
      check('review UI loaded', Boolean(typingBefore), true),
      check('typing S/I in note did not trigger shortcuts', typingBefore === typingAfter, true),
      check('three inspiration decisions saved', counts.inspiration >= 3, true, `inspiration=${counts.inspiration}`),
      check('two project-reference decisions saved', counts.projectReference >= 2, true, `projectReference=${counts.projectReference}`),
      check('two watch-later decisions saved', counts.watchLater >= 2, true, `watchLater=${counts.watchLater}`),
      check('ignore and needs-deeper-read saved', counts.ignore >= 1 && counts.needsDeeperRead >= 1, true, `ignore=${counts.ignore}; needsDeeperRead=${counts.needsDeeperRead}`),
      check('skipped item path exercised', counts.skipped >= 1, true, `skipped=${counts.skipped}`),
    ],
    interactionApiBypasses: [],
  });
}

async function runCreativeCollectorStory(context: BrowserContext, page: Page): Promise<StoryResult> {
  return runUiStory(context, page, 'Creative Collector', async () => {
    const before = conversationCounts(cloneDb);
    let clicks = 0;
    const screenshots: string[] = [];
    clicks += await submitConversationPrompt(page, 'Make a visual inspiration board from the captured tabs. Keep personal inspiration, visual references, game inspiration, and cross-domain references visible.');
    await waitForConversationAdvance(before.messages, storyTimeoutMs);
    clicks += await resolveVisibleActionsSince(page, before.actions, { requiredActionKinds: ['plan_view'] });
    await openViewsPage(page); clicks += 1;
    await expectVisible(page.getByTestId('workspace-board'));
    const sectionCount = await page.locator('.board-column').count();
    const cards = await cardMetrics(page);
    await clickLayout(page, 'Gallery'); clicks += 1;
    await expectVisible(page.getByTestId('workspace-gallery'));
    const galleryCards = await page.locator('.resource-card.gallery').count();
    const firstCard = page.locator('.resource-card').first();
    await firstCard.click(); clicks += 1;
    await expectVisible(page.getByTestId('inspector-surface'));
    await page.locator('[data-inspector-tab="evidence"]').click(); clicks += 1;
    const evidenceRows = await page.locator('.evidence-row').count();
    const inspectorText = await page.getByTestId('inspector-surface').innerText();
    const evidenceLabelVisible = evidenceRows > 0 || /Evidence|User note|AI analysis|Verified content|Title only|Prior correction|why/i.test(inspectorText);
    await page.locator('[data-close-inspector]').click(); clicks += 1;
    await expectVisible(page.getByTestId('workspace-gallery'));
    screenshots.push(await screenshot(page, 'creative-collector'));
    return {
      primaryClicks: clicks,
      screenshots,
      helpRequired: 'none' as const,
      issues: [],
      interactionApiBypasses: [],
      persistedResultIds: {
        actions: actionIdsSince(before.actions),
        views: viewIdsSince(before.views),
        conversations: threadIdsSince(before.threads),
      },
      verificationChecks: [
        check('conversation produced result', conversationCounts(cloneDb).messages >= before.messages + 2, true),
        check('visible workspace opened', await page.getByTestId('workspace-gallery').isVisible().catch(() => false), true),
        check('visible sections present', sectionCount > 0, true, `sections=${sectionCount}`),
        check('five identifiable cards visible', cards.identifiable >= 5, true, `identifiable=${cards.identifiable}; total=${cards.total}`),
        check('gallery layout switch worked', galleryCards >= 5, true, `galleryCards=${galleryCards}`),
        check('inspector opened with evidence or why label', evidenceLabelVisible, true, `evidenceRows=${evidenceRows}`),
        check('inspector close preserved workspace context', await page.getByTestId('workspace-gallery').isVisible().catch(() => false), true),
      ],
    };
  });
}

async function runProjectBuilderStory(context: BrowserContext, page: Page): Promise<StoryResult> {
  return runUiStory(context, page, 'Project Builder', async () => {
    const before = conversationCounts(cloneDb);
    let clicks = 0;
    const screenshots: string[] = [];
    const requestedProjectSections = ['extension', 'receiver', 'codex', 'storage', 'extraction', 'transcripts', 'security', 'ux', 'installation', 'packaging', 'testing'];
    clicks += await submitConversationPrompt(page, 'Build a TabAtlas project board with sections extension, receiver, Codex, storage, extraction, transcripts, security, UX, installation, packaging, testing.');
    await waitForConversationAdvance(before.messages, storyTimeoutMs);
    clicks += await resolveVisibleActionsSince(page, before.actions);
    const projectView = latestActionResultViewEvidenceSince(before.actions, ['plan_view'])
      ?? findViewWithSectionMatchesSince(before.views, requestedProjectSections, 6);
    if (projectView) {
      await openViewById(page, projectView.id, projectView.name);
    } else {
      await openViewsPage(page);
    }
    clicks += 1;
    await clickLayout(page, 'Board'); clicks += 1;
    await expectVisible(page.getByTestId('workspace-board'));
    await page.waitForFunction((sections) => {
      const text = Array.from(document.querySelectorAll('[data-testid="workspace-board"] .board-column h4'))
        .map(element => element.textContent ?? '')
        .join(' | ')
        .toLowerCase();
      return sections.filter(section => text.includes(section)).length >= 6;
    }, requestedProjectSections, { timeout: 10_000 }).catch(() => undefined);
    const sectionText = await page.locator('[data-testid="workspace-board"] .board-column h4')
      .evaluateAll(elements => elements.map(element => element.textContent ?? '').join(' | '));
    const projectSections = requestedProjectSections.filter(section => sectionText.toLowerCase().includes(section));
    const atomicCards = await page.locator('.resource-card[data-target-kind="atomic_item"]').count();
    const card = atomicCards > 0
      ? page.locator('.resource-card[data-target-kind="atomic_item"]').first()
      : page.locator('.resource-card').first();
    await card.click(); clicks += 1;
    await expectVisible(page.getByTestId('inspector-surface'));
    const overviewText = await page.getByTestId('inspector-surface').innerText();
    await page.locator('[data-inspector-tab="evidence"]').click(); clicks += 1;
    const evidenceRows = await page.locator('.evidence-row').count();
    await page.locator('[data-inspector-tab="notes"]').click(); clicks += 1;
    const notesText = await page.getByTestId('inspector-surface').innerText();
    await page.locator('[data-inspector-tab="related"]').click(); clicks += 1;
    const relatedRows = await page.locator('.related-row').count();
    const parentButton = page.locator('[data-parent-resource]');
    const parentAvailable = await parentButton.count() > 0;
    if (parentAvailable) {
      await parentButton.first().click(); clicks += 1;
      await expectVisible(page.getByTestId('inspector-surface'));
    }
    await page.locator('[data-close-inspector]').click(); clicks += 1;
    await expectVisible(page.getByTestId('workspace-board'));
    await clickLayout(page, 'Map'); clicks += 1;
    await expectVisible(page.getByTestId('workspace-map'));
    const mapSections = await page.locator('.map-cluster').count();
    screenshots.push(await screenshot(page, 'project-builder'));
    return {
      primaryClicks: clicks,
      screenshots,
      helpRequired: 'none' as const,
      issues: [],
      interactionApiBypasses: [],
      persistedResultIds: {
        actions: actionIdsSince(before.actions),
        views: viewIdsSince(before.views),
        conversations: threadIdsSince(before.threads),
      },
      verificationChecks: [
        check('project workspace visible', await page.getByTestId('workspace-map').isVisible().catch(() => false), true),
        check('project view selected deterministically', Boolean(projectView?.id), true, projectView ? `${projectView.id}; sections=${projectView.sections.join(',')}` : 'no project view found'),
        check('project-purpose sections visible', projectSections.length >= 6, true, `view=${projectView?.id ?? '(none)'}; matched=${projectSections.join(',')}`),
        check('atomic item card found when present', atomicCards > 0, false, `atomicCards=${atomicCards}`),
        check('overview tab inspected', /State|Section|Extraction|summary/i.test(overviewText), true),
        check('evidence tab inspected', evidenceRows > 0, true, `evidenceRows=${evidenceRows}`),
        check('notes tab inspected', /Notes|No user notes|inspiration|project/i.test(notesText), true),
        check('related tab inspected', relatedRows > 0, true, `relatedRows=${relatedRows}`),
        check('atomic parent navigation considered', parentAvailable || atomicCards === 0, false, `parentAvailable=${parentAvailable}`),
        check('map layout verified', mapSections > 0, true, `mapSections=${mapSections}`),
      ],
    };
  });
}

async function runKnowledgeMinerStory(context: BrowserContext, page: Page): Promise<StoryResult> {
  return runUiStory(context, page, 'Knowledge Miner', async () => {
    const before = conversationCounts(cloneDb);
    let clicks = 0;
    const screenshots: string[] = [];
    clicks += await submitConversationPrompt(page, 'What do we know inside these videos? Separate known atomic items, transcripts, metadata-only videos, unavailable transcripts, and one bounded evidence-improvement action.');
    await waitForConversationAdvance(before.messages, storyTimeoutMs);
    await page.waitForTimeout(500);
    const threadText = await page.locator('#conversationThread').innerText();
    await waitForActionKindsSince(before.actions, ['scan_resources'], storyTimeoutMs);
    clicks += await resolveVisibleActionsSince(page, before.actions, { requiredActionKinds: ['scan_resources'] });
    await waitForTerminalActionKindSince(before.actions, 'scan_resources', storyTimeoutMs);
    await page.waitForTimeout(1000);
    if (!await page.locator('#jobsList').isVisible().catch(() => false)) {
      await openSettingsPanel(page, 'jobs'); clicks += 1;
    }
    const scanActionEvidence = latestActionEvidence(cloneDb, before.actions, 'scan_resources');
    const jobsVisible = await page.locator('#page-settings.active #settings-jobs, #jobsList').first().isVisible().catch(() => false);
    const jobRows = await page.locator('#jobsList .ops-row').count().catch(() => 0);
    screenshots.push(await screenshot(page, 'knowledge-miner'));
    return {
      primaryClicks: clicks,
      screenshots,
      helpRequired: 'minor' as const,
      issues: [],
      interactionApiBypasses: [],
      persistedResultIds: {
        actions: actionIdsSince(before.actions),
        views: viewIdsSince(before.views),
        conversations: threadIdsSince(before.threads),
      },
      verificationChecks: [
        check('known atomic or honest insufficient-evidence state shown', /known atomic|atomic item|not enough evidence|insufficient/i.test(threadText), true),
        check('metadata-only videos are labeled', /metadata[- ]only|title[- ]only/i.test(threadText), true),
        check('unavailable transcripts are explicit', /unavailable transcript|transcript.*unavailable|no transcript|missing transcript/i.test(threadText), true),
        check('bounded evidence-improvement action triggered', scanActionEvidence.bounded, true, scanActionEvidence.detail),
        check('scan action produced visible job state', jobsVisible && jobRows > 0, true, `jobsVisible=${jobsVisible}; jobRows=${jobRows}`),
      ],
    };
  });
}

async function runSkepticalCuratorStory(context: BrowserContext, page: Page): Promise<StoryResult> {
  return runUiStory(context, page, 'Skeptical Curator', async () => {
    const before = conversationCounts(cloneDb);
    let clicks = 0;
    const screenshots: string[] = [];
    await openViewsPage(page); clicks += 1;
    await page.locator('[data-state-filter="weak_include"]').click(); clicks += 1;
    if (await page.locator('.resource-card').count() === 0) {
      await page.locator('[data-state-filter="needs_review"]').click(); clicks += 1;
    }
    if (await page.locator('.resource-card').count() === 0) {
      await page.locator('[data-state-filter="visible"]').click(); clicks += 1;
    }
    const targetCard = page.locator('.resource-card').first();
    const targetId = await targetCard.getAttribute('data-target-id') ?? '';
    await targetCard.click(); clicks += 1;
    await expectVisible(page.getByTestId('inspector-surface'));
    await page.locator('[data-inspector-tab="evidence"]').click(); clicks += 1;
    const evidenceRows = await page.locator('.evidence-row').count();
    await page.locator('[data-inspector-tab="overview"]').click(); clicks += 1;
    await page.locator('[data-explain-membership]').click(); clicks += 1;
    const explanationVisible = await page.locator('#correctionResult').innerText({ timeout: 10_000 }).then(text => text.length > 0).catch(() => false);
    await page.locator('#correctionReason').fill('Not actually relevant to this role-play workspace.');
    await page.getByRole('button', { name: 'Pin exclude' }).click(); clicks += 1;
    await expectText(page.locator('#correctionResult'), /Saved pin exclude/i);
    const excludedStateText = await page.locator('#inspectorContent .metadata-grid').innerText();
    const undoButton = page.locator('[data-correction-undo]');
    await undoButton.click(); clicks += 1;
    await expectText(page.locator('#correctionResult'), /undone/i);
    const restoredStateText = await page.locator('#inspectorContent .metadata-grid').innerText();
    await page.locator('#correctionReason').fill('Keep this excluded only for this intent.');
    await page.getByRole('button', { name: 'Pin exclude' }).click(); clicks += 1;
    await expectText(page.locator('#correctionResult'), /Saved pin exclude/i);
    const beforeRefine = conversationCounts(cloneDb);
    clicks += await submitConversationPrompt(page, 'Refine this workspace using that correction, but keep the correction scoped to this intent.');
    await waitForConversationAdvance(beforeRefine.messages, storyTimeoutMs);
    clicks += await resolveVisibleActionsSince(page, beforeRefine.actions);
    const scopedView = latestActionResultViewEvidenceSince(beforeRefine.actions, ['refine_view'])
      ?? latestViewEvidenceSince(beforeRefine.views)
      ?? viewEvidenceById(await activeViewId(page));
    if (scopedView) await openViewById(page, scopedView.id, scopedView.name);
    const scopedViewId = scopedView?.id ?? await activeViewId(page);
    const beforeUnrelated = conversationCounts(cloneDb);
    clicks += await submitConversationPrompt(page, 'Create a separate practical painting tutorials view for a different purpose.');
    await waitForConversationAdvance(beforeUnrelated.messages, storyTimeoutMs);
    clicks += await resolveVisibleActionsSince(page, beforeUnrelated.actions);
    const unrelatedView = latestActionResultViewEvidenceSince(beforeUnrelated.actions, ['plan_view'])
      ?? findViewByTextSince(beforeUnrelated.views, /painting|tutorial|practical/i)
      ?? latestViewEvidenceSince(beforeUnrelated.views);
    if (unrelatedView) await openViewById(page, unrelatedView.id, unrelatedView.name);
    const unrelatedViewId = unrelatedView?.id ?? await activeViewId(page);
    const scopeEvidence = readTargetFeedbackScopeInView(cloneDb, unrelatedViewId, targetId);
    screenshots.push(await screenshot(page, 'skeptical-curator'));
    return {
      primaryClicks: clicks,
      screenshots,
      helpRequired: 'minor' as const,
      issues: [],
      interactionApiBypasses: [],
      persistedResultIds: {
        actions: actionIdsSince(before.actions),
        views: viewIdsSince(before.views),
        conversations: threadIdsSince(before.threads),
      },
      verificationChecks: [
        check('weak or surprising card selected', Boolean(targetId), true, targetId),
        check('evidence tab inspected', evidenceRows > 0, true, `evidenceRows=${evidenceRows}`),
        check('membership explanation requested', explanationVisible, true),
        check('pin exclude correction applied visibly', /Conflict|Excluded|exclude/i.test(excludedStateText), true, compact(excludedStateText)),
        check('undo restored previous visible state', restoredStateText !== excludedStateText, true, compact(restoredStateText)),
        check('correction reapplied', await page.locator('#correctionResult').innerText().then(text => /Saved pin exclude/i.test(text)).catch(() => false), true),
        check('refinement kept a scoped view active', Boolean(scopedViewId), true, scopedViewId),
        check('unrelated-purpose view created or opened', Boolean(unrelatedViewId), true, unrelatedViewId),
        check('correction did not apply globally', !scopeEvidence.feedbackApplied, true, scopeEvidence.detail),
      ],
    };
  });
}

async function runOpenedForLaterStory(context: BrowserContext, page: Page): Promise<StoryResult> {
  return runUiStory(context, page, 'Opened for Later', async () => {
    const before = conversationCounts(cloneDb);
    const snapshotBefore = latestSnapshotIdOrNull(cloneDb);
    const resourceCountBefore = resourceCount(cloneDb);
    let clicks = 0;
    const screenshots: string[] = [];
    clicks += await submitConversationPrompt(page, 'Find the tabs I marked watch later or opened for later. Separate high-value, quick-review, and safe-to-ignore sections or the closest equivalent, then open a review lane for them.');
    await waitForConversationAdvance(before.messages, storyTimeoutMs);
    clicks += await resolveVisibleActionsSince(page, before.actions);
    const openedLaterView = latestActionResultViewEvidenceSince(before.actions, ['plan_view'])
      ?? findViewByTextSince(before.views, /watch|opened|later|quick-review|safe-to-ignore|safe to ignore/i);
    if (openedLaterView) {
      await openViewById(page, openedLaterView.id, openedLaterView.name);
    } else {
      await openViewsPage(page);
    }
    clicks += 1;
    const sectionText = await page.locator('#viewWorkspace').innerText().catch(() => '');
    let reviewVisible = await page.getByTestId('page-review').isVisible().catch(() => false);
    if (!reviewVisible) {
      clicks += await submitConversationPrompt(page, 'Open a review lane for the opened-for-later candidates.');
      await waitForConversationAdvance(before.messages + 2, storyTimeoutMs);
      clicks += await resolveVisibleActionsSince(page, before.actions);
    }
    await ensureReviewLane(page); clicks += 1;
    reviewVisible = await page.getByTestId('page-review').isVisible().catch(() => false);
    await processReviewItems(page, 5); clicks += 5;
    const resourceCountAfter = resourceCount(cloneDb);
    const snapshotAfter = latestSnapshotIdOrNull(cloneDb);
    screenshots.push(await screenshot(page, 'opened-for-later'));
    return {
      primaryClicks: clicks,
      screenshots,
      helpRequired: 'minor' as const,
      issues: [],
      interactionApiBypasses: [],
      persistedResultIds: {
        actions: actionIdsSince(before.actions),
        views: viewIdsSince(before.views),
        conversations: threadIdsSince(before.threads),
        reviewSessions: latestReviewSessionIds(cloneDb, 2),
      },
      verificationChecks: [
        check('opened-for-later workspace visible', /watch later|opened|later|return|high-value|quick-review|safe-to-ignore|safe to ignore/i.test(sectionText), true, compact(sectionText).slice(0, 220)),
        check('review lane/session opened visibly', reviewVisible, true),
        check('five review items processed', reviewDecisionCounts(cloneDb).total >= 16, true),
        check('resources were not deleted', resourceCountAfter >= resourceCountBefore, true, `${resourceCountBefore}->${resourceCountAfter}`),
        check('browser snapshot was not mutated by review', snapshotAfter === snapshotBefore, true, `${snapshotBefore}->${snapshotAfter}`),
      ],
    };
  });
}

async function runLiveCodexResilienceProbe(context: BrowserContext, page: Page): Promise<StoryResult> {
  return runUiStory(context, page, 'Live Codex resilience', async () => {
    const before = conversationCounts(cloneDb);
    let clicks = 0;
    const screenshots: string[] = [];
    clicks += await submitConversationPrompt(page, 'Create one useful TabAtlas workspace from these captured tabs. Use any sensible sections, keep uncertain items reviewable, and do not infer private or unavailable content.');
    await waitForConversationAdvance(before.messages, storyTimeoutMs);
    clicks += await resolveVisibleActionsSince(page, before.actions);
    const createdView = latestActionResultViewEvidenceSince(before.actions, ['plan_view', 'refine_view'])
      ?? latestViewEvidenceSince(before.views);
    if (createdView) {
      await openViewById(page, createdView.id, createdView.name);
    } else {
      await openViewsPage(page);
    }
    clicks += 1;
    await clickLayout(page, 'Board'); clicks += 1;
    await expectVisible(page.getByTestId('workspace-board'));
    const workspaceVisible = await page.getByTestId('workspace-board').isVisible().catch(() => false);
    const visibleCards = await page.locator('.resource-card').count().catch(() => 0);
    const firstCard = page.locator('.resource-card').first();
    if (visibleCards > 0) {
      await firstCard.click(); clicks += 1;
      await expectVisible(page.getByTestId('inspector-surface'));
    }
    const inspectorVisible = await page.getByTestId('inspector-surface').isVisible().catch(() => false);
    const explainButton = page.locator('[data-explain-membership]');
    if (await explainButton.isVisible().catch(() => false)) {
      await explainButton.click(); clicks += 1;
    }
    const explanationVisible = await page.locator('#correctionResult').innerText({ timeout: 15_000 })
      .then(text => text.length > 0)
      .catch(() => false);
    let correctionApplied = false;
    let correctionUndone = false;
    if (await page.locator('#correctionReason').isVisible().catch(() => false)) {
      await page.locator('#correctionReason').fill('Live resilience probe correction.');
      await page.getByRole('button', { name: 'Pin exclude' }).click(); clicks += 1;
      await expectText(page.locator('#correctionResult'), /Saved pin exclude/i);
      correctionApplied = true;
      const undo = page.locator('[data-correction-undo]');
      await expectVisible(undo);
      await undo.click(); clicks += 1;
      await expectText(page.locator('#correctionResult'), /undone/i);
      correctionUndone = true;
    }
    await page.locator('[data-close-inspector]').click().catch(() => undefined);
    if (createdView) await openViewById(page, createdView.id, createdView.name);
    const beforeReview = conversationCounts(cloneDb);
    const previousReviewSessions = reviewSessionCount(cloneDb);
    clicks += await submitConversationPrompt(page, 'Open a review lane for uncertain or weak items in the current workspace.');
    await waitForConversationAdvance(beforeReview.messages, storyTimeoutMs);
    await waitForReviewActionOrSessionSince(beforeReview.actions, previousReviewSessions, storyTimeoutMs);
    clicks += await resolveVisibleActionsSince(page, beforeReview.actions);
    await ensureReviewLane(page); clicks += 1;
    const reviewVisible = await page.getByTestId('page-review').isVisible().catch(() => false);
    await processReviewItems(page, 2); clicks += 2;
    const terminalActions = actionStatesSince(before.actions);
    const nonTerminalActions = terminalActions.filter(action => action.status === 'running'
      || action.status === 'approved'
      || (action.status === 'proposed' && action.approval !== 'confirm'));
    if (createdView) await openViewById(page, createdView.id, createdView.name);
    await clickLayout(page, 'Gallery'); clicks += 1;
    await expectVisible(page.getByTestId('workspace-gallery'));
    const galleryVisible = await page.getByTestId('workspace-gallery').isVisible().catch(() => false);
    screenshots.push(await screenshot(page, 'live-codex-resilience'));
    return {
      primaryClicks: clicks,
      screenshots,
      helpRequired: 'minor' as const,
      issues: nonTerminalActions.length ? [`P1 non-terminal live actions remained: ${JSON.stringify(nonTerminalActions)}`] : [],
      interactionApiBypasses: [],
      persistedResultIds: {
        actions: actionIdsSince(before.actions),
        views: viewIdsSince(before.views),
        conversations: threadIdsSince(before.threads),
      },
      verificationChecks: [
        check('visible semantic workspace produced', Boolean(createdView?.id) && workspaceVisible && visibleCards > 0, true, `${createdView?.id ?? '(none)'}; cards=${visibleCards}`),
        check('inspector usable', inspectorVisible, true),
        check('membership explanation usable', explanationVisible, true),
        check('correction can be applied and undone', correctionApplied && correctionUndone, true, `applied=${correctionApplied}; undone=${correctionUndone}`),
        check('review session opened', reviewVisible, true),
        check('persistent actions terminalized', nonTerminalActions.length === 0, true, JSON.stringify(nonTerminalActions)),
        check('gallery state prepared for restart', galleryVisible, true),
      ],
    };
  });
}

async function runUiStory(
  context: BrowserContext,
  page: Page,
  story: string,
  run: () => Promise<{
    primaryClicks: number;
    screenshots: string[];
    helpRequired: StoryResult['helpRequired'];
    issues: string[];
    interactionApiBypasses: string[];
    persistedResultIds: Record<string, string[]>;
    verificationChecks: VerificationCheck[];
  }>,
): Promise<StoryResult> {
  const started = Date.now();
  const tracePath = path.join(tracesDir, `${slug(story)}.zip`);
  await context.tracing.start({ screenshots: true, snapshots: true });
  try {
    const result = await run();
    return storyResult({
      story,
      elapsedMs: Date.now() - started,
      primaryClicks: result.primaryClicks,
      screenshots: result.screenshots,
      trace: path.relative(workdir, tracePath),
      helpRequired: result.helpRequired,
      issues: result.issues,
      persistedResultIds: result.persistedResultIds,
      verificationChecks: result.verificationChecks,
      interactionApiBypasses: result.interactionApiBypasses,
    });
  } catch (error) {
    const issues = [`P1 ${story} interaction failed: ${error instanceof Error ? error.message : String(error)}`];
    const screenshots = [await screenshot(page, `${slug(story)}-failed`).catch(() => '')].filter(Boolean);
    return storyResult({
      story,
      elapsedMs: Date.now() - started,
      primaryClicks: 0,
      screenshots,
      trace: path.relative(workdir, tracePath),
      helpRequired: 'failed',
      issues,
      persistedResultIds: {},
      verificationChecks: [check('story interaction completed', false, true)],
      interactionApiBypasses: [],
    });
  } finally {
    await context.tracing.stop({ path: tracePath }).catch(() => undefined);
  }
}

async function runReturningUserStory(
  context: BrowserContext,
  page: Page,
  runningReceiver: ChildProcess,
): Promise<StoryResult> {
  const started = Date.now();
  const screenshots: string[] = [];
  const issues: string[] = [];
  let clicks = 0;
  await page.locator('#conversationTab').click().catch(() => undefined);
  await openViewsPage(page); clicks += 1;
  await clickLayout(page, 'Gallery'); clicks += 1;
  await expectVisible(page.getByTestId('workspace-gallery'));
  const firstCard = page.locator('.resource-card').first();
  await expectVisible(firstCard);
  const firstCardTitle = await firstCard.locator('.card-title-row strong').innerText().catch(() => firstCard.innerText());
  const searchTerm = firstCardTitle.split(/\s+/).find(term => /^[a-z0-9-]{4,}$/i.test(term))?.toLowerCase() ?? 'tab';
  await page.locator('#workspaceSearch').fill(searchTerm);
  await page.waitForTimeout(250);
  if (!await firstCard.isVisible().catch(() => false)) {
    await page.locator('#workspaceSearch').fill('');
    await page.waitForTimeout(250);
  }
  await expectVisible(firstCard);
  await firstCard.click(); clicks += 1;
  await expectVisible(page.getByTestId('inspector-surface'));
  await page.locator('[data-inspector-tab="evidence"]').click(); clicks += 1;
  await page.getByTestId('nav-review').click(); clicks += 1;
  if (!await page.locator('.review-current').isVisible().catch(() => false)) {
    await page.locator('[data-review-start="unmarked"]').click({ timeout: 10_000 }); clicks += 1;
  }
  if (await page.locator('[data-review-decision="important"]').isVisible().catch(() => false)) {
    await page.locator('#reviewNote').fill('Returning-user partial review progress.');
    await page.locator('[data-review-decision="important"]').click(); clicks += 1;
    await page.waitForTimeout(150);
  }
  const reviewBefore = await page.locator('.progress-block').innerText().catch(() => '');
  screenshots.push(await screenshot(page, 'returning-user-before'));
  await context.close();
  await stopProcess(runningReceiver);
  receiver = startRoleplayReceiver();
  await waitForHealth(receiver, 30_000);
  appContext = await chromium.launchPersistentContext(appProfileDir, { headless: !opts.headful, viewport: { width: 1440, height: 900 } });
  appPage = await appContext.newPage();
  await appPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await appPage.waitForSelector('[data-testid="app-shell"]', { state: 'visible', timeout: 10_000 });
  const restored = await appPage.evaluate(() => ({
    page: localStorage.getItem('tabatlas.workspace.page'),
    layout: localStorage.getItem('tabatlas.workspace.layout'),
    query: localStorage.getItem('tabatlas.workspace.workspaceQueryFilter'),
    thread: localStorage.getItem('tabatlas.workspace.activeThreadId'),
    reviewSession: localStorage.getItem('tabatlas.workspace.reviewSessionId'),
    selectedTargetId: localStorage.getItem('tabatlas.workspace.selectedTargetId'),
    inspectorTab: localStorage.getItem('tabatlas.workspace.inspectorTab'),
  }));
  await appPage.getByTestId('nav-views').click(); clicks += 1;
  await expectVisible(appPage.getByTestId('workspace-gallery'));
  const restoredSearchValue = await appPage.locator('#workspaceSearch').inputValue().catch(() => '');
  const inspectorVisible = await appPage.getByTestId('inspector-surface').evaluate(element => element.classList.contains('active')).catch(() => false);
  const evidenceSelected = await appPage.locator('[data-inspector-tab="evidence"]').getAttribute('aria-selected').catch(() => 'false');
  await appPage.getByTestId('nav-review').click(); clicks += 1;
  const reviewAfter = await appPage.locator('.progress-block').innerText().catch(() => '');
  const actionCountBeforeReplayCheck = conversationCounts(cloneDb).actions;
  await appPage.waitForTimeout(1000);
  const actionCountAfterReplayCheck = conversationCounts(cloneDb).actions;
  screenshots.push(await screenshot(appPage, 'returning-user-after'));
  return storyResult({
    story: 'Returning User',
    elapsedMs: Date.now() - started,
    primaryClicks: clicks,
    screenshots,
    helpRequired: 'none',
    issues,
    persistedResultIds: { localStorage: Object.values(restored).filter((value): value is string => typeof value === 'string' && Boolean(value)) },
    verificationChecks: [
      check('conversation remained active', Boolean(restored.thread), true, restored.thread ?? ''),
      check('generated view remained active', Boolean(await activeViewId(appPage)), true, await activeViewId(appPage)),
      check('non-default layout restored', restored.layout === 'gallery', true, restored.layout ?? ''),
      check('search/filter restored', restored.query === searchTerm && restoredSearchValue === searchTerm, true, `expected=${searchTerm}; stored=${restored.query ?? ''}; visible=${restoredSearchValue}`),
      check('inspector target restored', Boolean(restored.selectedTargetId), true, restored.selectedTargetId ?? ''),
      check('inspector evidence tab restored', inspectorVisible && evidenceSelected === 'true' && restored.inspectorTab === 'evidence', true, `visible=${inspectorVisible}; selected=${evidenceSelected}; stored=${restored.inspectorTab}`),
      check('review session progress restored', Boolean(restored.reviewSession) && /done|pending/i.test(reviewAfter), true, `before=${compact(reviewBefore)}; after=${compact(reviewAfter)}`),
      check('historical action plan did not replay', actionCountAfterReplayCheck === actionCountBeforeReplayCheck, true, `${actionCountBeforeReplayCheck}->${actionCountAfterReplayCheck}`),
    ],
    interactionApiBypasses: [],
  });
}

async function confirmVisibleConfirmActions(page: Page, actionIds: string[]): Promise<number> {
  let clicked = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    if (!actionIds.length) return clicked;
    let clickedThisPass = 0;
    for (const actionId of actionIds) {
      const button = page.locator(`${attributeSelector('data-agent-confirm', actionId)}, ${attributeSelector('data-agent-retry', actionId)}`).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        clicked += 1;
        clickedThisPass += 1;
        await page.waitForTimeout(1000);
      }
    }
    if (!clickedThisPass) break;
  }
  return clicked;
}

async function resolveVisibleActionsSince(
  page: Page,
  previousActions: number,
  options: { requiredActionKinds?: string[] } = {},
): Promise<number> {
  let clicked = 0;
  if (options.requiredActionKinds?.length) {
    await waitForActionKindsSince(previousActions, options.requiredActionKinds, storyTimeoutMs);
  }
  for (let pass = 0; pass < 6; pass += 1) {
    await waitForVisibleActionCards(page, previousActions, 15_000).catch(() => undefined);
    const actionIds = actionIdsSince(previousActions);
    const passClicks = await confirmVisibleConfirmActions(page, actionIds);
    clicked += passClicks;
    await waitForActionsQuiescentSince(previousActions, storyTimeoutMs);
    const unresolvedRequired = options.requiredActionKinds?.length
      ? proposedConfirmActionsSince(previousActions, options.requiredActionKinds)
      : [];
    if (!passClicks && !unresolvedRequired.length) break;
    if (!passClicks) await delay(750);
  }
  const unresolvedRequired = options.requiredActionKinds?.length
    ? proposedConfirmActionsSince(previousActions, options.requiredActionKinds)
    : [];
  if (unresolvedRequired.length) {
    throw new Error(`Required confirm actions were not completed through the visible UI: ${JSON.stringify(unresolvedRequired)}`);
  }
  return clicked;
}

async function waitForVisibleActionCards(page: Page, previousActions: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const states = actionStatesSince(previousActions);
    if (states.length === 0) return;
    const visibleActionIds = await page.locator('[data-action-id]').evaluateAll(elements => elements
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })
      .map(element => element.getAttribute('data-action-id') ?? ''));
    if (states.some(action => visibleActionIds.includes(action.id))) return;
    await delay(500);
  }
  throw new Error('Conversation action cards did not become visible before confirmation.');
}

async function submitConversationPrompt(page: Page, prompt: string): Promise<number> {
  await page.getByTestId('nav-ask').click();
  await page.locator('#conversationTab').click().catch(() => undefined);
  await page.waitForSelector('#conversationSurface.active #conversationInput', { state: 'visible', timeout: 10_000 });
  await page.locator('#conversationInput').fill(prompt);
  await page.getByTestId('conversation-form').locator('button[type="submit"]').click();
  return 2;
}

async function openViewsPage(page: Page): Promise<void> {
  await page.getByTestId('nav-views').click();
  await page.waitForFunction(() => document.querySelector('#page-views')?.classList.contains('active'), undefined, { timeout: 10_000 });
}

async function openViewById(page: Page, viewId: string, expectedViewName = ''): Promise<void> {
  await openViewsPage(page);
  await clearInvalidActiveViewThroughControl(page);
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (attempt > 0 || !await waitForViewOption(page, viewId, 2_000)) {
        await refreshViewsThroughUi(page);
      }
      await waitForViewOption(page, viewId, 15_000, true);
      const workspaceResponse = page.waitForResponse(response => (
        response.url().includes(`/api/views/${encodeURIComponent(viewId)}/workspace`) && response.ok()
      ), { timeout: 30_000 }).catch(() => undefined);
      await selectViewOptionThroughControl(page, viewId);
      await workspaceResponse;
      await page.waitForFunction((id) => localStorage.getItem('tabatlas.workspace.activeViewId') === id, viewId, { timeout: 10_000 });
      await page.waitForFunction(({ id, name }) => {
        const select = document.querySelector('#activeViewSelect') as HTMLSelectElement | null;
        const workspaceText = document.querySelector('#viewWorkspace')?.textContent ?? '';
        const normalizedWorkspace = workspaceText.toLowerCase();
        const normalizedName = String(name || '').toLowerCase();
        return select?.value === id
          && !/Choose a view from the selector/i.test(workspaceText)
          && (!normalizedName || normalizedWorkspace.includes(normalizedName));
      }, { id: viewId, name: expectedViewName }, { timeout: 30_000 });
      return;
    } catch (error) {
      lastError = error;
      await delay(750);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`View ${viewId} could not be selected through the visible UI.`);
}

async function clearInvalidActiveViewThroughControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const select = document.querySelector('#activeViewSelect') as HTMLSelectElement | null;
    const activeViewId = localStorage.getItem('tabatlas.workspace.activeViewId') ?? '';
    if (!activeViewId) return;
    const optionExists = Boolean(select && Array.from(select.options).some(option => option.value === activeViewId));
    if (optionExists) return;
    if (select) {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    localStorage.setItem('tabatlas.workspace.activeViewId', '');
    localStorage.setItem('tabatlas.workspace.focusedSectionId', '');
    localStorage.setItem('tabatlas.workspace.selectedTargetKind', '');
    localStorage.setItem('tabatlas.workspace.selectedTargetId', '');
  });
}

async function refreshViewsThroughUi(page: Page): Promise<void> {
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/views') && response.request().method() === 'GET', { timeout: 10_000 }).catch(() => undefined),
    page.locator('#refreshButton').click({ timeout: 10_000 }),
  ]);
}

async function selectViewOptionThroughControl(page: Page, viewId: string): Promise<void> {
  await page.waitForFunction((id) => {
    const select = document.querySelector('#activeViewSelect') as HTMLSelectElement | null;
    if (!select) return false;
    const option = Array.from(select.options).find(item => item.value === id);
    if (!option) return false;
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, viewId, { timeout: 15_000 });
}

async function waitForViewOption(page: Page, viewId: string, timeoutMs: number, throwOnTimeout = false): Promise<boolean> {
  const wait = page.waitForFunction((id) => {
    const select = document.querySelector('#activeViewSelect');
    return Boolean(select && Array.from(select.querySelectorAll('option')).some(option => option.value === id));
  }, viewId, { timeout: timeoutMs }).then(() => true);
  if (throwOnTimeout) return wait;
  return wait.catch(() => false);
}

async function clickLayout(page: Page, label: 'Board' | 'Gallery' | 'Map' | 'Compact'): Promise<void> {
  await page.getByTestId('view-toolbar').getByRole('button', { name: label }).click();
}

async function expectVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 15_000 });
}

async function expectText(locator: Locator, pattern: RegExp): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 15_000 });
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const text = await locator.innerText().catch(() => '');
    if (pattern.test(text)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for text ${pattern}`);
}

async function cardMetrics(page: Page): Promise<{ total: number; identifiable: number; userSignals: number }> {
  return page.locator('.resource-card').evaluateAll(cards => {
    const total = cards.length;
    const userSignals = cards.filter(card => card.querySelector('.user-signal')).length;
    const identifiable = cards.filter(card => {
      const text = card.textContent ?? '';
      return Boolean(card.querySelector('.card-media'))
        && /User note|AI analysis|Verified content|Title only|Prior correction|Strong match|Weak match|Needs review/i.test(text)
        && /matches|evidence|User annotation|local title|derived|reference|capture/i.test(text);
    }).length;
    return { total, identifiable, userSignals };
  });
}

async function activeViewId(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('tabatlas.workspace.activeViewId') ?? '');
}

async function processReviewItems(page: Page, countToProcess: number): Promise<void> {
  await page.getByTestId('nav-review').click();
  await expectVisible(page.getByTestId('review-workspace'));
  for (let index = 0; index < countToProcess; index += 1) {
    if (!await page.locator('[data-review-decision="important"]').isVisible().catch(() => false)) break;
    const decision = index === countToProcess - 1 ? 'ignore' : index % 2 === 0 ? 'watch_later' : 'important';
    await page.locator('#reviewNote').fill(`Opened-for-later role-play decision ${index + 1}.`);
    await page.locator(`[data-review-decision="${decision}"]`).click({ timeout: 10_000 });
    await page.waitForTimeout(150);
  }
}

async function ensureReviewLane(page: Page): Promise<void> {
  await page.getByTestId('nav-review').click();
  await expectVisible(page.getByTestId('review-workspace'));
  if (await page.locator('[data-review-decision="important"]').isVisible().catch(() => false)) return;
  const start = page.locator('[data-review-start="unmarked"]');
  if (await start.isVisible().catch(() => false)) {
    await start.click();
    await expectVisible(page.locator('[data-review-decision="important"]'));
    return;
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('nav-review').click();
  if (await page.locator('[data-review-decision="important"]').isVisible().catch(() => false)) return;
  if (await start.isVisible().catch(() => false)) {
    await start.click();
    await expectVisible(page.locator('[data-review-decision="important"]'));
    return;
  }
  throw new Error('Review lane could not be opened through visible UI controls.');
}

function check(name: string, passed: boolean, critical = false, detail?: string): VerificationCheck {
  return { name, passed, critical, detail };
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function attributeSelector(name: string, value: string): string {
  return `[${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

function viewEvidenceById(viewId: string): RoleplayViewEvidence | null {
  if (!viewId) return null;
  const db = openDatabase(cloneDb);
  try {
    const row = db.prepare(`
      SELECT v.id, v.name, v.query_json, s.goal, s.section_rules_json
      FROM views v
      LEFT JOIN semantic_view_specs s ON s.view_id = v.id
      WHERE v.id = ?
      ORDER BY v.rowid DESC
      LIMIT 1
    `).get(viewId) as {
      id: string;
      name: string;
      query_json: string | null;
      goal: string | null;
      section_rules_json: string | null;
    } | undefined;
    return row ? toViewEvidence(row) : null;
  } finally {
    db.close();
  }
}

function latestViewEvidenceSince(previousViews: number): RoleplayViewEvidence | null {
  const rows = viewEvidenceSince(previousViews);
  return rows.length ? rows[rows.length - 1] : null;
}

function findViewWithSectionMatchesSince(
  previousViews: number,
  expectedSections: string[],
  minimumMatches: number,
): RoleplayViewEvidence | null {
  const scored = viewEvidenceSince(previousViews)
    .map(view => ({
      view,
      matches: expectedSections.filter(section => view.sections.join(' ').toLowerCase().includes(section.toLowerCase())),
    }))
    .filter(item => item.matches.length >= minimumMatches)
    .sort((a, b) => b.matches.length - a.matches.length);
  return scored[0]?.view ?? null;
}

function findViewByTextSince(previousViews: number, pattern: RegExp): RoleplayViewEvidence | null {
  const rows = viewEvidenceSince(previousViews);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const view = rows[index];
    const searchable = `${view.name} ${view.commandText} ${view.goal} ${view.sections.join(' ')}`;
    if (pattern.test(searchable)) return view;
  }
  return null;
}

function latestActionResultViewEvidenceSince(previousActions: number, kinds: string[]): RoleplayViewEvidence | null {
  const viewIds = actionResultViewIdsSince(previousActions, kinds);
  for (let index = viewIds.length - 1; index >= 0; index -= 1) {
    const evidence = viewEvidenceById(viewIds[index]);
    if (evidence) return evidence;
  }
  return null;
}

function actionResultViewIdsSince(previousActions: number, kinds: string[]): string[] {
  const db = openDatabase(cloneDb);
  try {
    const rows = db.prepare(`
      SELECT action_kind, result_json
      FROM agent_actions
      ORDER BY rowid
      LIMIT -1 OFFSET ?
    `).all(previousActions) as Array<{ action_kind: string; result_json: string | null }>;
    return rows
      .filter(row => kinds.includes(row.action_kind) && row.result_json)
      .flatMap(row => extractViewIdsFromUnknown(parseJsonRecord(row.result_json)));
  } finally {
    db.close();
  }
}

function extractViewIdsFromUnknown(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(item => extractViewIdsFromUnknown(item));
  const record = value as Record<string, unknown>;
  const direct = typeof record.viewId === 'string' ? [record.viewId] : [];
  const plural = Array.isArray(record.viewIds) ? record.viewIds.filter((item): item is string => typeof item === 'string') : [];
  const previewIds = Array.isArray(record.previews) ? extractViewIdsFromUnknown(record.previews) : [];
  return [...direct, ...plural, ...previewIds];
}

function viewEvidenceSince(previousViews: number): RoleplayViewEvidence[] {
  const db = openDatabase(cloneDb);
  try {
    const rows = db.prepare(`
      SELECT v.id, v.name, v.query_json, s.goal, s.section_rules_json
      FROM views v
      LEFT JOIN semantic_view_specs s ON s.view_id = v.id
      ORDER BY v.rowid
      LIMIT -1 OFFSET ?
    `).all(previousViews) as Array<{
      id: string;
      name: string;
      query_json: string | null;
      goal: string | null;
      section_rules_json: string | null;
    }>;
    return rows.map(toViewEvidence);
  } finally {
    db.close();
  }
}

function toViewEvidence(row: {
  id: string;
  name: string;
  query_json: string | null;
  goal: string | null;
  section_rules_json: string | null;
}): RoleplayViewEvidence {
  const query = parseJsonRecord(row.query_json);
  return {
    id: row.id,
    name: row.name,
    commandText: typeof query.commandText === 'string' ? query.commandText : '',
    goal: row.goal ?? '',
    sections: parseStringArray(row.section_rules_json),
  };
}

function resourceCount(dbPath: string): number {
  const db = openDatabase(dbPath);
  try {
    return count(db, 'resources');
  } finally {
    db.close();
  }
}

function latestReviewSessionIds(dbPath: string, limit: number): string[] {
  const db = openDatabase(dbPath);
  try {
    return (db.prepare('SELECT id FROM review_sessions ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ id: string }>).map(row => row.id);
  } finally {
    db.close();
  }
}

function readTargetFeedbackScopeInView(dbPath: string, viewId: string, targetId: string): { feedbackApplied: boolean; detail: string } {
  if (!viewId || !targetId) return { feedbackApplied: false, detail: 'target absent' };
  const db = openDatabase(dbPath);
  try {
    const row = db.prepare(`
      SELECT state, evidence_refs, reason, conflict_note
      FROM memberships
      WHERE view_id = ? AND target_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(viewId, targetId) as {
      state: string;
      evidence_refs: string;
      reason: string | null;
      conflict_note: string | null;
    } | undefined;
    if (!row) return { feedbackApplied: false, detail: 'target absent' };
    const refs = parseStringArray(row.evidence_refs);
    const feedbackApplied = refs.some(ref => ref.startsWith('feedback:'))
      || /user (?:previous )?feedback|previously pinned|prior correction|current intent/i.test(`${row.reason ?? ''} ${row.conflict_note ?? ''}`);
    return {
      feedbackApplied,
      detail: `unrelatedState=${row.state}; feedbackApplied=${feedbackApplied}; evidenceRefs=${refs.filter(ref => ref.startsWith('feedback:')).join(',') || '(none)'}`,
    };
  } finally {
    db.close();
  }
}

function latestActionEvidence(dbPath: string, previousActions: number, kind: string): { bounded: boolean; detail: string } {
  const db = openDatabase(dbPath);
  try {
    const rows = db.prepare(`
      SELECT id, action_kind, status, action_json, result_json
      FROM agent_actions
      ORDER BY rowid
      LIMIT -1 OFFSET ?
    `).all(previousActions) as Array<{
      id: string;
      action_kind: string;
      status: string;
      action_json: string;
      result_json: string | null;
    }>;
    const matches = rows.filter(row => row.action_kind === kind);
    const match = matches.length ? matches[matches.length - 1] : undefined;
    if (!match) return { bounded: false, detail: 'no action found' };
    const action = JSON.parse(match.action_json) as { resourceIds?: unknown[]; limit?: unknown };
    const result = match.result_json ? JSON.parse(match.result_json) as { job?: { id?: string } } : {};
    const resourceCount = Array.isArray(action.resourceIds) ? action.resourceIds.length : 0;
    const bounded = match.status === 'succeeded'
      && resourceCount > 0
      && resourceCount <= 20
      && typeof result.job?.id === 'string';
    return {
      bounded,
      detail: `id=${match.id}; status=${match.status}; resourceIds=${resourceCount}; job=${result.job?.id ?? '(none)'}`,
    };
  } finally {
    db.close();
  }
}

async function openSettingsPanel(page: Page, panel: string): Promise<void> {
  await page.locator('.secondary-nav').evaluate(element => {
    if (element instanceof HTMLDetailsElement) element.open = true;
  });
  await page.locator(`.secondary-nav-list [data-settings-panel="${panel}"]`).click({ timeout: 10_000 });
  await page.waitForSelector(`#page-settings.active #settings-${panel}`, { state: 'visible', timeout: 10_000 });
}

async function runProductBrowserCapture(input: {
  browserName: ProductBrowser;
  fixtureBaseUrl: string;
  challengeId: string;
  secret: string;
  headless: boolean;
}): Promise<Omit<BrowserCapture, 'challengeId' | 'capabilityId' | 'snapshotId'>> {
  const extensionDir = extensionDirectory();
  const executable = productBrowserExecutable(input.browserName);
  const executablePathHash = sha256Text(path.resolve(executable).toLowerCase());
  const debuggingPort = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `tabatlas-roleplay-${input.browserName}-`));
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    child = launchProductBrowser({ executable, userDataDir, debuggingPort, headless: input.headless });
    await waitForDebuggingPort(debuggingPort, child, 30_000);
    const executableVersion = await browserVersion(debuggingPort);
    const extensionId = await loadUnpackedExtension(debuggingPort, extensionDir);
    await waitForExtensionWorker(debuggingPort, extensionId, 30_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Product browser CDP connection did not expose a context');
    const tabs = safeFixtureTabs(input.browserName, input.fixtureBaseUrl);
    for (const tab of tabs) {
      const page = await context.newPage();
      await page.goto(tab.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    }
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await pairPopup(popup, baseUrl, input.challengeId, input.secret);
    return {
      browser: input.browserName,
      executableVersion,
      executablePathHash,
      extensionId,
      tabsOpened: tabs.length,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await stopProductBrowser(child, userDataDir);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

function startRoleplayReceiver(): ChildProcess {
  const log = fs.createWriteStream(path.join(workdir, 'roleplay-receiver.log'), { flags: 'a' });
  const child = spawn(process.execPath, [tsx, 'src/server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      TABATLAS_RUNTIME_PROFILE: 'roleplay',
      TABATLAS_PORT: String(port),
      TABATLAS_DB: cloneDb,
      TABATLAS_BOOTSTRAP_DIR: bootstrapDir,
      TABATLAS_INSTANCE_NAME: 'prehuman-roleplay-rc3',
      TABATLAS_CAPTURE_ROOTS: workdir,
      TABATLAS_WORKER_POLL_MS: '60000',
      TABATLAS_ROLEPLAY_PROVIDER: roleplayProvider,
      TABATLAS_ROLEPLAY_GATE: roleplayGate,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once('exit', () => log.end());
  return child;
}

async function cloneSourceDatabase(): Promise<void> {
  const child = spawn(process.execPath, [
    tsx,
    'scripts/environment-clone.ts',
    '--source',
    source,
    '--destination',
    cloneDb,
    '--environment',
    'clone',
    ...(opts.replace ? ['--replace'] : []),
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logPath = path.join(workdir, 'environment-clone.log');
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  log.end();
  if (code !== 0) throw new Error(`environment-clone failed; see ${logPath}`);
}

async function productionReceiverGuard(_databasePath: string, databaseId: string): Promise<ProductionReceiverGuardState> {
  const health = await readHealth(9787);
  const productionPortOccupied = health ? true : !(await canBind(9787));
  return evaluateProductionReceiverGuard({
    health,
    expectedDatabaseId: databaseId,
    productionPortOccupied,
    productionPort: 9787,
  });
}

async function readHealth(targetPort: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${targetPort}/health`);
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function waitForHealth(child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Role-play receiver exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Wait for receiver startup.
    }
    await delay(250);
  }
  throw new Error(`Role-play receiver did not become healthy on ${port}.`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (child.connected) child.send('tabatlas:shutdown');
  else child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(3000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForBootstrapSecret(directory: string, timeoutMs: number): Promise<string> {
  const filePath = path.join(directory, 'tabatlas-bootstrap-secret.txt');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const secret = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('boot_'));
      if (secret) return secret;
    }
    await delay(250);
  }
  throw new Error(`Bootstrap secret was not written to ${filePath}`);
}

function parsePairing(raw: string): { challengeId: string; secret: string } {
  const parsed = JSON.parse(raw) as { challenge?: { id?: string }; secret?: string };
  const challengeId = parsed.challenge?.id ?? '';
  const secret = parsed.secret ?? '';
  if (!challengeId || !secret) throw new Error(`Pairing UI did not expose a challenge and secret: ${raw}`);
  return { challengeId, secret };
}

async function pairPopup(page: Page, receiverUrl: string, challengeId: string, secret: string): Promise<void> {
  await page.fill('#receiver', receiverUrl);
  await page.fill('#challengeId', challengeId);
  await page.fill('#secret', secret);
  await page.click('#pair');
  await page.waitForFunction(() => {
    const message = document.querySelector('#message')?.textContent?.toLowerCase() ?? '';
    const status = document.querySelector('#status')?.textContent?.toLowerCase() ?? '';
    return message.includes('paired') && status.includes('paired') && !status.includes('unpaired');
  }, undefined, { timeout: 30_000 });
}

function latestSnapshotId(dbPath: string): string {
  const id = latestSnapshotIdOrNull(dbPath);
  if (!id) throw new Error('No snapshot was recorded');
  return id;
}

function latestSnapshotIdOrNull(dbPath: string): string {
  const db = openDatabase(dbPath);
  try {
    const row = db.prepare('SELECT id FROM snapshots ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined;
    return row?.id ?? '';
  } finally {
    db.close();
  }
}

async function waitForNewSnapshot(previousId: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = latestSnapshotIdOrNull(cloneDb);
    if (current && current !== previousId) return;
    await delay(500);
  }
  throw new Error('Snapshot did not arrive from extension popup.');
}

function challengeCapabilityId(dbPath: string, challengeId: string): string {
  const db = openDatabase(dbPath);
  try {
    const row = db.prepare('SELECT capability_id FROM pairing_challenges WHERE id = ?').get(challengeId) as { capability_id: string | null } | undefined;
    if (!row?.capability_id) throw new Error(`Pairing challenge ${challengeId} did not create a capability`);
    return row.capability_id;
  } finally {
    db.close();
  }
}

function reviewDecisionCounts(dbPath: string): {
  total: number;
  inspiration: number;
  projectReference: number;
  watchLater: number;
  ignore: number;
  needsDeeperRead: number;
  skipped: number;
  annotationIds: string[];
  sessionIds: string[];
} {
  const db = openDatabase(dbPath);
  try {
    const annotations = db.prepare(`
      SELECT id, decision, tags_json
      FROM user_annotations
      WHERE source = 'focused_review'
    `).all() as Array<{ id: string; decision: string; tags_json: string }>;
    const skipped = (db.prepare("SELECT COUNT(*) AS count FROM review_session_items WHERE status = 'skipped'").get() as { count: number }).count;
    const sessions = db.prepare('SELECT id FROM review_sessions ORDER BY created_at DESC LIMIT 5').all() as Array<{ id: string }>;
    return {
      total: annotations.length,
      inspiration: annotations.filter(row => row.decision === 'inspiration').length,
      projectReference: annotations.filter(row => row.decision === 'project_reference').length,
      watchLater: annotations.filter(row => row.decision === 'watch_later').length,
      ignore: annotations.filter(row => row.decision === 'ignore').length,
      needsDeeperRead: annotations.filter(row => row.tags_json.includes('needs-deeper-read')).length,
      skipped,
      annotationIds: annotations.map(row => row.id),
      sessionIds: sessions.map(row => row.id),
    };
  } finally {
    db.close();
  }
}

function reviewSessionCount(dbPath: string): number {
  const db = openDatabase(dbPath);
  try {
    return count(db, 'review_sessions');
  } finally {
    db.close();
  }
}

function conversationCounts(dbPath: string): { messages: number; actions: number; views: number; threads: number } {
  const db = openDatabase(dbPath);
  try {
    return {
      messages: count(db, 'conversation_messages'),
      actions: count(db, 'agent_actions'),
      views: count(db, 'views'),
      threads: count(db, 'conversation_threads'),
    };
  } finally {
    db.close();
  }
}

async function waitForConversationAdvance(previousMessages: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const counts = conversationCounts(cloneDb);
    if (counts.messages >= previousMessages + 2) return;
    await delay(1000);
  }
  throw new Error('Conversation did not receive an assistant response before timeout.');
}

function actionIdsSince(previousActions: number): string[] {
  const db = openDatabase(cloneDb);
  try {
    return (db.prepare('SELECT id FROM agent_actions ORDER BY rowid LIMIT -1 OFFSET ?').all(previousActions) as Array<{ id: string }>).map(row => row.id);
  } finally {
    db.close();
  }
}

function viewIdsSince(previousViews: number): string[] {
  const db = openDatabase(cloneDb);
  try {
    return (db.prepare('SELECT id FROM views ORDER BY rowid LIMIT -1 OFFSET ?').all(previousViews) as Array<{ id: string }>).map(row => row.id);
  } finally {
    db.close();
  }
}

function threadIdsSince(previousThreads: number): string[] {
  const db = openDatabase(cloneDb);
  try {
    return (db.prepare('SELECT id FROM conversation_threads ORDER BY rowid LIMIT -1 OFFSET ?').all(previousThreads) as Array<{ id: string }>).map(row => row.id);
  } finally {
    db.close();
  }
}

async function waitForActionsQuiescentSince(previousActions: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const states = actionStatesSince(previousActions);
    const inFlight = states.filter(action => action.status === 'running'
      || action.status === 'approved'
      || (action.status === 'proposed' && action.approval !== 'confirm'));
    if (!inFlight.length) return;
    await delay(750);
  }
  const states = actionStatesSince(previousActions);
  throw new Error(`Timed out waiting for agent actions to settle: ${JSON.stringify(states)}`);
}

async function waitForActionKindsSince(previousActions: number, requiredKinds: string[], timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const presentKinds = new Set(actionStatesSince(previousActions).map(action => action.kind));
    if (requiredKinds.every(kind => presentKinds.has(kind))) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for required action kinds: ${requiredKinds.join(', ')}`);
}

async function waitForTerminalActionKindSince(previousActions: number, kind: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const matching = actionStatesSince(previousActions).filter(action => action.kind === kind);
    const latest = matching.length ? matching[matching.length - 1] : undefined;
    if (latest && ['succeeded', 'failed', 'cancelled'].includes(latest.status)) return;
    await delay(750);
  }
  const states = actionStatesSince(previousActions).filter(action => action.kind === kind);
  throw new Error(`Timed out waiting for terminal ${kind} action: ${JSON.stringify(states)}`);
}

async function waitForReviewActionOrSessionSince(
  previousActions: number,
  previousReviewSessions: number,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hasReviewAction = actionStatesSince(previousActions).some(action => action.kind === 'start_review');
    if (hasReviewAction || reviewSessionCount(cloneDb) > previousReviewSessions) return;
    await delay(750);
  }
  throw new Error('Timed out waiting for a review action or visible review session.');
}

function actionStatesSince(previousActions: number): Array<{ id: string; status: string; approval: string; kind: string }> {
  const db = openDatabase(cloneDb);
  try {
    return db.prepare(`
      SELECT id, status, approval, action_kind AS kind
      FROM agent_actions
      ORDER BY rowid
      LIMIT -1 OFFSET ?
    `).all(previousActions) as Array<{ id: string; status: string; approval: string; kind: string }>;
  } finally {
    db.close();
  }
}

function proposedConfirmActionsSince(
  previousActions: number,
  requiredKinds: string[],
): Array<{ id: string; status: string; approval: string; kind: string }> {
  return actionStatesSince(previousActions)
    .filter(action => requiredKinds.includes(action.kind) && action.status === 'proposed' && action.approval === 'confirm');
}

function readVerificationSummary(dbPath: string): {
  conversations: number;
  views: number;
  reviewDecisions: number;
  orphanAutomaticActions: Array<{ id: string; status: string; approval: string; kind: string }>;
  expectedConfirmActions: number;
} {
  const db = openDatabase(dbPath);
  try {
    const orphans = db.prepare(`
      SELECT id, status, approval, action_kind AS kind
      FROM agent_actions
      WHERE status IN ('proposed', 'running')
        AND approval IN ('automatic', 'preview')
    `).all() as Array<{ id: string; status: string; approval: string; kind: string }>;
    const expectedConfirmActions = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_actions
      WHERE status = 'proposed' AND approval = 'confirm'
    `).get() as { count: number }).count;
    return {
      conversations: count(db, 'conversation_threads'),
      views: count(db, 'views'),
      reviewDecisions: countWhere(db, 'user_annotations', "source = 'focused_review'"),
      orphanAutomaticActions: orphans,
      expectedConfirmActions,
    };
  } finally {
    db.close();
  }
}

function count(db: ReturnType<typeof openDatabase>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function countWhere(db: ReturnType<typeof openDatabase>, table: string, where: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
}

function storyResult(input: {
  story: string;
  elapsedMs: number;
  primaryClicks: number;
  screenshots: string[];
  helpRequired: StoryResult['helpRequired'];
  issues: string[];
  persistedResultIds: Record<string, string[]>;
  verificationChecks: VerificationCheck[];
  interactionApiBypasses: string[];
  trace?: string;
}): StoryResult {
  const scores = scoreStory(input.verificationChecks, input.issues, input.helpRequired, input.interactionApiBypasses);
  const pass = scores.taskCompletion >= 4
    && scores.visualComprehension >= 3
    && scores.discoverability >= 3
    && scores.trustControl >= 3
    && !input.issues.some(issue => /^P[01]/.test(issue))
    && input.interactionApiBypasses.length === 0;
  return {
    story: input.story,
    result: pass ? 'passed' : 'failed',
    scores,
    elapsedMs: input.elapsedMs,
    primaryClicks: input.primaryClicks,
    help: helpLabel(input.helpRequired),
    helpRequired: input.helpRequired,
    issues: input.issues,
    screenshots: input.screenshots.map(item => path.relative(workdir, item)),
    trace: input.trace,
    persistedResultIds: input.persistedResultIds,
    verificationChecks: input.verificationChecks,
    interactionApiBypasses: input.interactionApiBypasses,
  };
}

function scoreStory(
  checks: VerificationCheck[],
  issues: string[],
  helpRequired: StoryResult['helpRequired'],
  bypasses: string[],
): StoryScores {
  const critical = checks.filter(item => item.critical);
  const criticalPassed = critical.filter(item => item.passed).length;
  const optional = checks.filter(item => !item.critical);
  const optionalPassed = optional.filter(item => item.passed).length;
  const criticalMissing = critical.length > criticalPassed;
  const p0p1 = issues.some(issue => /^P[01]/.test(issue));
  const completionBase = criticalMissing ? 2 : helpRequired === 'none' ? 5 : helpRequired === 'minor' ? 4 : helpRequired === 'workaround' ? 3 : 1;
  const taskCompletion = p0p1 ? Math.min(completionBase, 2) : completionBase;
  const visualComprehension = criticalMissing
    ? 2
    : Math.max(3, Math.min(5, 3 + Math.floor(optionalPassed / Math.max(1, Math.ceil(optional.length / 2)))));
  const discoverability = bypasses.length
    ? 2
    : helpRequired === 'none'
      ? 5
      : helpRequired === 'minor'
        ? 4
        : helpRequired === 'workaround'
          ? 3
          : 1;
  const trustControl = p0p1
    ? 2
    : criticalMissing
      ? 2
      : checks.some(item => /undo|scope|evidence|unchanged|not mutated|typing/i.test(item.name) && item.passed)
        ? 5
        : 4;
  return {
    taskCompletion,
    visualComprehension,
    discoverability,
    trustControl,
  };
}

function helpLabel(helpRequired: StoryResult['helpRequired']): string {
  if (helpRequired === 'none') return 'none';
  if (helpRequired === 'minor') return 'minor hesitation; completed through visible UI controls';
  if (helpRequired === 'workaround') return 'completed with workaround';
  return 'failed during visible interaction';
}

async function screenshot(page: Page, name: string): Promise<string> {
  const filePath = path.join(screenshotsDir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => undefined);
  return filePath;
}

function renderMarkdownReport(input: {
  ok: boolean;
  gate: RoleplayGate;
  provider: RoleplayProvider;
  productionBefore: DatabaseFingerprint;
  productionAfter: DatabaseFingerprint;
  productionUnchanged: boolean;
  captures: BrowserCapture[];
  storyResults: StoryResult[];
  verification: ReturnType<typeof readVerificationSummary>;
  issues: { p0p1Issues: string[]; interactionApiBypasses?: string[] };
}): string {
  return [
    '# TabAtlas rc3 pre-human role-play',
    '',
    `Result: ${input.ok ? 'pass' : 'fail'}`,
    `Gate: ${input.gate}`,
    `Provider: ${input.provider}`,
    `Generated: ${new Date().toISOString()}`,
    `Production unchanged: ${input.productionUnchanged}`,
    `Production database ID: ${input.productionBefore.databaseId ?? '(missing)'}`,
    `Production after database ID: ${input.productionAfter.databaseId ?? '(missing)'}`,
    '',
    '## Runtime safety checks',
    '',
    `Production fingerprint unchanged: ${input.productionUnchanged}`,
    `Production before main SHA-256: ${input.productionBefore.files.main.sha256 ?? '(missing)'}`,
    `Production after main SHA-256: ${input.productionAfter.files.main.sha256 ?? '(missing)'}`,
    `Orphan automatic actions: ${input.verification.orphanAutomaticActions.length}`,
    `Interaction-phase API bypasses: ${input.issues.interactionApiBypasses?.length ?? 0}`,
    '',
    '## Browser capture',
    '',
    ...input.captures.map(capture => `- ${capture.browser}: strategy=${capture.browser === 'chrome' ? 'chrome_product_cdp' : 'edge_product_cdp'}, version=${capture.executableVersion}, challenge=${capture.challengeId}, capability=${capture.capabilityId}, snapshot=${capture.snapshotId}, tabs=${capture.tabsOpened}`),
    '',
    '## Real UI story results',
    '',
    ...input.storyResults.map(story => [
      `### ${story.story}`,
      `Result: ${story.result}`,
      `Scores: task=${story.scores.taskCompletion}, visual=${story.scores.visualComprehension}, discoverability=${story.scores.discoverability}, trust=${story.scores.trustControl}`,
      `Elapsed ms: ${story.elapsedMs}`,
      `Primary clicks: ${story.primaryClicks}`,
      `Help required: ${story.helpRequired}`,
      `Help: ${story.help}`,
      `Issues: ${story.issues.length ? story.issues.join('; ') : 'none'}`,
      `Screenshots: ${story.screenshots.join(', ')}`,
      `Trace: ${story.trace ?? '(none)'}`,
      'Verification checks:',
      ...story.verificationChecks.map(item => `- ${item.passed ? 'pass' : 'fail'}${item.critical ? ' critical' : ''}: ${item.name}${item.detail ? ` (${item.detail})` : ''}`),
      `Interaction API bypasses: ${story.interactionApiBypasses.length ? story.interactionApiBypasses.join('; ') : 'none'}`,
      '',
    ].join('\n')),
    '## Fixture evaluation results',
    '',
    '`eval:pilot-readiness` and `eval:workspace-ux` are separate regression gates. They are not counted as pre-human role-play stories in this report.',
    '',
    '## Accessibility checks',
    '',
    'Not run inside `roleplay:prehuman`; covered by the separate workspace UX regression gate.',
    '',
    '## Performance metrics',
    '',
    'Not run inside `roleplay:prehuman`; covered by the separate workspace UX large-workspace scenarios.',
    '',
    '## Verification',
    '',
    `Conversations: ${input.verification.conversations}`,
    `Views: ${input.verification.views}`,
    `Review decisions: ${input.verification.reviewDecisions}`,
    `Expected confirm actions: ${input.verification.expectedConfirmActions}`,
    `Orphan automatic actions: ${input.verification.orphanAutomaticActions.length}`,
    '',
    '## P0/P1 issues',
    '',
    input.issues.p0p1Issues.length ? input.issues.p0p1Issues.map(issue => `- ${issue}`).join('\n') : 'none',
    '',
  ].join('\n');
}

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const title = decodeURIComponent(url.pathname.split('/').filter(Boolean).join(' ') || 'TabAtlas roleplay fixture');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>Safe local TabAtlas role-play fixture.</p></body></html>`);
  });
  const fixturePort = await freePort();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(fixturePort, '127.0.0.1', () => resolve());
  });
  return {
    url: `http://127.0.0.1:${fixturePort}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function safeFixtureTabs(browserName: ProductBrowser, base: string): Array<{ title: string; url: string }> {
  const labels = [
    'extension popup capture safety',
    'receiver startup runtime health',
    'codex planner thread reuse',
    'sqlite wal storage identity',
    'evidence extraction queue',
    'video transcript availability',
    'token security capability rotation',
    'ux review workspace layout',
    'installation bootstrap path',
    'release packaging hashes',
    'acceptance testing matrix',
    'visual inspiration forest board',
    'watch later opened later queue',
    'skeptical curator conflict item',
  ];
  return labels.map((label, index) => ({
    title: `${browserName} ${label}`,
    url: `${base}/${browserName}/${index}-${encodeURIComponent(label)}`,
  }));
}

function extensionDirectory(): string {
  const packaged = path.join(root, 'release', 'tabatlas-extension');
  if (fs.existsSync(path.join(packaged, 'manifest.json'))) return packaged;
  return path.join(root, 'extension');
}

function productBrowserExecutable(browserName: ProductBrowser): string {
  const candidates = browserName === 'chrome'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : [
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`${browserName} executable was not found`);
  return found;
}

function launchProductBrowser(input: {
  executable: string;
  userDataDir: string;
  debuggingPort: number;
  headless: boolean;
}): ChildProcess {
  return spawn(input.executable, [
    `--user-data-dir=${input.userDataDir}`,
    `--remote-debugging-port=${input.debuggingPort}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationGuideModelDownloading,OptimizationHintsFetching',
    ...(input.headless ? ['--headless=new'] : []),
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
}

async function waitForDebuggingPort(debuggingPort: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Product browser exited early with code ${child.exitCode}`);
    if (await canFetchJson(`http://127.0.0.1:${debuggingPort}/json/version`)) return;
    await delay(500);
  }
  throw new Error(`Product browser debugging port did not open on ${debuggingPort}`);
}

async function browserVersion(debuggingPort: number): Promise<string> {
  const version = await fetchJson<{ Browser?: string }>(`http://127.0.0.1:${debuggingPort}/json/version`);
  return version.Browser ?? 'unknown-product-browser';
}

async function loadUnpackedExtension(debuggingPort: number, extensionDir: string): Promise<string> {
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${debuggingPort}/json/version`);
  if (!version.webSocketDebuggerUrl) throw new Error('Product browser did not expose a browser debugging websocket');
  const response = await sendBrowserCdp<{ id?: string }>(version.webSocketDebuggerUrl, 'Extensions.loadUnpacked', { path: extensionDir });
  if (!response.id) throw new Error('Extensions.loadUnpacked did not return an extension ID');
  return response.id;
}

async function waitForExtensionWorker(debuggingPort: number, extensionId: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await fetchDebugTargets(debuggingPort).catch(() => []);
    const worker = targets.find(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`));
    if (worker) return;
    await delay(500);
  }
  throw new Error('Product browser did not start the TabAtlas extension service worker');
}

async function sendBrowserCdp<T>(webSocketUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
  const socket = new WebSocket(webSocketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error(`Unable to open browser debugging websocket for ${method}`));
  });
  try {
    const message = await new Promise<{ result?: T; error?: { message?: string } }>((resolve, reject) => {
      socket.onmessage = event => {
        try {
          resolve(JSON.parse(String(event.data)) as { result?: T; error?: { message?: string } });
        } catch (error) {
          reject(error);
        }
      };
      socket.onerror = () => reject(new Error(`Browser debugging websocket failed for ${method}`));
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
    if (message.error) throw new Error(message.error.message ?? `${method} failed`);
    if (!message.result) throw new Error(`${method} did not return a result`);
    return message.result;
  } finally {
    socket.close();
  }
}

async function fetchDebugTargets(debuggingPort: number): Promise<Array<{ type: string; url: string }>> {
  const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`);
  return await response.json() as Array<{ type: string; url: string }>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function canFetchJson(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function stopProductBrowser(child: ChildProcess | undefined, userDataDir: string): Promise<void> {
  if (child) {
    child.kill();
    await delay(1000);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (process.platform !== 'win32') return;
  const escaped = userDataDir.replace(/'/g, "''");
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ], { stdio: 'ignore', windowsHide: true });
}

async function canBind(targetPort: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(targetPort, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port);
        else reject(new Error('Unable to reserve a free port'));
      });
    });
  });
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
