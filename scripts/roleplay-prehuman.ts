import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { openDatabase } from '../src/db/index.js';
import { readDatabaseIdentity } from '../src/runtime/databaseIdentity.js';
import { fingerprintDatabase, sameDatabaseFingerprint, type DatabaseFingerprint } from '../src/runtime/databaseFingerprint.js';

type ProductBrowser = 'chrome' | 'edge';

type StoryResult = {
  story: string;
  result: 'passed' | 'failed';
  scores: {
    taskCompletion: number;
    visualComprehension: number;
    discoverability: number;
    trustControl: number;
  };
  elapsedMs: number;
  primaryClicks: number;
  help: string;
  issues: string[];
  screenshots: string[];
  trace?: string;
  persistedResultIds: Record<string, string[]>;
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

type ProductionReceiverState = {
  wasRunning: boolean;
  stopped: boolean;
  restarted: boolean;
  health?: Record<string, unknown>;
};

const program = new Command();
program
  .option('--source <path>', 'Production/source database path', path.join('data', 'tabatlas.sqlite'))
  .option('--workdir <path>', 'Local role-play evidence directory', path.join('.local', 'prehuman-roleplay-rc3'))
  .option('--port <port>', 'Role-play receiver port', '9786')
  .option('--replace', 'Replace an existing role-play clone')
  .option('--headful', 'Run the app and product browsers headed')
  .option('--story-timeout-ms <ms>', 'Per-story interaction timeout', '180000')
  .parse(process.argv);

const opts = program.opts<{ source: string; workdir: string; port: string; replace?: boolean; headful?: boolean; storyTimeoutMs: string }>();
const root = process.cwd();
const source = path.resolve(root, opts.source);
const workdir = path.resolve(root, opts.workdir);
const cloneDb = path.join(workdir, 'roleplay.sqlite');
const bootstrapDir = path.join(workdir, 'bootstrap');
const screenshotsDir = path.join(workdir, 'screenshots');
const tracesDir = path.join(workdir, 'traces');
const appProfileDir = path.join(workdir, 'app-browser-profile');
const port = Number(opts.port);
const baseUrl = `http://127.0.0.1:${port}`;
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const storyTimeoutMs = Number(opts.storyTimeoutMs);

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

const productionReceiver = await stopProductionReceiverIfRunning(source, productionIdentity.databaseId);
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
  storyResults.push(await runReviewSeeding(appPage));
  storyResults.push(await runConversationStory(appContext, appPage, {
    story: 'Creative Collector',
    prompt: 'Make a visual inspiration board from the captured tabs. Keep personal inspiration, visual references, game inspiration, and cross-domain references visible.',
    expectedPattern: /inspiration|visual|board|preview/i,
  }));
  storyResults.push(await runConversationStory(appContext, appPage, {
    story: 'Project Builder',
    prompt: 'Build a TabAtlas project board with sections extension, receiver, Codex, storage, extraction, transcripts, security, UX, installation, packaging, testing.',
    expectedPattern: /extension|receiver|codex|storage|security|testing/i,
  }));
  storyResults.push(await runConversationStory(appContext, appPage, {
    story: 'Knowledge Miner',
    prompt: 'What do we know inside these videos? Separate known atomic items, transcripts, metadata-only videos, unavailable transcripts, and one bounded evidence-improvement action.',
    expectedPattern: /Known atomic items|metadata|transcript|bounded|evidence/i,
  }));
  storyResults.push(await runConversationStory(appContext, appPage, {
    story: 'Skeptical Curator',
    prompt: 'Review weak or conflicting items in the current workspace and keep the correction scope narrow.',
    expectedPattern: /review|weak|conflict|uncertain|correction/i,
  }));
  storyResults.push(await runConversationStory(appContext, appPage, {
    story: 'Opened for Later',
    prompt: 'Find the tabs I marked watch later and make them easy to return to without mixing them into unrelated project material.',
    expectedPattern: /watch later|return|marked|tabs/i,
  }));
  storyResults.push(await runReturningUserStory(appContext!, appPage!, receiver!));
} finally {
  await appContext?.close().catch(() => undefined);
  if (receiver) await stopProcess(receiver);
  await fixtureServer.close();
  if (productionReceiver.wasRunning) {
    productionReceiver.restarted = await restartProductionReceiver(source).catch(() => false);
  }
}

const productionAfter = fingerprintDatabase(source);
const cloneAfter = fingerprintDatabase(cloneDb);
const verification = readVerificationSummary(cloneDb);
const productionUnchanged = sameDatabaseFingerprint(productionBefore, productionAfter);
const automaticOrphans = verification.orphanAutomaticActions;
const p0p1Issues = [
  ...storyResults.flatMap(story => story.issues.filter(issue => /^P[01]/.test(issue))),
  ...(productionUnchanged ? [] : ['P0 production fingerprint changed during role-play']),
  ...(automaticOrphans.length ? ['P1 orphan automatic actions remained after role-play'] : []),
];
const ok = !p0p1Issues.length
  && productionUnchanged
  && storyResults.every(story => story.result === 'passed'
    && story.scores.taskCompletion >= 4
    && story.scores.visualComprehension >= 3
    && story.scores.discoverability >= 3
    && story.scores.trustControl >= 3);

