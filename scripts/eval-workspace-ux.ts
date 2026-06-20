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
import { createViewRevision } from '../src/views/feedbackService.js';
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
  reviewQueueView: string;
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
    surfaces: Record<string, string[]>;
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

    const reviewQueueView = seedReviewQueueView(db, resources);
    const perfView1000 = seedPerformanceView(db, resources, 1000, 'view_workspace_ux_perf_1000');
    const perfView5000 = seedPerformanceView(db, resources, 5000, 'view_workspace_ux_perf_5000');
    const { token } = createCapability(db, {
      kind: 'ui',
      label: 'Workspace UX role-play evaluation',
      scopes: ['admin'],
    });
    return { token, reviewQueueView, perfView1000, perfView5000 };
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

  const insertFailure = db.prepare(`
    INSERT INTO extraction_artifacts
      (id, resource_id, recipe_id, artifact_kind, text_excerpt, json_payload, source_url, provenance, confidence, status, error_code, extracted_at)
    VALUES (?, ?, ?, 'summary', '', NULL, NULL, 'workspace_ux_seed', 0, 'failed', 'workspace_ux_failed_extract', ?)
    ON CONFLICT(resource_id, recipe_id) DO NOTHING
  `);
  for (const [index, resource] of resources.slice(24, 40).entries()) {
    insertFailure.run(
      `ev_workspace_ux_failed_${index}`,
      resource.id,
      `workspace_ux_failed_summary_${index}`,
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

function seedReviewQueueView(db: ReturnType<typeof openDatabase>, resources: Array<{ id: string; title: string }>): string {
  const atomicItems = db.prepare(`
    SELECT id, resource_id, name
    FROM atomic_items
    ORDER BY id
    LIMIT 12
  `).all() as Array<{ id: string; resource_id: string; name: string }>;
  const resourceTitle = new Map(resources.map(resource => [resource.id, resource.title]));
  const selectedResources = [...new Set(atomicItems.map(item => item.resource_id))].slice(0, 10);
  const commandText = 'Executable review queue fixture with resource and atomic duplicates.';
  const commandId = createUserCommand(db, commandText, { eval: 'workspace_ux_review_queues' }, 'cmd_workspace_ux_review_queues');
  const memberships = selectedResources.flatMap((resourceId, index) => {
    const atomic = atomicItems.find(item => item.resource_id === resourceId);
    const state: MembershipState = index % 4 === 0 ? 'conflict' : index % 3 === 0 ? 'needs_review' : 'weak_include';
    const shared = {
      section: index % 2 === 0 ? 'Queue coverage' : 'Atomic duplicates',
      confidence: state === 'conflict' ? 0.48 : state === 'needs_review' ? 0.52 : 0.58,
      reason: `${resourceTitle.get(resourceId) ?? resourceId} is seeded for executable queue coverage.`,
      evidenceRefs: [`title:${resourceId}`],
      conflict: state === 'conflict' ? 'Seeded conflict for executable review coverage.' : undefined,
    };
    return [
      {
        targetKind: 'resource' as const,
        targetId: resourceId,
        state,
        ...shared,
      },
      ...(atomic ? [{
        targetKind: 'atomic_item' as const,
        targetId: atomic.id,
        state: index % 2 === 0 ? 'needs_review' as MembershipState : 'weak_include' as MembershipState,
        section: shared.section,
        confidence: 0.54,
        reason: `${atomic.name} shares its parent resource with the review fixture.`,
        evidenceRefs: [`atomic:${atomic.id}`],
      }] : []),
    ];
  });
  const plan: SemanticViewPlan = {
    commandText,
    views: [{
      name: 'Executable review queue fixture',
      description: 'Fixture proving source-view review queues execute from server state.',
      goal: commandText,
      inclusionRules: ['Include weak, conflicting, and atomic-backed resources for queue tests.'],
      exclusionRules: ['Do not include unrelated performance-only resources.'],
      sections: ['Queue coverage', 'Atomic duplicates'],
      confidence: 0.82,
      memberships,
    }],
    reviewQueues: [{
      queueName: 'uncertain',
      reason: 'Executable review queue fixture resources.',
      targetIds: selectedResources,
    }],
    explanation: 'Seeded executable review queue fixture.',
  };
  const viewId = 'view_workspace_ux_review_queues';
  persistSemanticViewPlan(db, commandId, plan, {
    origin: 'workspace_ux_review_queues',
    viewIds: [viewId],
  });
  const parent = db.prepare(`
    SELECT id
    FROM view_revisions
    WHERE view_id = ?
    ORDER BY revision_number DESC
    LIMIT 1
  `).get(viewId) as { id: string } | undefined;
  createViewRevision(db, {
    viewId,
    parentRevisionId: parent?.id,
    commandId,
    status: 'proposed',
    snapshot: {
      commandText: `${commandText} Revised.`,
      view: {
        ...plan.views[0],
        goal: `${commandText} Revised goal.`,
        inclusionRules: [...plan.views[0].inclusionRules, 'Promote duplicated atomic evidence for human review.'],
        memberships: memberships.map((membership, index) => index === 0
          ? { ...membership, state: 'strong_include' as MembershipState, confidence: 0.9 }
          : membership).slice(0, Math.max(1, memberships.length - 1)),
      },
    },
  });
  return viewId;
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
      TABATLAS_CAPTURE_ROOTS: path.join(root, 'tests'),
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

    await prepareReturningUserState(page);
    const restartState = await context.storageState();
    await context.close();
    await stopServer(server);
    server = startServer(dbPath, port);
    await waitForServer();
    context = await browser.newContext({ viewport: { width: 1440, height: 920 }, storageState: restartState });
    page = await openWorkspace(context);
    scenarios.push(await runScenario(page, roleplay('returning-user'), () => returningUser(page)));

    scenarios.push(await runScenario(page, operationsScenario(), () => operationsSmoke(page)));
    scenarios.push(await runScenario(page, executableExtensionRepairScenario(), () => extensionRepairExecutable(page)));
    scenarios.push(await runScenario(page, executableReviewQueueScenario(), () => reviewQueuesExecutable(page, seededDb.reviewQueueView)));
    scenarios.push(await runScenario(page, executableMixedConversationScenario(), () => mixedConversationExecutable(page, seededDb.perfView1000)));
    scenarios.push(await runScenario(page, executableServerUndoScenario(), () => serverOwnedUndoExecutable(page, seededDb.reviewQueueView)));
    scenarios.push(await runScenario(page, executablePresentationReplayScenario(), () => presentationReplayExecutable(page, seededDb.perfView1000)));
    scenarios.push(await runScenario(page, executableRevisionComparisonScenario(), () => revisionComparisonExecutable(page, seededDb.reviewQueueView)));
    scenarios.push(await runPerformanceScenario(page, seededDb.perfView1000, 1000));
    scenarios.push(await runPerformanceScenario(page, seededDb.perfView5000, 5000));

    const accessibility = await runAccessibilitySurfaces(page);
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

function operationsScenario(): WorkspaceRoleplayScenario {
  return {
    id: 'operations-smoke',
    title: 'Operations controls remain usable',
    persona: {
      id: 'operations-smoke',
      name: 'Local operator',
      mindset: 'Operational controls should be boring and direct.',
      patience: 'medium',
      visualPreference: 'text_first',
      trustLevel: 'skeptical',
    },
    startingState: 'A local authenticated workspace is open with one active semantic view.',
    steps: [{
      userIntent: 'Verify operational controls without leaving the UI.',
      userAction: 'Use pairing, import, extraction, scan, jobs, view operations, and security controls.',
      expectedVisibleResult: 'Each operation gives a visible bounded result and security rotation never discards a token silently.',
      successSignals: ['Import fixture succeeds.', 'Jobs can be queued and controlled.', 'Rotation behavior is explicit.'],
      failureSignals: ['A token is discarded.', 'A job action is unreachable.', 'An operation only works by API.'],
      maxPrimaryClicks: 12,
    }],
    completionQuestion: 'Can a local operator reach the secondary controls without shell commands?',
  };
}

function executableExtensionRepairScenario(): WorkspaceRoleplayScenario {
  return executableScenario(
    'extension-repair-executable',
    'Extension re-pair executes from the security UI',
    'Revoke an extension capability, show a one-time re-pair challenge, exchange it, and prove old-token denial plus new-token snapshot write.',
  );
}

function executableReviewQueueScenario(): WorkspaceRoleplayScenario {
  return executableScenario(
    'review-queues-executable',
    'Review queues execute from server source views',
    'Start source-view review queues through the UI and prove weak/atomic duplicates, unmarked, and extraction-failure queues use persisted server state.',
  );
}

function executableMixedConversationScenario(): WorkspaceRoleplayScenario {
  return executableScenario(
    'mixed-conversation-executable',
    'Mixed semantic and presentation turn executes both parts',
    'Send one turn that switches layout and refines the active semantic view, then verify the persisted action and presentation plan.',
  );
}

function executableServerUndoScenario(): WorkspaceRoleplayScenario {
  return executableScenario(
    'server-owned-undo-executable',
    'Correction undo is server-owned',
    'Submit a forged correction payload through the public API and prove undo restores the server snapshot while stale undo is rejected.',
  );
}

function executablePresentationReplayScenario(): WorkspaceRoleplayScenario {
  return executableScenario(
    'presentation-replay-executable',
    'Historical presentation plans do not replay',
    'Persist a historical gallery plan, reload on board layout, send a semantic-only turn, and prove the old plan does not run again.',
  );
}

function executableRevisionComparisonScenario(): WorkspaceRoleplayScenario {
  return executableScenario(
    'revision-comparison-executable',
    'Revision comparison renders a visual artifact',
    'Ask to compare the latest and previous revisions and verify the comparison artifact contains membership and rule changes.',
  );
}

function executableScenario(id: string, title: string, expectedVisibleResult: string): WorkspaceRoleplayScenario {
  return {
    id,
    title,
    persona: {
      id,
      name: 'Executable gate',
      mindset: 'The gate should prove behavior by executing the browser and receiver paths.',
      patience: 'medium',
      visualPreference: 'balanced',
      trustLevel: 'skeptical',
    },
    startingState: 'The seeded workspace UX database and authenticated local receiver are running.',
    steps: [{
      userIntent: title,
      userAction: expectedVisibleResult,
      expectedVisibleResult,
      successSignals: ['The behavior is executed.', 'The receiver state matches the UI result.', 'No token or secret is persisted in report output.'],
      failureSignals: ['The check only scans source text.', 'The UI path is skipped.', 'The persisted state does not match the visible result.'],
      maxPrimaryClicks: 8,
    }],
    completionQuestion: 'Did the executable path prove the behavior?',
  };
}

async function creativeCollector(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  const scenario = roleplay('creative-collector');
  const viewId = await askForNewView(page, extractAsk(scenario.steps[0].userAction));
  await expectVisible(page.getByTestId('workspace-board'));
  const boardCards = await page.locator('.resource-card').count();
  const userSignals = await page.locator('.user-signal').count();
  const identifiableCards = await page.locator('.resource-card').evaluateAll(cards => cards.filter(card => {
    const text = card.textContent ?? '';
    return Boolean(card.querySelector('.card-media'))
      && /User note|AI analysis|Verified content|Title only|Prior correction/i.test(text)
      && /matches|evidence|User annotation|local title/i.test(text);
  }).length);
  const rawJsonVisible = await page.locator('text=/\\{\\s*"views"/').count();

  const beforeViewId = await activeViewId(page);
  await submitConversation(page, extractAsk(scenario.steps[1].userAction));
  await expectVisible(page.getByTestId('workspace-gallery'));
  const afterViewId = await activeViewId(page);
  const galleryCards = await page.locator('.resource-card.gallery').count();
  return {
    pass: boardCards >= 3 && galleryCards > 0 && userSignals > 0 && identifiableCards >= 3
      && rawJsonVisible === 0 && beforeViewId === afterViewId && afterViewId === viewId,
    actual: `viewId=${viewId}; boardCards=${boardCards}; identifiableCards=${identifiableCards}; galleryCards=${galleryCards}; userSignals=${userSignals}; rawJsonVisible=${rawJsonVisible}; sameView=${beforeViewId === afterViewId}`,
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
  await page.locator('#viewWorkspace').evaluate(element => { element.scrollTop = 160; });
  const scrollBefore = await page.locator('#viewWorkspace').evaluate(element => element.scrollTop);
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
  const scrollAfter = await page.locator('#viewWorkspace').evaluate(element => element.scrollTop);
  const focusReturned = await firstCard.evaluate(element => document.activeElement === element).catch(() => false);
  return {
    pass: Boolean(viewId) && sections >= 2 && atomicCards > 0 && evidenceRows > 0
      && /inspiration|project|note|No user notes yet/i.test(notesText) && relatedRows > 0
      && Math.abs(scrollAfter - scrollBefore) <= 4 && focusReturned,
    actual: `viewId=${viewId}; sections=${sections}; atomicCards=${atomicCards}; evidenceRows=${evidenceRows}; relatedRows=${relatedRows}; scrollBefore=${scrollBefore}; scrollAfter=${scrollAfter}; focusReturned=${focusReturned}`,
  };
}

async function skepticalCurator(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  const scenario = roleplay('skeptical-curator');
  await page.getByTestId('nav-views').click();
  await page.locator('[data-state-filter="weak_include"]').click();
  const weakCards = await page.locator('.resource-card').count();
  const targetId = await page.locator('.resource-card').first().getAttribute('data-target-id') ?? '';
  await page.locator('.resource-card').first().click();
  await expectVisible(page.getByTestId('inspector-surface'));
  await page.locator('[data-inspector-tab="overview"]').click();
  await page.locator('[data-explain-membership]').click();
  await page.locator('#correctionReason').fill('Not actually relevant to this role-play workspace.');
  await page.getByRole('button', { name: 'Pin exclude' }).click();
  await expectText(page.locator('#correctionResult'), /Saved pin exclude/i);
  const correctionText = await page.locator('#correctionResult').innerText();
  const correctedState = await page.locator('.metadata-grid').innerText();
  await page.getByTestId('nav-views').click();
  const correctedCard = page.locator(`.resource-card[data-target-id="${targetId}"]`).first();
  const correctedVisibleText = await correctedCard.innerText();
  const unrelatedViewId = await askForNewView(page, 'Collect painting tutorials and practical art lessons.');
  const unrelatedState = await page.evaluate(async ({ viewId, resourceId }) => {
    const headers = { 'x-tab-atlas-token': localStorage.getItem('tabatlas.localToken') ?? '' };
    const response = await fetch(`/api/views/${encodeURIComponent(viewId)}/workspace?limit=100`, { headers });
    const workspace = await response.json();
    const card = workspace.sections.flatMap((section: { cards: Array<{ targetId: string; state: string }> }) => section.cards)
      .find((candidate: { targetId: string }) => candidate.targetId === resourceId);
    return card?.state ?? 'absent';
  }, { viewId: unrelatedViewId, resourceId: targetId });
  await submitConversation(page, 'show weak matches as a map');
  await expectVisible(page.getByTestId('workspace-map'));
  const mapClusters = await page.locator('.map-cluster').count();
  return {
    pass: weakCards > 0 && /Saved pin exclude/i.test(correctionText) && /Conflict/i.test(correctedState)
      && /Conflict/i.test(correctedVisibleText) && unrelatedState !== 'conflict'
      && mapClusters > 0 && scenario.steps.length === 2,
    actual: `weakCards=${weakCards}; correction="${compact(correctionText)}"; correctedState="${compact(correctedState)}"; correctedCard="${compact(correctedVisibleText)}"; unrelatedViewId=${unrelatedViewId}; unrelatedState=${unrelatedState}; mapClusters=${mapClusters}`,
  };
}

async function tabTriager(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  const resourceIds = await openControlledReviewSession(page);
  await page.getByTestId('nav-review').click();
  await expectVisible(page.locator('[data-review-decision="important"]'));
  const nextCards = await page.locator('[data-review-visual="next"]').count();
  const firstResourceId = await page.locator('.review-current [data-review-inspect]').getAttribute('data-review-inspect') ?? '';
  const before = await page.locator('.progress-block').innerText();
  await page.locator('#reviewNote').fill('typing S and I here should not submit');
  await page.keyboard.press('s');
  await page.keyboard.press('i');
  const duringEdit = await page.locator('.progress-block').innerText();
  await page.locator('#reviewNote').blur();
  await page.keyboard.press('1');
  await page.waitForTimeout(120);
  const notePersisted = await page.evaluate(async (resourceId: string) => {
    const headers = { 'x-tab-atlas-token': localStorage.getItem('tabatlas.localToken') ?? '' };
    const response = await fetch(`/api/targets/resource/${encodeURIComponent(resourceId)}/inspector`, { headers });
    return JSON.stringify(await response.json()).includes('typing S and I here should not submit');
  }, firstResourceId);
  const skippedResourceId = await page.locator('.review-current [data-review-inspect]').getAttribute('data-review-inspect') ?? '';
  await page.keyboard.press('s');
  await page.waitForTimeout(120);
  for (const key of ['2', '3', '4']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
  }
  const after = await page.locator('.progress-block').innerText();
  const returnedResourceId = await page.locator('.review-current [data-review-inspect]').getAttribute('data-review-inspect') ?? '';
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Open externally' }).click();
  const popup = await popupPromise;
  const externalUrl = popup.url();
  await popup.close();
  return {
    pass: resourceIds.length === 5 && before === duringEdit && before !== after
      && nextCards >= 3 && notePersisted && skippedResourceId === returnedResourceId && Boolean(externalUrl),
    actual: `resources=${resourceIds.length}; before="${compact(before)}"; duringEdit="${compact(duringEdit)}"; after="${compact(after)}"; nextCards=${nextCards}; notePersisted=${notePersisted}; skipped=${skippedResourceId}; returned=${returnedResourceId}; externalUrl=${externalUrl}`,
  };
}

async function prepareReturningUserState(page: Page): Promise<void> {
  await page.getByTestId('nav-views').click();
  await page.getByTestId('view-toolbar').getByRole('button', { name: 'Map' }).click();
  await expectVisible(page.getByTestId('workspace-map'));
  await page.locator('#workspaceSearch').fill('reference');
  await page.locator('#workspaceSearch').dispatchEvent('input');
  if (await page.locator('.resource-card').count() === 0) {
    await page.locator('#workspaceSearch').fill('');
    await page.locator('#workspaceSearch').dispatchEvent('input');
  }
  await page.locator('#viewWorkspace').evaluate(element => {
    element.scrollTop = 180;
    localStorage.setItem('tabatlas.workspace.workspaceScrollTop', String(element.scrollTop));
  });
  await page.locator('.resource-card').first().click();
  await expectVisible(page.getByTestId('inspector-surface'));
  await page.locator('[data-inspector-tab="evidence"]').click();
  await page.getByTestId('nav-review').click();
  await expectVisible(page.getByTestId('review-workspace'));
}

async function returningUser(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  await expectVisible(page.getByTestId('page-review'));
  const reviewProgress = await page.locator('.progress-block').innerText().catch(() => '');
  await page.getByTestId('nav-views').click();
  await expectVisible(page.getByTestId('workspace-map'));
  const active = await activeViewId(page);
  const summaryVisible = await page.locator('.restore-summary').count();
  const conversationMessages = await page.locator('#conversationThread .message').count();
  const searchValue = await page.locator('#workspaceSearch').inputValue();
  const scrollTop = await page.locator('#viewWorkspace').evaluate(element => element.scrollTop);
  const hasScrollRange = await page.locator('#viewWorkspace').evaluate(element => element.scrollHeight > element.clientHeight + 20);
  const inspectorVisible = await page.getByTestId('inspector-surface').evaluate(element => element.classList.contains('active'));
  const evidenceSelected = await page.locator('[data-inspector-tab="evidence"]').getAttribute('aria-selected').catch(() => 'false');
  const selectedTargetId = await page.evaluate(() => localStorage.getItem('tabatlas.workspace.selectedTargetId') ?? '');
  const reviewSessionId = await page.evaluate(() => localStorage.getItem('tabatlas.workspace.reviewSessionId') ?? '');
  const storedPage = await page.evaluate(() => localStorage.getItem('tabatlas.workspace.page') ?? '');
  await page.getByTestId('nav-review').click();
  await expectVisible(page.getByTestId('review-workspace'));
  const restoredReviewProgress = await page.locator('.progress-block').innerText().catch(() => '');
  return {
    pass: Boolean(active) && summaryVisible > 0 && conversationMessages > 0 && Boolean(selectedTargetId)
      && Boolean(reviewSessionId) && searchValue === 'reference' && inspectorVisible
      && evidenceSelected === 'true' && /pending|done/i.test(restoredReviewProgress)
      && (!hasScrollRange || scrollTop >= 100) && storedPage !== 'settings',
    actual: `activeViewId=${active}; restoreSummary=${summaryVisible}; messages=${conversationMessages}; search="${searchValue}"; scrollTop=${scrollTop}; hasScrollRange=${hasScrollRange}; inspectorVisible=${inspectorVisible}; evidenceSelected=${evidenceSelected}; selectedTargetId=${selectedTargetId}; reviewSessionId=${reviewSessionId}; reviewBefore="${compact(reviewProgress)}"; reviewAfter="${compact(restoredReviewProgress)}"; storedPage=${storedPage}`,
  };
}

async function operationsSmoke(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  await page.evaluate(async () => {
    const headers = {
      'content-type': 'application/json',
      'x-tab-atlas-token': localStorage.getItem('tabatlas.localToken') ?? '',
    };
    await fetch('/api/security/capabilities', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'automation', label: 'Workspace UX automation smoke', scopes: ['api:read'] }),
    });
    await fetch('/api/security/capabilities', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'extension', label: 'chrome extension smoke', scopes: ['snapshot:write'] }),
    });
  });

  await openSettingsPanel(page, 'capture');
  await page.locator('#capturePath').fill(path.join(root, 'tests', 'fixture-snapshot.json'));
  await page.locator('#importButton').click();
  await expectText(page.locator('#captureStatus'), /ok|imported|resources|inserted/i);
  const importText = await page.locator('#captureStatus').innerText();

  await page.locator('#createPairingButton').click();
  await expectText(page.locator('#captureStatus'), /challenge|secret|pair_/i);
  const pairingText = await page.locator('#captureStatus').innerText();

  const extractionResponse = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/extract/run') && response.request().method() === 'POST'),
    page.locator('#runExtractionButton').click(),
  ]).then(([response]) => response);
  const extractionOk = extractionResponse.ok();
  await page.waitForTimeout(150);
  const extractionText = await page.locator('#captureStatus').innerText();

  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/jobs/codex-scan') && response.request().method() === 'POST'),
    page.locator('#createScanJobButton').click(),
  ]);
  await expectText(page.locator('#captureStatus'), /job|codex|queued|created/i);
  const scanText = await page.locator('#captureStatus').innerText();

  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/jobs/extraction') && response.request().method() === 'POST'),
    page.locator('#createExtractionJobButton').click(),
  ]);

  await openSettingsPanel(page, 'jobs');
  await expectVisible(page.locator('#jobsList'));
  const jobRows = await page.locator('#jobsList .ops-row').count();
  if (jobRows > 0) {
    await page.locator('#jobsList [data-job-action="retry"]').first().click();
    await page.locator('#jobsList [data-job-action="cancel"]').first().click();
  }
  const jobsText = await page.locator('#jobsList').innerText();

  await openSettingsPanel(page, 'view-ops');
  await page.locator('#acceptViewButton').click();
  await expectText(page.locator('#viewOpsStatus'), /accepted|Revision|status/i);
  await page.locator('#refineText').fill('Split practical and inspirational references.');
  await page.locator('#refineViewButton').click();
  await expectText(page.locator('#viewOpsStatus'), /Revision|view|proposed|accepted/i);
  const viewOpsText = await page.locator('#viewOpsStatus').innerText();

  await openSettingsPanel(page, 'security');
  await expectVisible(page.locator('[data-capability-kind="automation"]').first());
  await page.locator('[data-capability-kind="automation"][data-capability-action="rotate"]').first().click();
  await expectVisible(page.locator('.one-time-token'));
  const automationRotation = await page.locator('#securityRotationResult').innerText();
  await page.locator('[data-ack-rotated-token]').click();
  await page.locator('[data-capability-kind="extension"][data-capability-action="rotate"]').first().click();
  await expectText(page.locator('#securityRotationResult'), /requires re-pairing/i);
  const extensionRotation = await page.locator('#securityRotationResult').innerText();
  await page.locator('[data-extension-repair]').click();
  await expectText(page.locator('#securityRotationResult'), /re-pair challenge/i);
  const repairText = await page.locator('#securityRotationResult').innerText();

  const pass = /ok|imported|resources|inserted/i.test(importText)
    && /challenge|secret|pair_/i.test(pairingText)
    && extractionOk
    && /job|codex|queued|created/i.test(scanText)
    && jobRows > 0
    && /retry|cancel|queued|cancel/i.test(jobsText)
    && /Revision|view|proposed|accepted/i.test(viewOpsText)
    && /New automation token/i.test(automationRotation)
    && /requires re-pairing/i.test(extensionRotation)
    && /re-pair challenge/i.test(repairText);

  return {
    pass,
    actual: `import="${compact(importText)}"; pairing="${compact(pairingText)}"; extractionOk=${extractionOk}; extraction="${compact(extractionText)}"; scan="${compact(scanText)}"; jobRows=${jobRows}; jobs="${compact(jobsText)}"; viewOps="${compact(viewOpsText)}"; automationRotation="${compact(automationRotation)}"; extensionRotation="${compact(extensionRotation)}"; repair="${compact(repairText)}"`,
  };
}

