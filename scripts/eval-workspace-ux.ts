import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { addUserAnnotation } from '../src/annotations/service.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { createCapability } from '../src/security/localCapability.js';
import { validateRoleplayScenarioCoverage, workspaceRoleplayScenarios, type WorkspaceRoleplayScenario } from '../src/presentation/roleplayScenarios.js';
import { createUserCommand, persistSemanticViewPlan } from '../src/views/service.js';
import type { MembershipState, SemanticViewPlan } from '../src/shared/schemas.js';

type ScenarioResult = {
  id: string;
  persona: string;
  expected: string;
  pass: boolean;
  actual: string;
  screenshot?: string;
  metrics?: Record<string, number>;
  errors: string[];
};

type SeededDatabase = {
  token: string;
  perfView1000: string;
  perfView5000: string;
};

type EvalReport = {
  ok: boolean;
  generatedAt: string;
  reportPath: string;
  roleplayScenarioIds: string[];
  scenarioCount: number;
  accessibility: {
    pass: boolean;
    issues: string[];
  };
  scenarios: ScenarioResult[];
};

type TabSeed = {
  title: string;
  url: string;
  groupTitle: string;
  browser?: 'chrome' | 'edge';
};

const root = process.cwd();
const outputRoot = path.join(root, '.local', 'workspace-ux-eval');
const dbPath = path.join(outputRoot, 'workspace-ux.sqlite');
const port = Number(process.env.TABATLAS_WORKSPACE_UX_PORT ?? 9893);
const baseUrl = `http://127.0.0.1:${port}`;

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const seeded = seedDatabase(dbPath);
let server = startServer(dbPath, port);

try {
  await waitForServer();
  const report = await runBrowserEvaluation(seeded);
  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2));
  printReport(report);
  if (!report.ok) process.exitCode = 1;
} finally {
  await stopServer(server);
}

function seedDatabase(targetDbPath: string): SeededDatabase {
  const db = openDatabase(targetDbPath);
  try {
    importSnapshot(db, {
      capturedAt: '2026-06-19T00:00:00.000Z',
      tabs: [...roleplayTabs(), ...performanceTabs()],
    }, 'workspace_ux_roleplay');

    const resources = db.prepare(`
      SELECT id, title_best AS title
      FROM resources
      ORDER BY title_best
    `).all() as Array<{ id: string; title: string }>;

    seedAnnotations(db, resources);
    seedExtractionArtifacts(db, resources);
    seedAtomicItems(db, resources);

    const perfView1000 = seedPerformanceView(db, resources, 1000, 'view_workspace_ux_perf_1000');
    const perfView5000 = seedPerformanceView(db, resources, 5000, 'view_workspace_ux_perf_5000');
    const { token } = createCapability(db, {
      kind: 'ui',
      label: 'Workspace UX role-play evaluation',
      scopes: ['admin'],
    });
    return { token, perfView1000, perfView5000 };
  } finally {
    db.close();
  }
}

function roleplayTabs(): TabSeed[] {
  const tabs: TabSeed[] = [];
  for (let index = 0; index < 230; index += 1) {
    const bucket = index % 10;
    if (bucket <= 2) {
      tabs.push({
        title: `Forest game visual inspiration mood reference ${index}`,
        url: `https://www.youtube.com/watch?v=forestux${index}`,
        groupTitle: bucket === 0 ? 'Game inspiration' : 'Visual references',
      });
    } else if (bucket <= 4) {
      tabs.push({
        title: `Tab-manager UX review board pattern ${index}`,
        url: `https://example.test/tab-manager/ux/review/${index}`,
        groupTitle: 'UX workspace',
      });
    } else if (bucket === 5) {
      tabs.push({
        title: `Tab-manager extraction transcript capture design ${index}`,
        url: `https://example.test/tab-manager/extraction/${index}`,
        groupTitle: 'Extraction',
      });
    } else if (bucket === 6) {
      tabs.push({
        title: `Tab-manager safety privacy token extension note ${index}`,
        url: `https://example.test/tab-manager/safety/${index}`,
        groupTitle: 'Safety',
      });
    } else if (bucket === 7) {
      tabs.push({
        title: `Tab-manager packaging install release workflow ${index}`,
        url: `https://github.com/example/tab-manager-packaging-${index}`,
        groupTitle: 'Packaging',
      });
    } else if (bucket === 8) {
      tabs.push({
        title: `Questionable conflict research note ${index}`,
        url: `https://example.test/tab-manager/conflict/${index}`,
        groupTitle: 'Conflicts',
      });
    } else {
      tabs.push({
        title: `Archive database unrelated reference ${index}`,
        url: `https://example.test/archive/database/${index}`,
        groupTitle: 'Archive',
      });
    }
  }
  return tabs.map((tab, index) => ({
    ...tab,
    browser: index % 2 ? 'edge' : 'chrome',
  }));
}