const metrics = {
  generatedAt: new Date().toISOString(),
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
  orphanAutomaticActions: automaticOrphans,
};
const reportPath = path.join(workdir, 'report-redacted.md');
const metricsPath = path.join(workdir, 'metrics-redacted.json');
const issuesPath = path.join(workdir, 'issues-redacted.json');
fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
fs.writeFileSync(issuesPath, JSON.stringify(issues, null, 2));
fs.writeFileSync(reportPath, renderMarkdownReport({
  ok,
  productionBefore,
  productionAfter,
  productionUnchanged,
  captures,
  storyResults,
  verification,
  issues,
}));
console.log(JSON.stringify({ ok, reportPath, metricsPath, issuesPath, stories: storyResults.map(story => ({ story: story.story, result: story.result, scores: story.scores })) }, null, 2));
if (!ok) process.exit(1);

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
    pass,
    elapsedMs: Date.now() - started,
    primaryClicks: clicks,
    screenshots,
    help: pass ? 'Seeded review decisions through the Review UI.' : 'Review seeding did not satisfy required decision mix.',
    issues,
    persistedResultIds: { annotations: counts.annotationIds, reviewSessions: counts.sessionIds },
  });
}

async function runConversationStory(
  context: BrowserContext,
  page: Page,
  input: { story: string; prompt: string; expectedPattern: RegExp },
): Promise<StoryResult> {
  const started = Date.now();
  const before = conversationCounts(cloneDb);
  const tracePath = path.join(tracesDir, `${slug(input.story)}.zip`);
  await context.tracing.start({ screenshots: true, snapshots: true });
  let clicks = 0;
  const issues: string[] = [];
    const screenshots: string[] = [];
    try {
      await page.getByTestId('nav-ask').click(); clicks += 1;
      await page.locator('#conversationTab').click().catch(() => undefined);
      await page.waitForSelector('#conversationSurface.active #conversationInput', { state: 'visible', timeout: 10_000 });
      await page.locator('#conversationInput').fill(input.prompt);
    await page.getByTestId('conversation-form').locator('button[type="submit"]').click(); clicks += 1;
    await waitForConversationAdvance(before.messages, storyTimeoutMs);
    await page.waitForTimeout(500);
    await confirmVisibleConfirmActions(page);
    const text = await page.locator('#conversationThread').innerText();
    const actionIds = actionIdsSince(before.actions);
    if (!input.expectedPattern.test(text)) issues.push(`P2 expected visible story signal not found for ${input.story}`);
    screenshots.push(await screenshot(page, slug(input.story)));
    return storyResult({
      story: input.story,
      pass: !issues.some(issue => /^P[01]/.test(issue)),
      elapsedMs: Date.now() - started,
      primaryClicks: clicks,
      screenshots,
      trace: path.relative(workdir, tracePath),
      help: issues.length ? 'Story completed with review notes.' : 'Story completed through the conversation and workspace UI.',
      issues,
      persistedResultIds: {
        actions: actionIds,
        views: viewIdsSince(before.views),
        conversations: threadIdsSince(before.threads),
      },
    });
  } catch (error) {
    issues.push(`P1 ${input.story} interaction failed: ${error instanceof Error ? error.message : String(error)}`);
    screenshots.push(await screenshot(page, `${slug(input.story)}-failed`).catch(() => ''));
    return storyResult({
      story: input.story,
      pass: false,
      elapsedMs: Date.now() - started,
      primaryClicks: clicks,
      screenshots: screenshots.filter(Boolean),
      trace: path.relative(workdir, tracePath),
      help: 'Story failed during UI interaction.',
      issues,
      persistedResultIds: {},
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
  await page.getByTestId('nav-views').click();
  await page.evaluate(() => {
    localStorage.setItem('tabatlas.workspace.layout', 'gallery');
    localStorage.setItem('tabatlas.workspace.page', 'views');
    localStorage.setItem('tabatlas.workspace.workspaceQuery', 'security');
  });
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
    query: localStorage.getItem('tabatlas.workspace.workspaceQuery'),
    thread: localStorage.getItem('tabatlas.workspace.activeThreadId'),
    reviewSession: localStorage.getItem('tabatlas.workspace.reviewSessionId'),
  }));
  screenshots.push(await screenshot(appPage, 'returning-user-after'));
  const pass = restored.page === 'views'
    && restored.layout === 'gallery'
    && restored.query === 'security'
    && Boolean(restored.thread)
    && Boolean(restored.reviewSession);
  if (!pass) issues.push(`P1 returning user state did not restore: ${JSON.stringify(restored)}`);
  return storyResult({
    story: 'Returning User',
    pass,
    elapsedMs: Date.now() - started,
    primaryClicks: 1,
    screenshots,
    help: pass ? 'Restarted clone receiver and app browser, then restored prior workspace state.' : 'Restart restoration was incomplete.',
    issues,
    persistedResultIds: { localStorage: Object.values(restored).filter((value): value is string => typeof value === 'string' && Boolean(value)) },
  });
}