async function extensionRepairExecutable(page: Page): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  const created = await page.evaluate(async () => {
    const headers = {
      'content-type': 'application/json',
      'x-tab-atlas-token': localStorage.getItem('tabatlas.localToken') ?? '',
    };
    const response = await fetch('/api/security/capabilities', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'extension', label: 'chrome extension executable repair smoke', scopes: ['snapshot:write'] }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<{ token: string; capability: { id: string } }>;
  });

  await page.reload({ waitUntil: 'networkidle' });
  await openSettingsPanel(page, 'security');
  await page.locator(`[data-capability-action="rotate"][data-capability-id="${created.capability.id}"]`).click();
  await expectText(page.locator('#securityRotationResult'), /requires re-pairing/i);
  await page.locator(`[data-extension-repair="${created.capability.id}"]`).click();
  await expectText(page.locator('#securityRotationResult'), /re-pair challenge/i);
  const tokens = await page.locator('#securityRotationResult .one-time-token').evaluateAll(elements => elements.map(element => element.textContent?.trim() ?? ''));
  const [challengeId, secret] = tokens;
  if (!challengeId || !secret) throw new Error('extension repair did not display a challenge ID and secret');

  const exchange = await page.evaluate(async ({ challengeId, secret }) => {
    const response = await fetch('/api/security/pairing-codes/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, secret, label: 'chrome extension executable repair smoke repaired', browser: 'chrome' }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<{ token: string; capability: { id: string } }>;
  }, { challengeId, secret });

  const deniedOld = await postSnapshotWithToken(page, created.token, 'old-extension-token-denial');
  const acceptedNew = await postSnapshotWithToken(page, exchange.token, 'new-extension-token-accepted');
  await page.locator('[data-ack-pairing-secret]').click();
  const secretBlocksAfterAck = await page.locator('#securityRotationResult .one-time-token').count();
  const dbEvidence = readExtensionRepairEvidence(created.capability.id, exchange.capability.id, challengeId, secret, created.token, exchange.token);

  const pass = deniedOld.status === 401
    && acceptedNew.status === 200
    && Boolean(acceptedNew.snapshotId)
    && secretBlocksAfterAck === 0
    && dbEvidence.oldCapabilityRevoked
    && dbEvidence.newCapabilityActive
    && dbEvidence.repairAuditPresent
    && dbEvidence.noSecretOrTokenMaterialStored;
  return {
    pass,
    actual: `oldStatus=${deniedOld.status}; newStatus=${acceptedNew.status}; oldCapability=${created.capability.id}; newCapability=${exchange.capability.id}; challenge=${challengeId}; snapshot=${acceptedNew.snapshotId ?? '(missing)'}; secretBlocksAfterAck=${secretBlocksAfterAck}; db=${JSON.stringify(dbEvidence)}`,
  };
}