function performanceTabs(): TabSeed[] {
  return Array.from({ length: 5000 }, (_, index) => ({
    title: `Performance library item ${index} visual project reference`,
    url: `https://perf.example.test/library/${index}`,
    groupTitle: index % 4 === 0 ? 'Performance architecture' : index % 4 === 1 ? 'Performance UX' : index % 4 === 2 ? 'Performance extraction' : 'Performance safety',
    browser: index % 2 ? 'edge' : 'chrome',
  }));
}

function seedAnnotations(db: ReturnType<typeof openDatabase>, resources: Array<{ id: string; title: string }>): void {
  const annotated = resources
    .filter(resource => /inspiration|forest|tab-manager/i.test(resource.title))
    .slice(0, 12);
  for (const [index, resource] of annotated.entries()) {
    addUserAnnotation(db, {
      id: `ann_workspace_ux_${index}`,
      targetKind: 'resource',
      targetId: resource.id,
      tags: index % 2 ? ['project-reference', 'tab-manager'] : ['inspiration', 'visual'],
      description: index % 2
        ? 'Keep this for the tab-manager project workspace.'
        : 'Use this as a personal inspiration anchor.',
      decision: index % 2 ? 'project_reference' : 'inspiration',
      source: 'resource_detail',
      createdAt: '2026-06-19T00:00:00.000Z',
    });
  }
}

function seedExtractionArtifacts(db: ReturnType<typeof openDatabase>, resources: Array<{ id: string; title: string }>): void {
  const insert = db.prepare(`
    INSERT INTO extraction_artifacts
      (id, resource_id, recipe_id, artifact_kind, text_excerpt, json_payload, source_url, provenance, confidence, status, error_code, extracted_at)
    VALUES (?, ?, ?, 'summary', ?, NULL, NULL, 'workspace_ux_seed', ?, 'complete', NULL, ?)
    ON CONFLICT(resource_id, recipe_id) DO NOTHING
  `);
  for (const [index, resource] of resources.slice(0, 320).entries()) {
    insert.run(
      `ev_workspace_ux_${index}`,
      resource.id,
      `workspace_ux_summary_${index}`,
      summaryForTitle(resource.title),
      index % 5 === 0 ? 0.72 : 0.84,
      '2026-06-19T00:00:00.000Z',
    );
  }
}

function seedAtomicItems(db: ReturnType<typeof openDatabase>, resources: Array<{ id: string; title: string }>): void {
  const insert = db.prepare(`
    INSERT INTO atomic_items
      (id, resource_id, item_kind, name, summary, evidence_refs, confidence, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'workspace_ux_seed', ?)
  `);
  const projectResources = resources.filter(resource => /tab-manager|extraction|safety|packaging|UX/i.test(resource.title)).slice(0, 30);
  for (const [index, resource] of projectResources.entries()) {
    const kind = index % 3 === 0 ? 'decision' : index % 3 === 1 ? 'task' : 'risk';
    const name = index % 3 === 0
      ? `Architecture decision ${index}`
      : index % 3 === 1
        ? `Extraction task ${index}`
        : `Safety risk ${index}`;
    const itemId = `item_workspace_ux_${index}`;
    insert.run(
      itemId,
      resource.id,
      kind,
      name,
      `${name} derived from ${resource.title}.`,
      JSON.stringify([`atomic:${itemId}`]),
      0.74,
      '2026-06-19T00:00:00.000Z',
    );
  }
}