async function confirmVisibleConfirmActions(page: Page): Promise<void> {
  const buttons = page.locator('[data-agent-confirm]');
  const count = await buttons.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await page.waitForTimeout(500);
    }
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

async function stopProductionReceiverIfRunning(databasePath: string, databaseId: string): Promise<ProductionReceiverState> {
  const health = await readHealth(9787);
  if (!health) return { wasRunning: false, stopped: false, restarted: false };
  if (health.profile !== 'production' || health.databaseId !== databaseId) {
    throw new Error(`Port 9787 has a TabAtlas receiver but it does not match the source production database.`);
  }
  const pid = await listeningPid(9787);
  if (!pid) throw new Error('Production receiver is running but its process could not be safely identified.');
  const stopped = stopPidTree(pid);
  await waitForPortFree(9787, 15_000);
  const afterStop = fingerprintDatabase(databasePath);
  if (afterStop.databaseId !== databaseId) throw new Error('Production database identity changed while stopping receiver.');
  return { wasRunning: true, stopped, restarted: false, health };
}

async function restartProductionReceiver(databasePath: string): Promise<boolean> {
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(root, 'scripts', 'start-tabatlas.ps1'),
    '-Profile',
    'production',
    '-Port',
    '9787',
    '-Database',
    databasePath,
    '-NoOpen',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  return code === 0 && Boolean(await readHealth(9787));
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

async function listeningPid(targetPort: number): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `(Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
  ], { encoding: 'utf8', windowsHide: true });
  const pid = Number(result.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function stopPidTree(pid: number): boolean {
  const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
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
  pass: boolean;
  elapsedMs: number;
  primaryClicks: number;
  screenshots: string[];
  help: string;
  issues: string[];
  persistedResultIds: Record<string, string[]>;
  trace?: string;
}): StoryResult {
  return {
    story: input.story,
    result: input.pass ? 'passed' : 'failed',
    scores: {
      taskCompletion: input.pass ? 4 : 2,
      visualComprehension: input.pass ? 4 : 2,
      discoverability: input.pass ? 4 : 2,
      trustControl: input.issues.some(issue => /^P[01]/.test(issue)) ? 2 : 4,
    },
    elapsedMs: input.elapsedMs,
    primaryClicks: input.primaryClicks,
    help: input.help,
    issues: input.issues,
    screenshots: input.screenshots.map(item => path.relative(workdir, item)),
    trace: input.trace,
    persistedResultIds: input.persistedResultIds,
  };
}

async function screenshot(page: Page, name: string): Promise<string> {
  const filePath = path.join(screenshotsDir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => undefined);
  return filePath;
}

function renderMarkdownReport(input: {
  ok: boolean;
  productionBefore: DatabaseFingerprint;
  productionAfter: DatabaseFingerprint;
  productionUnchanged: boolean;
  captures: BrowserCapture[];
  storyResults: StoryResult[];
  verification: ReturnType<typeof readVerificationSummary>;
  issues: { p0p1Issues: string[] };
}): string {
  return [
    '# TabAtlas rc3 pre-human role-play',
    '',
    `Result: ${input.ok ? 'pass' : 'fail'}`,
    `Generated: ${new Date().toISOString()}`,
    `Production unchanged: ${input.productionUnchanged}`,
    `Production database ID: ${input.productionBefore.databaseId ?? '(missing)'}`,
    `Production after database ID: ${input.productionAfter.databaseId ?? '(missing)'}`,
    '',
    '## Browser capture',
    '',
    ...input.captures.map(capture => `- ${capture.browser}: strategy=${capture.browser === 'chrome' ? 'chrome_product_cdp' : 'edge_product_cdp'}, version=${capture.executableVersion}, challenge=${capture.challengeId}, capability=${capture.capabilityId}, snapshot=${capture.snapshotId}, tabs=${capture.tabsOpened}`),
    '',
    '## Stories',
    '',
    ...input.storyResults.map(story => [
      `### ${story.story}`,
      `Result: ${story.result}`,
      `Scores: task=${story.scores.taskCompletion}, visual=${story.scores.visualComprehension}, discoverability=${story.scores.discoverability}, trust=${story.scores.trustControl}`,
      `Elapsed ms: ${story.elapsedMs}`,
      `Primary clicks: ${story.primaryClicks}`,
      `Help: ${story.help}`,
      `Issues: ${story.issues.length ? story.issues.join('; ') : 'none'}`,
      `Screenshots: ${story.screenshots.join(', ')}`,
      `Trace: ${story.trace ?? '(none)'}`,
      '',
    ].join('\n')),
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

async function waitForPortFree(targetPort: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canBind(targetPort)) return;
    await delay(500);
  }
  throw new Error(`Port ${targetPort} did not become free after stopping production receiver.`);
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