async function reviewQueuesExecutable(page: Page, sourceViewId: string): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  const expectedWeak = sourceViewResourceIdsForStates(sourceViewId, ['weak_include', 'needs_review']);
  const expectedConflict = sourceViewResourceIdsForStates(sourceViewId, ['conflict']);
  const expectedExtractionFailures = extractionFailureResourceCount();
  const weak = await startReviewQueueThroughUi(page, sourceViewId, 'weak');
  const conflict = await startReviewQueueThroughUi(page, sourceViewId, 'conflict');
  const extractionFailure = await startReviewQueueThroughUi(page, sourceViewId, 'extraction_failure');
  const unmarked = await startReviewQueueThroughUi(page, sourceViewId, 'unmarked');

  const pass = weak.sourceViewId === sourceViewId
    && weak.totalItems === expectedWeak.length
    && weak.distinctItems === weak.totalItems
    && weak.currentVisible
    && conflict.sourceViewId === sourceViewId
    && conflict.totalItems === expectedConflict.length
    && conflict.distinctItems === conflict.totalItems
    && extractionFailure.totalItems === expectedExtractionFailures
    && extractionFailure.distinctItems === extractionFailure.totalItems
    && unmarked.totalItems > 0
    && unmarked.distinctItems === unmarked.totalItems;
  return {
    pass,
    actual: `weak=${weak.totalItems}/${expectedWeak.length}, distinct=${weak.distinctItems}, source=${weak.sourceViewId}; conflict=${conflict.totalItems}/${expectedConflict.length}; extractionFailures=${extractionFailure.totalItems}/${expectedExtractionFailures}; unmarked=${unmarked.totalItems}; sessions=${[weak.sessionId, conflict.sessionId, extractionFailure.sessionId, unmarked.sessionId].join(',')}`,
    metrics: {
      weakItems: weak.totalItems,
      conflictItems: conflict.totalItems,
      extractionFailureItems: extractionFailure.totalItems,
      unmarkedItems: unmarked.totalItems,
    },
  };
}