function seedPerformanceView(
  db: ReturnType<typeof openDatabase>,
  resources: Array<{ id: string; title: string }>,
  count: number,
  viewId: string,
): string {
  const selected = resources.filter(resource => resource.title.startsWith('Performance library item')).slice(0, count);
  const commandText = `Performance workspace pagination fixture with ${count} resources.`;
  const commandId = createUserCommand(db, commandText, { eval: 'workspace_ux_performance', count }, `cmd_${viewId}`);
  const memberships = selected.map((resource, index) => {
    const section = index % 4 === 0 ? 'Architecture' : index % 4 === 1 ? 'UX' : index % 4 === 2 ? 'Extraction' : 'Safety';
    const state: MembershipState = index % 29 === 0
      ? 'needs_review'
      : index % 17 === 0
        ? 'weak_include'
        : index % 43 === 0
          ? 'conflict'
          : 'strong_include';
    return {
      targetKind: 'resource' as const,
      targetId: resource.id,
      section,
      state,
      confidence: state === 'strong_include' ? 0.89 : state === 'weak_include' ? 0.56 : 0.49,
      reason: `${resource.title} belongs in the ${section} performance fixture.`,
      evidenceRefs: [`title:${resource.id}`],
      conflict: state === 'conflict' ? 'Conflicting signal included for reviewer testing.' : undefined,
    };
  });
  const plan: SemanticViewPlan = {
    commandText,
    views: [{
      name: `Performance workspace ${count}`,
      description: 'Large workspace pagination fixture.',
      goal: 'Measure cold load, paginated section fetch, and inspector fetch on large views.',
      inclusionRules: ['Include performance fixture resources.'],
      exclusionRules: ['No explicit exclusions in this fixture.'],
      sections: ['Architecture', 'UX', 'Extraction', 'Safety'],
      confidence: 0.9,
      memberships,
    }],
    reviewQueues: [{
      queueName: 'uncertain',
      reason: 'Performance fixture weak and conflict items.',
      targetIds: memberships
        .filter(membership => membership.state !== 'strong_include')
        .slice(0, 100)
        .map(membership => membership.targetId),
    }],
    explanation: 'Seeded performance fixture view.',
  };
  persistSemanticViewPlan(db, commandId, plan, {
    origin: 'workspace_ux_performance',
    viewIds: [viewId],
  });
  return viewId;
}

function startServer(targetDbPath: string, targetPort: number): ChildProcess {
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsx, 'src/server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      TABATLAS_DB: targetDbPath,
      TABATLAS_PORT: String(targetPort),
      TABATLAS_BOOTSTRAP_DIR: path.join(outputRoot, 'bootstrap'),
      TABATLAS_FAKE_CODEX_PROVIDER: 'workspace_ux',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => fs.appendFileSync(path.join(outputRoot, 'server.log'), chunk));
  child.stderr.on('data', chunk => fs.appendFileSync(path.join(outputRoot, 'server.log'), chunk));
  return child;
}