async function mixedConversationExecutable(page: Page, sourceViewId: string): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  await resetConversationWorkspace(page, sourceViewId, 'board');
  const beforeViewId = await activeViewId(page);
  await submitConversation(page, 'Switch to gallery and exclude pure tutorials.');
  await page.waitForFunction((previous: string) => localStorage.getItem('tabatlas.workspace.activeViewId') !== previous, beforeViewId, { timeout: 20_000 });
  await expectVisible(page.getByTestId('workspace-gallery'));
  const afterViewId = await activeViewId(page);
  const snapshot = await conversationSnapshot(page);
  const assistant = [...snapshot.messages].reverse().find((message: { role: string }) => message.role === 'assistant') as { context?: { presentationPlan?: { actions?: Array<{ kind: string; layout?: string }> } } } | undefined;
  const hasGalleryPlan = Boolean(assistant?.context?.presentationPlan?.actions?.some(action => action.kind === 'set_layout' && action.layout === 'gallery'));
  const refined = snapshot.actions.find((action: { kind: string; status: string; result?: unknown }) => action.kind === 'refine_view' && action.status === 'succeeded');
  const galleryCards = await page.locator('.resource-card.gallery').count();
  const pass = beforeViewId !== afterViewId && hasGalleryPlan && Boolean(refined) && galleryCards > 0;
  return {
    pass,
    actual: `beforeView=${beforeViewId}; afterView=${afterViewId}; hasGalleryPlan=${hasGalleryPlan}; refined=${Boolean(refined)}; galleryCards=${galleryCards}`,
  };
}

async function serverOwnedUndoExecutable(page: Page, sourceViewId: string): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  const [restorable, staleTarget] = readMembershipsForUndo(sourceViewId, 2);
  if (!restorable || !staleTarget) throw new Error('server-owned undo scenario needs two memberships');
  const first = await postMembershipFeedback(page, {
    viewId: sourceViewId,
    membershipId: restorable.membershipId,
    targetKind: restorable.targetKind,
    targetId: restorable.targetId,
    decision: 'pin_exclude',
    correction: {
      previousMembership: { state: 'forged_state', section: 'forged_section' },
      sectionSuggestion: 'Executable undo',
    },
    reason: 'Executable forged previous state should be ignored.',
  });
  const storedFirst = readMembershipFeedbackEvidence(first.id);
  const undoFirst = await undoMembershipFeedback(page, first.id);
  const restored = readMembership(restorable.membershipId);

  const staleFirst = await postMembershipFeedback(page, {
    viewId: sourceViewId,
    membershipId: staleTarget.membershipId,
    targetKind: staleTarget.targetKind,
    targetId: staleTarget.targetId,
    decision: 'correct',
    correction: { sectionSuggestion: 'First stale correction' },
    reason: 'First stale correction.',
  });
  await postMembershipFeedback(page, {
    viewId: sourceViewId,
    membershipId: staleTarget.membershipId,
    targetKind: staleTarget.targetKind,
    targetId: staleTarget.targetId,
    decision: 'correct',
    correction: { sectionSuggestion: 'Second stale correction' },
    reason: 'Second stale correction.',
  });
  const staleUndo = await undoMembershipFeedback(page, staleFirst.id);

  const pass = first.id
    && storedFirst.hasUndo
    && !storedFirst.correctionJson.includes('previousMembership')
    && !storedFirst.correctionJson.includes('forged_state')
    && undoFirst.ok
    && restored.state === restorable.state
    && staleUndo.status >= 400;
  return {
    pass: Boolean(pass),
    actual: `feedback=${first.id}; undoStatus=${undoFirst.status}; restored=${restored.state}/${restorable.state}; sanitized=${!storedFirst.correctionJson.includes('previousMembership')}; staleFeedback=${staleFirst.id}; staleUndoStatus=${staleUndo.status}`,
  };
}