async function waitForServer(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Wait until the child process is listening.
    }
    await delay(250);
  }
  throw new Error(`Server did not become ready at ${baseUrl}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(3000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function runBrowserEvaluation(seededDb: SeededDatabase): Promise<EvalReport> {
  const browser = await chromium.launch({ headless: true });
  let context = await newEvaluationContext(browser, seededDb.token);
  let page = await openWorkspace(context);
  const scenarios: ScenarioResult[] = [];
  try {
    const coverageIssues = validateRoleplayScenarioCoverage(workspaceRoleplayScenarios);
    scenarios.push(resultFromCheck(
      'scenario-coverage',
      'The gate runs the exact five required role-play personas.',
      coverageIssues.length === 0,
      coverageIssues.length ? coverageIssues.join('; ') : workspaceRoleplayScenarios.map(scenario => scenario.id).join(', '),
    ));

    scenarios.push(await runScenario(page, roleplay('creative-collector'), () => creativeCollector(page)));
    scenarios.push(await runScenario(page, roleplay('project-builder'), () => projectBuilder(page)));
    scenarios.push(await runScenario(page, roleplay('skeptical-curator'), () => skepticalCurator(page)));
    scenarios.push(await runScenario(page, roleplay('tab-triage'), () => tabTriager(page)));

    const restartState = await context.storageState();
    await context.close();
    await stopServer(server);
    server = startServer(dbPath, port);
    await waitForServer();
    context = await browser.newContext({ viewport: { width: 1440, height: 920 }, storageState: restartState });
    page = await openWorkspace(context);
    scenarios.push(await runScenario(page, roleplay('returning-user'), () => returningUser(page)));

    scenarios.push(await runPerformanceScenario(page, seededDb.perfView1000, 1000));
    scenarios.push(await runPerformanceScenario(page, seededDb.perfView5000, 5000));

    const accessibility = await axeAccessibilityCheck(page);
    const ok = scenarios.every(scenario => scenario.pass) && accessibility.pass;
    return {
      ok,
      generatedAt: new Date().toISOString(),
      reportPath: path.join(outputRoot, 'report.json'),
      roleplayScenarioIds: workspaceRoleplayScenarios.map(scenario => scenario.id),
      scenarioCount: scenarios.length,
      accessibility,
      scenarios,
    };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close();
  }
}

async function newEvaluationContext(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  await context.addInitScript((savedToken: string) => {
    localStorage.setItem('tabatlas.localToken', savedToken);
    localStorage.setItem('tabatlas.workspace.page', 'ask');
    localStorage.setItem('tabatlas.workspace.remoteMedia', 'off');
  }, token);
  return context;
}

async function openWorkspace(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await expectVisible(page.getByTestId('app-shell'));
  return page;
}

function roleplay(id: string): WorkspaceRoleplayScenario {
  const scenario = workspaceRoleplayScenarios.find(candidate => candidate.id === id);
  if (!scenario) throw new Error(`Missing role-play scenario ${id}`);
  return scenario;
}

async function creativeCollector(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  const scenario = roleplay('creative-collector');
  const viewId = await askForNewView(page, extractAsk(scenario.steps[0].userAction));
  await expectVisible(page.getByTestId('workspace-board'));
  const boardCards = await page.locator('.resource-card').count();
  const userSignals = await page.locator('.user-signal').count();
  const rawJsonVisible = await page.locator('text=/\\{\\s*"views"/').count();

  const beforeViewId = await activeViewId(page);
  await submitConversation(page, extractAsk(scenario.steps[1].userAction));
  await expectVisible(page.getByTestId('workspace-gallery'));
  const afterViewId = await activeViewId(page);
  const galleryCards = await page.locator('.resource-card.gallery').count();
  return {
    pass: boardCards > 0 && galleryCards > 0 && userSignals > 0 && rawJsonVisible === 0 && beforeViewId === afterViewId && afterViewId === viewId,
    actual: `viewId=${viewId}; boardCards=${boardCards}; galleryCards=${galleryCards}; userSignals=${userSignals}; rawJsonVisible=${rawJsonVisible}; sameView=${beforeViewId === afterViewId}`,
  };
}

async function projectBuilder(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  const scenario = roleplay('project-builder');
  await page.getByTestId('nav-ask').click();
  const viewId = await askForNewView(page, extractAsk(scenario.steps[0].userAction));
  await page.getByTestId('view-toolbar').getByRole('button', { name: 'Board' }).click();
  await expectVisible(page.getByTestId('workspace-board'));
  const sections = await page.locator('.board-column').count();
  const atomicCards = await page.locator('.resource-card[data-target-kind="atomic_item"]').count();
  const firstCard = page.locator('.resource-card').first();
  await firstCard.click();
  await page.locator('[data-inspector-tab="evidence"]').click();
  const evidenceRows = await page.locator('.evidence-row').count();
  await page.locator('[data-inspector-tab="notes"]').click();
  const notesText = await page.getByTestId('inspector-surface').innerText();
  await page.locator('[data-inspector-tab="related"]').click();
  const relatedRows = await page.locator('[data-related-view]').count();
  await page.locator('[data-close-inspector]').click();
  await expectVisible(page.getByTestId('workspace-board'));
  return {
    pass: Boolean(viewId) && sections >= 4 && atomicCards > 0 && evidenceRows > 0 && /inspiration|project|note|No user notes yet/i.test(notesText) && relatedRows > 0,
    actual: `viewId=${viewId}; sections=${sections}; atomicCards=${atomicCards}; evidenceRows=${evidenceRows}; relatedRows=${relatedRows}`,
  };
}

async function skepticalCurator(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  const scenario = roleplay('skeptical-curator');
  await page.getByTestId('nav-views').click();
  await page.locator('[data-state-filter="weak_include"]').click();
  const weakCards = await page.locator('.resource-card').count();
  await page.locator('.resource-card').first().click();
  await expectVisible(page.getByTestId('inspector-surface'));
  await page.locator('[data-inspector-tab="overview"]').click();
  await page.locator('[data-explain-membership]').click();
  await page.locator('#correctionReason').fill('Not actually relevant to this role-play workspace.');
  await page.getByRole('button', { name: 'Pin exclude' }).click();
  await expectText(page.locator('#correctionResult'), /Saved pin_exclude/i);
  const correctionText = await page.locator('#correctionResult').innerText();
  await page.getByTestId('nav-views').click();
  await submitConversation(page, 'show weak matches as a map');
  await expectVisible(page.getByTestId('workspace-map'));
  const mapClusters = await page.locator('.map-cluster').count();
  return {
    pass: weakCards > 0 && /Saved pin_exclude/i.test(correctionText) && mapClusters > 0 && scenario.steps.length === 2,
    actual: `weakCards=${weakCards}; correction="${compact(correctionText)}"; mapClusters=${mapClusters}`,
  };
}

async function tabTriager(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  await page.getByTestId('nav-review').click();
  await page.getByRole('button', { name: 'Unmarked' }).click();
  await expectVisible(page.locator('[data-review-decision="important"]'));
  const nextCards = await page.locator('.next-list button').count();
  const before = await page.locator('.progress-block').innerText();
  await page.locator('#reviewNote').fill('typing S and I here should not submit');
  await page.keyboard.press('s');
  await page.keyboard.press('i');
  const duringEdit = await page.locator('.progress-block').innerText();
  await page.locator('#reviewNote').blur();
  const decisions = ['1', '2', '3', '4', 's', 'i', '1', '2', '3', '4'];
  for (const key of decisions) {
    await page.keyboard.press(key);
    await page.waitForTimeout(80);
  }
  const after = await page.locator('.progress-block').innerText();
  const externalLinks = await page.getByRole('link', { name: 'Open externally' }).count();
  return {
    pass: before === duringEdit && before !== after && nextCards >= 3 && externalLinks > 0,
    actual: `before="${compact(before)}"; duringEdit="${compact(duringEdit)}"; after="${compact(after)}"; nextCards=${nextCards}; externalLinks=${externalLinks}`,
  };
}

async function returningUser(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  await expectVisible(page.getByTestId('page-review'));
  await page.getByTestId('nav-views').click();
  await expectVisible(page.getByTestId('workspace-map'));
  const active = await activeViewId(page);
  const summaryVisible = await page.locator('.restore-summary').count();
  const conversationMessages = await page.locator('#conversationThread .message').count();
  const selectedTargetId = await page.evaluate(() => localStorage.getItem('tabatlas.workspace.selectedTargetId') ?? '');
  const reviewSessionId = await page.evaluate(() => localStorage.getItem('tabatlas.workspace.reviewSessionId') ?? '');
  return {
    pass: Boolean(active) && summaryVisible > 0 && conversationMessages > 0 && Boolean(selectedTargetId) && Boolean(reviewSessionId),
    actual: `activeViewId=${active}; restoreSummary=${summaryVisible}; messages=${conversationMessages}; selectedTargetId=${selectedTargetId}; reviewSessionId=${reviewSessionId}`,
  };
}

async function runPerformanceScenario(page: Page, viewId: string, size: number): Promise<ScenarioResult> {
  return runScenario(page, {
    id: `large-workspace-${size}`,
    title: `${size}-resource workspace remains paginated`,
    persona: {
      id: `large-workspace-${size}`,
      name: 'Large-library user',
      mindset: 'The app should stay responsive on large tab libraries.',
      patience: 'medium',
      visualPreference: 'balanced',
      trustLevel: 'neutral',
    },
    startingState: `${size} resources are available in a persisted performance fixture view.`,
    steps: [{
      userIntent: 'Open a large view.',
      userAction: `Open the ${size}-resource performance view.`,
      expectedVisibleResult: 'The board renders a bounded first page and fetches deeper section pages on demand.',
      successSignals: ['DOM remains bounded.', 'Section pagination is fast.', 'Inspector fetch is fast.'],
      failureSignals: ['All resources are rendered at once.', 'Section pages require a full workspace rebuild.'],
      maxPrimaryClicks: 1,
    }],
    completionQuestion: 'Can a large workspace be opened without blocking normal review?',
  }, async () => {
    const metrics = await measureLargeWorkspace(page, viewId);
    const pass = metrics.workspaceMs < (size === 1000 ? 2500 : 5000)
      && metrics.sectionMs < 1500
      && metrics.inspectorMs < 1500
      && metrics.domNodes < 3500
      && metrics.cards > 0
      && metrics.cards <= 140;
    return {
      pass,
      actual: Object.entries(metrics).map(([key, value]) => `${key}=${Math.round(value)}`).join('; '),
      metrics,
    };
  });
}

async function runScenario(
  page: Page,
  scenario: WorkspaceRoleplayScenario,
  run: () => Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }>,
): Promise<ScenarioResult> {
  const screenshot = path.join(outputRoot, `${scenario.id}.png`);
  try {
    const result = await run();
    await page.screenshot({ path: screenshot, fullPage: true });
    return {
      id: scenario.id,
      persona: scenario.persona.name,
      expected: scenario.steps.map(step => step.expectedVisibleResult).join(' '),
      pass: result.pass,
      actual: result.actual,
      screenshot,
      metrics: result.metrics,
      errors: result.pass ? [] : scenario.steps.flatMap(step => step.failureSignals),
    };
  } catch (error) {
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    return {
      id: scenario.id,
      persona: scenario.persona.name,
      expected: scenario.steps.map(step => step.expectedVisibleResult).join(' '),
      pass: false,
      actual: 'scenario threw',
      screenshot,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function resultFromCheck(id: string, expected: string, pass: boolean, actual: string): ScenarioResult {
  return {
    id,
    persona: 'Gate setup',
    expected,
    pass,
    actual,
    errors: pass ? [] : [actual],
  };
}

async function askForNewView(page: Page, commandText: string): Promise<string> {
  const beforeOptions = await page.locator('#activeViewSelect option').count();
  const expectedName = expectedViewNameFor(commandText);
  await submitConversation(page, commandText);
  await page.waitForFunction((previousCount: number) => {
    return document.querySelectorAll('#activeViewSelect option').length > previousCount
      && Boolean(localStorage.getItem('tabatlas.workspace.activeViewId'));
  }, beforeOptions, { timeout: 20_000 });
  await expectVisible(page.getByTestId('page-views'));
  await page.waitForFunction((name: string) => {
    const selected = document.querySelector<HTMLSelectElement>('#activeViewSelect')?.selectedOptions[0]?.textContent ?? '';
    const workspaceText = document.querySelector('[data-testid="view-workspace"]')?.textContent ?? '';
    return selected.includes(name) && workspaceText.includes(name);
  }, expectedName, { timeout: 20_000 });
  return activeViewId(page);
}

async function submitConversation(page: Page, text: string): Promise<void> {
  await page.locator('#conversationTab').click();
  await expectVisible(page.locator('#conversationInput'));
  await page.locator('#conversationInput').fill(text);
  await page.getByTestId('conversation-form').locator('button[type="submit"]').click();
}

function expectedViewNameFor(commandText: string): string {
  return /tab-manager|project|architecture|extraction|packaging|safety/i.test(commandText)
    ? 'Tab manager project workspace'
    : 'Loose inspiration board';
}

async function activeViewId(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('tabatlas.workspace.activeViewId') ?? '');
}

async function measureLargeWorkspace(page: Page, viewId: string): Promise<Record<string, number>> {
  const apiMetrics = await page.evaluate(async (id: string) => {
    const headers = { 'x-tab-atlas-token': localStorage.getItem('tabatlas.localToken') ?? '' };
    const workspaceStart = performance.now();
    const workspaceResponse = await fetch(`/api/views/${encodeURIComponent(id)}/workspace?limit=24`, { headers });
    const workspace = await workspaceResponse.json();
    const workspaceMs = performance.now() - workspaceStart;
    const section = workspace.sections.find((candidate: { totalCount: number }) => candidate.totalCount > 24) ?? workspace.sections[0];
    const sectionStart = performance.now();
    const sectionResponse = await fetch(`/api/views/${encodeURIComponent(id)}/sections/${encodeURIComponent(section.id)}?cursor=24&limit=24`, { headers });
    const sectionPage = await sectionResponse.json();
    const sectionMs = performance.now() - sectionStart;
    const card = workspace.sections.flatMap((candidate: { cards: Array<{ targetKind: string; targetId: string }> }) => candidate.cards)
      .find((candidate: { targetKind: string }) => candidate.targetKind === 'resource');
    const inspectorStart = performance.now();
    const inspectorResponse = await fetch(`/api/targets/${encodeURIComponent(card.targetKind)}/${encodeURIComponent(card.targetId)}/inspector?viewId=${encodeURIComponent(id)}`, { headers });
    await inspectorResponse.json();
    const inspectorMs = performance.now() - inspectorStart;
    return {
      workspaceMs,
      sectionMs,
      inspectorMs,
      firstPageCards: workspace.sections.reduce((sum: number, candidate: { cards: unknown[] }) => sum + candidate.cards.length, 0),
      sectionPageCards: sectionPage.cards.length,
    };
  }, viewId) as Record<string, number>;

  await page.evaluate((id: string) => {
    localStorage.setItem('tabatlas.workspace.activeViewId', id);
    localStorage.setItem('tabatlas.workspace.page', 'views');
    localStorage.setItem('tabatlas.workspace.layout', 'board');
  }, viewId);
  const renderStart = Date.now();
  await page.reload({ waitUntil: 'networkidle' });
  await expectVisible(page.getByTestId('workspace-board'));
  const renderMs = Date.now() - renderStart;
  const domNodes = await page.locator('*').count();
  const cards = await page.locator('.resource-card').count();
  return {
    ...apiMetrics,
    renderMs,
    domNodes,
    cards,
  };
}

async function axeAccessibilityCheck(page: Page): Promise<EvalReport['accessibility']> {
  const results = await new AxeBuilder({ page }).analyze();
  const issues = results.violations
    .filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(violation => `${violation.id}:${violation.nodes.length}`);
  return { pass: issues.length === 0, issues };
}

async function expectVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
}

async function expectText(locator: Locator, pattern: RegExp): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const value = await locator.innerText().catch(() => '');
    if (pattern.test(value)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for text ${pattern}`);
}