async function presentationReplayExecutable(page: Page, sourceViewId: string): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  await resetConversationWorkspace(page, sourceViewId, 'board');
  await submitConversation(page, 'Switch to gallery.');
  await expectVisible(page.getByTestId('workspace-gallery'));
  await page.evaluate((viewId: string) => {
    localStorage.setItem('tabatlas.workspace.activeViewId', viewId);
    localStorage.setItem('tabatlas.workspace.layout', 'board');
    localStorage.setItem('tabatlas.workspace.page', 'views');
  }, sourceViewId);
  await page.reload({ waitUntil: 'networkidle' });
  await expectVisible(page.getByTestId('workspace-board'));

  const beforeViewId = await activeViewId(page);
  await submitConversation(page, 'Refine this view to exclude pure tutorials.');
  await page.waitForFunction((previous: string) => localStorage.getItem('tabatlas.workspace.activeViewId') !== previous, beforeViewId, { timeout: 20_000 });
  await expectVisible(page.getByTestId('workspace-board'));
  const layout = await page.evaluate(() => localStorage.getItem('tabatlas.workspace.layout') ?? '');
  const galleryVisible = await page.getByTestId('workspace-gallery').isVisible().catch(() => false);
  const boardVisible = await page.getByTestId('workspace-board').isVisible().catch(() => false);
  const pass = layout === 'board' && boardVisible && !galleryVisible;
  return {
    pass,
    actual: `beforeView=${beforeViewId}; afterView=${await activeViewId(page)}; layout=${layout}; boardVisible=${boardVisible}; galleryVisible=${galleryVisible}`,
  };
}

async function revisionComparisonExecutable(page: Page, sourceViewId: string): Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }> {
  await resetConversationWorkspace(page, sourceViewId, 'board');
  await submitConversation(page, 'Compare this with the previous revision.');
  await expectVisible(page.locator('.revision-comparison'));
  const text = await page.locator('.revision-comparison').innerText();
  const pass = /Revision 2 vs 1/i.test(text)
    && /\d+ added|\d+ removed|\d+ changed/i.test(text)
    && /Goal|Rules|Removed targets|Changed memberships/i.test(text);
  return {
    pass,
    actual: compact(text),
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
    const pass = metrics.workspaceMs < (size === 1000 ? 6000 : 5000)
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

async function openSettingsPanel(page: Page, panel: string): Promise<void> {
  await page.locator('.secondary-nav').evaluate((element: Element) => { (element as HTMLDetailsElement).open = true; });
  await page.locator(`.secondary-nav-list [data-settings-panel="${panel}"]`).click();
  await expectVisible(page.getByTestId('page-settings'));
  await expectVisible(page.locator(`#settings-${panel}`));
}

async function openWorkspacePage(page: Page, pageName: 'ask' | 'views' | 'review'): Promise<void> {
  await page.locator(`[data-nav="${pageName}"]`).first().click();
  try {
    await page.waitForFunction((name: string) => {
      return document.querySelector(`#page-${name}`)?.classList.contains('active');
    }, pageName, { timeout: 3000 });
  } catch {
    await page.evaluate((name: string) => {
      localStorage.setItem('tabatlas.workspace.page', name);
    }, pageName);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction((name: string) => {
      return document.querySelector(`#page-${name}`)?.classList.contains('active');
    }, pageName, { timeout: 10_000 });
  }
}

async function openControlledReviewSession(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const headers = {
      'content-type': 'application/json',
      'x-tab-atlas-token': localStorage.getItem('tabatlas.localToken') ?? '',
    };
    const activeViewId = localStorage.getItem('tabatlas.workspace.activeViewId') ?? '';
    const resourceIds: string[] = [];
    if (activeViewId) {
      const response = await fetch(`/api/views/${encodeURIComponent(activeViewId)}/workspace?limit=100`, { headers });
      const workspace = await response.json();
      for (const section of workspace.sections as Array<{ cards: Array<{ targetKind: string; targetId: string }> }>) {
        for (const card of section.cards) {
          if (card.targetKind === 'resource' && !resourceIds.includes(card.targetId)) resourceIds.push(card.targetId);
          if (resourceIds.length >= 5) break;
        }
        if (resourceIds.length >= 5) break;
      }
    }
    if (resourceIds.length < 5) {
      const response = await fetch('/api/resources', { headers });
      const resources = await response.json() as Array<{ id: string }>;
      for (const resource of resources) {
        if (!resourceIds.includes(resource.id)) resourceIds.push(resource.id);
        if (resourceIds.length >= 5) break;
      }
    }
    const sessionResponse = await fetch('/api/review-sessions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'unmarked',
        title: 'Controlled triage smoke',
        resourceIds: resourceIds.slice(0, 5),
        preload: 5,
      }),
    });
    const session = await sessionResponse.json();
    localStorage.setItem('tabatlas.workspace.reviewSessionId', session.session.id);
    localStorage.setItem('tabatlas.workspace.page', 'review');
    return resourceIds.slice(0, 5);
  });
}

function expectedViewNameFor(commandText: string): string {
  return /tab-manager|project|architecture|extraction|packaging|safety/i.test(commandText)
    ? 'Tab manager project workspace'
    : 'Loose inspiration board';
}

async function activeViewId(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('tabatlas.workspace.activeViewId') ?? '');
}

async function postSnapshotWithToken(
  page: Page,
  token: string,
  label: string,
): Promise<{ status: number; ok: boolean; snapshotId?: string; text: string }> {
  return page.evaluate(async ({ token, label }) => {
    const response = await fetch('/snapshot', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tab-atlas-token': token,
      },
      body: JSON.stringify({
        capturedAt: '2026-06-19T01:00:00.000Z',
        tabs: [{
          browser: 'chrome',
          windowId: 1,
          tabId: Math.floor(Math.random() * 100000),
          index: 0,
          active: true,
          pinned: false,
          title: `Workspace UX repair smoke ${label}`,
          url: `https://example.test/tabatlas/${label}`,
          groupTitle: 'Workspace UX repair',
        }],
      }),
    });
    const text = await response.text();
    let snapshotId: string | undefined;
    try {
      const json = JSON.parse(text) as { snapshotId?: string };
      snapshotId = json.snapshotId;
    } catch {
      // Denials are small JSON strings, but the status is the assertion.
    }
    return { status: response.status, ok: response.ok, snapshotId, text: text.slice(0, 160) };
  }, { token, label });
}

function readExtensionRepairEvidence(
  oldCapabilityId: string,
  newCapabilityId: string,
  challengeId: string,
  secret: string,
  oldToken: string,
  newToken: string,
): {
  oldCapabilityRevoked: boolean;
  newCapabilityActive: boolean;
  repairAuditPresent: boolean;
  noSecretOrTokenMaterialStored: boolean;
} {
  return withEvalDb(db => {
    const oldCapability = db.prepare('SELECT status FROM local_capabilities WHERE id = ?').get(oldCapabilityId) as { status: string } | undefined;
    const newCapability = db.prepare('SELECT status FROM local_capabilities WHERE id = ?').get(newCapabilityId) as { status: string } | undefined;
    const repairAudit = db.prepare(`
      SELECT id
      FROM security_audit_events
      WHERE event_type = 'extension_repair'
        AND capability_id = ?
        AND details_json LIKE ?
      LIMIT 1
    `).get(oldCapabilityId, `%${challengeId}%`) as { id: string } | undefined;
    const rawRows = [
      ...db.prepare('SELECT id, kind, label, token_hash, status FROM local_capabilities').all() as unknown[],
      ...db.prepare('SELECT id, secret_hash, kind, browser, label, status, capability_id FROM pairing_challenges').all() as unknown[],
      ...db.prepare('SELECT id, event_type, reason, capability_id, details_json FROM security_audit_events').all() as unknown[],
    ];
    const persisted = JSON.stringify(rawRows);
    return {
      oldCapabilityRevoked: oldCapability?.status === 'revoked',
      newCapabilityActive: newCapability?.status === 'active',
      repairAuditPresent: Boolean(repairAudit),
      noSecretOrTokenMaterialStored: !persisted.includes(secret) && !persisted.includes(oldToken) && !persisted.includes(newToken),
    };
  });
}

function sourceViewResourceIdsForStates(sourceViewId: string, states: string[]): string[] {
  if (!states.length) return [];
  return withEvalDb(db => {
    const rows = db.prepare(`
      SELECT resource_id, MIN(position) AS first_seen
      FROM (
        SELECT
          CASE
            WHEN m.target_kind = 'resource' THEN m.target_id
            ELSE ai.resource_id
          END AS resource_id,
          m.rowid AS position
        FROM memberships m
        LEFT JOIN atomic_items ai ON ai.id = m.target_id AND m.target_kind = 'atomic_item'
        WHERE m.view_id = ?
          AND m.state IN (${states.map(() => '?').join(',')})
          AND (
            m.target_kind = 'resource'
            OR ai.resource_id IS NOT NULL
          )
      )
      WHERE resource_id IS NOT NULL
      GROUP BY resource_id
      ORDER BY first_seen
    `).all(sourceViewId, ...states) as Array<{ resource_id: string | null }>;
    return rows.flatMap(row => row.resource_id ? [row.resource_id] : []);
  });
}

function extractionFailureResourceCount(): number {
  return withEvalDb(db => {
    const row = db.prepare(`
      SELECT COUNT(DISTINCT id) AS count
      FROM (
        SELECT resource_id AS id
        FROM extraction_artifacts
        WHERE status LIKE 'failed%' OR error_code IS NOT NULL
        UNION
        SELECT resource_id AS id
        FROM resource_extraction_state
        WHERE status LIKE 'failed%' OR last_error IS NOT NULL
      )
    `).get() as { count: number };
    return row.count;
  });
}

async function startReviewQueueThroughUi(
  page: Page,
  sourceViewId: string,
  queue: 'weak' | 'conflict' | 'extraction_failure' | 'unmarked',
): Promise<{ sessionId: string; sourceViewId?: string; totalItems: number; distinctItems: number; currentVisible: boolean }> {
  await page.evaluate((viewId: string) => {
    localStorage.setItem('tabatlas.workspace.activeViewId', viewId);
    localStorage.setItem('tabatlas.workspace.page', 'review');
    localStorage.removeItem('tabatlas.workspace.reviewSessionId');
  }, sourceViewId);
  await page.reload({ waitUntil: 'networkidle' });
  await expectVisible(page.getByTestId('review-workspace'));
  await page.locator(`[data-review-start="${queue}"]`).click();
  await page.waitForFunction(() => Boolean(localStorage.getItem('tabatlas.workspace.reviewSessionId')), undefined, { timeout: 10_000 });
  const sessionId = await page.evaluate(() => localStorage.getItem('tabatlas.workspace.reviewSessionId') ?? '');
  await page.waitForTimeout(150);
  const currentVisible = await page.locator('.review-current').isVisible().catch(() => false);
  const evidence = readReviewSessionEvidence(sessionId);
  return { ...evidence, currentVisible };
}

function readReviewSessionEvidence(sessionId: string): { sessionId: string; sourceViewId?: string; totalItems: number; distinctItems: number } {
  return withEvalDb(db => {
    const session = db.prepare(`
      SELECT id, source_view_id, total_items
      FROM review_sessions
      WHERE id = ?
    `).get(sessionId) as { id: string; source_view_id: string | null; total_items: number } | undefined;
    if (!session) throw new Error(`Review session not found: ${sessionId}`);
    const distinct = db.prepare(`
      SELECT COUNT(DISTINCT resource_id) AS count
      FROM review_session_items
      WHERE session_id = ?
    `).get(sessionId) as { count: number };
    return {
      sessionId,
      sourceViewId: session.source_view_id ?? undefined,
      totalItems: session.total_items,
      distinctItems: distinct.count,
    };
  });
}

async function resetConversationWorkspace(page: Page, viewId: string, layout: 'board' | 'gallery' | 'map' | 'compact'): Promise<void> {
  await page.evaluate(({ viewId, layout }) => {
    localStorage.setItem('tabatlas.workspace.activeViewId', viewId);
    localStorage.setItem('tabatlas.workspace.layout', layout);
    localStorage.setItem('tabatlas.workspace.page', 'views');
    localStorage.setItem('tabatlas.workspace.workspaceStateFilters', 'visible');
    localStorage.setItem('tabatlas.workspace.workspaceTagFilters', '');
    localStorage.setItem('tabatlas.workspace.workspaceQueryFilter', '');
    localStorage.setItem('tabatlas.workspace.activeThreadId', '');
    localStorage.setItem('tabatlas.workspace.assistantPanel', 'conversation');
    localStorage.removeItem('tabatlas.workspace.reviewSessionId');
  }, { viewId, layout });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(localStorage.getItem('tabatlas.workspace.activeThreadId')), undefined, { timeout: 10_000 });
  if (layout === 'gallery') await expectVisible(page.getByTestId('workspace-gallery'));
  else if (layout === 'map') await expectVisible(page.getByTestId('workspace-map'));
  else await expectVisible(page.getByTestId('workspace-board'));
}