function extractAsk(action: string): string {
  const match = action.match(/(?:Ask|Say):\s*(.+)$/i);
  return match?.[1] ?? action;
}

function summaryForTitle(title: string): string {
  if (/safety|privacy|token|extension/i.test(title)) return 'Security and privacy material for safe local browser capture.';
  if (/extraction|transcript|capture/i.test(title)) return 'Extraction workflow material with transcript, capture, and parsing evidence.';
  if (/packaging|install|release/i.test(title)) return 'Packaging and installation material for developer release work.';
  if (/UX|visual|review|inspiration|forest/i.test(title)) return 'Visual and UX reference material for workspace review.';
  return 'General architecture material for the TabAtlas project.';
}

function printReport(report: EvalReport): void {
  for (const scenario of report.scenarios) {
    console.log(`Case: ${scenario.id}`);
    console.log(`Persona: ${scenario.persona}`);
    console.log(`Expected: ${scenario.expected}`);
    console.log(`Actual: ${scenario.actual}`);
    console.log(`Pass/fail: ${scenario.pass ? 'pass' : 'fail'}`);
    if (scenario.screenshot) console.log(`Screenshot: ${scenario.screenshot}`);
    if (scenario.errors.length) console.log(`Errors: ${scenario.errors.join('; ')}`);
    console.log('');
  }
  console.log(`Accessibility: ${report.accessibility.pass ? 'pass' : 'fail'} ${report.accessibility.issues.join('; ')}`);
  console.log(`Report: ${report.reportPath}`);
  console.log(`Workspace UX evaluation ${report.ok ? 'passed' : 'failed'}: ${report.scenarios.filter(scenario => scenario.pass).length}/${report.scenarios.length} scenarios.`);
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