async function conversationSnapshot(page: Page): Promise<{
  messages: Array<{ role: string; context?: { presentationPlan?: { actions?: Array<{ kind: string; layout?: string }> } } }>;
  actions: Array<{ kind: string; status: string; result?: unknown }>;
}> {
  return page.evaluate(async () => {
    const threadId = localStorage.getItem('tabatlas.workspace.activeThreadId') ?? '';
    const headers = { 'x-tab-atlas-token': localStorage.getItem('tabatlas.localToken') ?? '' };
    const response = await fetch(`/api/conversations/${encodeURIComponent(threadId)}`, { headers });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
}

type MembershipForEval = {
  membershipId: string;
  targetKind: 'resource' | 'atomic_item';
  targetId: string;
  state: string;
};

function readMembershipsForUndo(viewId: string, limit: number): MembershipForEval[] {
  return withEvalDb(db => {
    const rows = db.prepare(`
      SELECT id, target_kind, target_id, state
      FROM memberships
      WHERE view_id = ?
      ORDER BY id
      LIMIT ?
    `).all(viewId, limit) as Array<{ id: string; target_kind: 'resource' | 'atomic_item'; target_id: string; state: string }>;
    return rows.map(row => ({
      membershipId: row.id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      state: row.state,
    }));
  });
}

function readMembership(membershipId: string): { state: string } {
  return withEvalDb(db => {
    const row = db.prepare('SELECT state FROM memberships WHERE id = ?').get(membershipId) as { state: string } | undefined;
    if (!row) throw new Error(`Membership not found: ${membershipId}`);
    return row;
  });
}

async function postMembershipFeedback(
  page: Page,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; id: string; text: string }> {
  const result = await page.evaluate(async body => {
    const response = await fetch('/api/membership-feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tab-atlas-token': localStorage.getItem('tabatlas.localToken') ?? '',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let id = '';
    try {
      id = (JSON.parse(text) as { id?: string }).id ?? '';
    } catch {
      // Error text is returned below.
    }
    return { ok: response.ok, status: response.status, id, text: text.slice(0, 160) };
  }, body);
  if (!result.ok || !result.id) throw new Error(`membership feedback failed: ${result.status} ${result.text}`);
  return result;
}

async function undoMembershipFeedback(page: Page, feedbackId: string): Promise<{ ok: boolean; status: number; text: string }> {
  return page.evaluate(async feedbackId => {
    const response = await fetch(`/api/membership-feedback/${encodeURIComponent(feedbackId)}/undo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tab-atlas-token': localStorage.getItem('tabatlas.localToken') ?? '',
      },
      body: '{}',
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text: text.slice(0, 160) };
  }, feedbackId);
}

function readMembershipFeedbackEvidence(feedbackId: string): { correctionJson: string; hasUndo: boolean } {
  return withEvalDb(db => {
    const feedback = db.prepare('SELECT correction_json FROM membership_feedback WHERE id = ?').get(feedbackId) as { correction_json: string | null } | undefined;
    const undo = db.prepare('SELECT feedback_id FROM membership_feedback_undo WHERE feedback_id = ?').get(feedbackId) as { feedback_id: string } | undefined;
    if (!feedback) throw new Error(`Feedback not found: ${feedbackId}`);
    return { correctionJson: feedback.correction_json ?? '', hasUndo: Boolean(undo) };
  });
}

function withEvalDb<T>(read: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(dbPath);
  try {
    return read(db);
  } finally {
    db.close();
  }
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
    localStorage.setItem('tabatlas.workspace.focusedSectionId', '');
    localStorage.setItem('tabatlas.workspace.workspaceStateFilters', 'visible');
    localStorage.setItem('tabatlas.workspace.workspaceTagFilters', '');
    localStorage.setItem('tabatlas.workspace.workspaceQueryFilter', '');
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

async function runAccessibilitySurfaces(page: Page): Promise<EvalReport['accessibility']> {
  const surfaces: Record<string, string[]> = {};
  await page.evaluate(() => {
    localStorage.setItem('tabatlas.workspace.focusedSectionId', '');
    localStorage.setItem('tabatlas.workspace.workspaceStateFilters', 'visible');
    localStorage.setItem('tabatlas.workspace.workspaceTagFilters', '');
    localStorage.setItem('tabatlas.workspace.workspaceQueryFilter', '');
    localStorage.setItem('tabatlas.workspace.layout', 'board');
  });
  await page.reload({ waitUntil: 'networkidle' });

  await openWorkspacePage(page, 'ask');
  await page.locator('#conversationTab').click();
  await expectVisible(page.getByTestId('conversation-surface'));
  surfaces['ask-conversation'] = (await axeAccessibilityCheck(page, 'ask-conversation')).issues;

  await openWorkspacePage(page, 'views');
  await page.getByTestId('view-toolbar').getByRole('button', { name: 'Board' }).click();
  await expectVisible(page.getByTestId('workspace-board'));
  await page.getByTestId('view-toolbar').getByRole('button', { name: 'Gallery' }).click();
  await expectVisible(page.getByTestId('workspace-gallery'));
  await page.getByTestId('view-toolbar').getByRole('button', { name: 'Map' }).click();
  await expectVisible(page.getByTestId('workspace-map'));
  surfaces['board-gallery-map'] = (await axeAccessibilityCheck(page, 'board-gallery-map')).issues;

  await page.locator('.resource-card').first().click();
  await expectVisible(page.getByTestId('inspector-surface'));
  await page.locator('[data-inspector-tab="evidence"]').click();
  surfaces.inspector = (await axeAccessibilityCheck(page, 'inspector')).issues;

  await openWorkspacePage(page, 'review');
  await expectVisible(page.getByTestId('review-workspace'));
  surfaces.review = (await axeAccessibilityCheck(page, 'review')).issues;

  await page.locator('.secondary-nav').evaluate((element: Element) => { (element as HTMLDetailsElement).open = true; });
  await page.locator('.secondary-nav-list [data-settings-panel="security"]').click();
  await expectVisible(page.getByTestId('page-settings'));
  surfaces.operations = (await axeAccessibilityCheck(page, 'operations')).issues;

  const issues = Object.entries(surfaces).flatMap(([surface, surfaceIssues]) => surfaceIssues.map(issue => `${surface}:${issue}`));
  return { pass: issues.length === 0, issues, surfaces };
}

async function axeAccessibilityCheck(page: Page, label: string): Promise<EvalReport['accessibility']> {
  const results = await new AxeBuilder({ page }).analyze();
  const issues = results.violations
    .filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(violation => `${violation.id}:${violation.nodes.length}`);
  return { pass: issues.length === 0, issues, surfaces: { [label]: issues } };
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
