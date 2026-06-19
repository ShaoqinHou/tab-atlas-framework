import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import { addUserAnnotation } from '../src/annotations/service.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { createUserCommand, persistSemanticViewPlan } from '../src/views/service.js';
import { createCapability } from '../src/security/localCapability.js';
import { validateRoleplayScenarioCoverage, workspaceRoleplayScenarios } from '../src/presentation/roleplayScenarios.js';
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

type EvalReport = {
  ok: boolean;
  generatedAt: string;
  viewId: string;
  reportPath: string;
  scenarioCount: number;
  accessibility: {
    pass: boolean;
    issues: string[];
  };
  scenarios: ScenarioResult[];
};

const root = process.cwd();
const outputRoot = path.join(root, '.local', 'workspace-ux-eval');
const dbPath = path.join(outputRoot, 'workspace-ux.sqlite');
const port = Number(process.env.TABATLAS_WORKSPACE_UX_PORT ?? 9893);
const baseUrl = `http://127.0.0.1:${port}`;

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const seeded = seedDatabase(dbPath);
const server = startServer(dbPath, port);

try {
  await waitForServer();
  const report = await runBrowserEvaluation(seeded.viewId, seeded.token);
  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2));
  printReport(report);
  if (!report.ok) process.exitCode = 1;
} finally {
  await stopServer(server);
}

function seedDatabase(targetDbPath: string): { viewId: string; token: string } {
  const db = openDatabase(targetDbPath);
  try {
    const tabs = Array.from({ length: 1000 }, (_, index) => {
      const bucket = index % 5;
      const title = bucket === 0
        ? `Forest game mood reference ${index}`
        : bucket === 1
          ? `Interface gallery pattern ${index}`
          : bucket === 2
            ? `Audio cue ambience ${index}`
            : bucket === 3
              ? `Conflicting research note ${index}`
              : `Archive database unrelated ${index}`;
      return {
        browser: index % 2 ? 'edge' : 'chrome',
        title,
        url: `https://example.test/workspace/${index}?secret=redacted-${index}`,
        groupTitle: bucket === 0 ? 'Game mood' : bucket === 1 ? 'UI refs' : bucket === 3 ? 'Conflicts' : '',
      };
    });
    importSnapshot(db, { capturedAt: '2026-06-19T00:00:00.000Z', tabs }, 'workspace_ux_eval');

    const resources = db.prepare(`
      SELECT id, title_best AS title
      FROM resources
      ORDER BY title_best
    `).all() as Array<{ id: string; title: string }>;

    const commandText = 'Make a visual workspace for forest game inspiration, UI references, audio cues, and uncertain conflicts.';
    const commandId = createUserCommand(db, commandText, { eval: 'workspace_ux' }, 'cmd_workspace_ux_eval');
    const memberships = resources.map((resource, index) => {
      const title = resource.title.toLowerCase();
      const state: MembershipState = title.includes('archive database')
        ? 'exclude'
        : title.includes('conflicting')
          ? 'conflict'
          : index % 9 === 0
            ? 'needs_review'
            : index % 7 === 0
              ? 'weak_include'
              : 'strong_include';
      const section = title.includes('interface')
        ? 'Interface references'
        : title.includes('audio')
          ? 'Audio cues'
          : title.includes('conflicting')
            ? 'Conflicts'
            : 'Forest mood';
      return {
        targetKind: 'resource' as const,
        targetId: resource.id,
        section,
        state,
        confidence: state === 'strong_include' ? 0.9 : state === 'weak_include' ? 0.54 : state === 'conflict' ? 0.61 : state === 'needs_review' ? 0.48 : 0.8,
        reason: state === 'exclude'
          ? 'Archive database material is unrelated to the workspace.'
          : `Title and tab group connect this resource to ${section}.`,
        evidenceRefs: state === 'exclude' ? [] : [`title:${resource.id}`],
        conflict: state === 'conflict' ? 'The title suggests relevance, but the note conflicts with the workspace goal.' : undefined,
      };
    });

    const plan: SemanticViewPlan = {
      commandText,
      views: [{
        name: 'Forest game visual workspace',
        description: 'Role-play evaluation view with many resources.',
        goal: 'Help an agent and user inspect a large visual tab workspace without losing context.',
        inclusionRules: ['Include game mood, UI references, and audio cues.'],
        exclusionRules: ['Hide unrelated archive/database resources.'],
        sections: ['Forest mood', 'Interface references', 'Audio cues', 'Conflicts'],
        confidence: 0.88,
        memberships,
      }],
      reviewQueues: [{
        queueName: 'uncertain',
        reason: 'Weak and needs-review resources should be checked before use.',
        targetIds: memberships
          .filter(membership => membership.state === 'weak_include' || membership.state === 'needs_review')
          .slice(0, 40)
          .map(membership => membership.targetId),
      }],
      explanation: 'Seeded role-play view for the agent visual workspace gate.',
    };
    const persisted = persistSemanticViewPlan(db, commandId, plan, {
      origin: 'workspace_ux_eval',
      viewIds: ['view_workspace_ux_eval'],
    });

    const firstResource = resources.find(resource => resource.title.includes('Forest game mood reference'));
    if (firstResource) {
      addUserAnnotation(db, {
        id: 'ann_workspace_ux_eval',
        targetKind: 'resource',
        targetId: firstResource.id,
        tags: ['moodboard', 'forest'],
        description: 'Use this as the strongest first visual anchor.',
        decision: 'inspiration',
        source: 'resource_detail',
        createdAt: '2026-06-19T00:00:00.000Z',
      });
    }

    const { token } = createCapability(db, {
      kind: 'ui',
      label: 'Workspace UX evaluation',
      scopes: ['admin'],
    });
    return { viewId: persisted.viewIds[0], token };
  } finally {
    db.close();
  }
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

async function runBrowserEvaluation(viewId: string, token: string): Promise<EvalReport> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const scenarios: ScenarioResult[] = [];
  try {
    await page.addInitScript(({ savedToken, savedViewId }) => {
      localStorage.setItem('tabatlas.localToken', savedToken);
      localStorage.setItem('tabatlas.workspace.activeViewId', savedViewId);
      localStorage.setItem('tabatlas.workspace.page', 'views');
    }, { savedToken: token, savedViewId: viewId });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await expectVisible(page.getByTestId('page-views'));
    await page.screenshot({ path: path.join(outputRoot, '00-initial-views.png'), fullPage: true });

    const coverageIssues = validateRoleplayScenarioCoverage();
    scenarios.push(resultFromCheck(
      'scenario_coverage',
      'Scaffold scenarios cover visual, cautious, overwhelmed, power, and novice roles.',
      coverageIssues.length === 0,
      coverageIssues.length ? coverageIssues.join('; ') : `${workspaceRoleplayScenarios.length} scenarios ready`,
    ));

    scenarios.push(await runScenario(page, {
      id: 'visual_first_gallery',
      persona: 'Visual-first collector',
      expected: 'A user can switch from board to gallery and still see resource cards.',
      run: async () => {
        await page.getByTestId('view-toolbar').getByRole('button', { name: 'Gallery' }).click();
        await expectVisible(page.getByTestId('workspace-gallery'));
        const cardCount = await page.locator('.resource-card.gallery').count();
        return { actual: `galleryCards=${cardCount}`, pass: cardCount > 0 };
      },
    }));

    scenarios.push(await runScenario(page, {
      id: 'cautious_inspector',
      persona: 'Cautious verifier',
      expected: 'Opening a card reveals inspector evidence without leaving the workspace.',
      run: async () => {
        await page.locator('.resource-card').first().click();
        await page.getByRole('button', { name: 'Evidence' }).click();
        await expectVisible(page.getByTestId('inspector-surface'));
        const evidenceRows = await page.locator('.evidence-row').count();
        return { actual: `evidenceRows=${evidenceRows}`, pass: evidenceRows > 0 };
      },
    }));

    scenarios.push(await runScenario(page, {
      id: 'conversation_filter_map',
      persona: 'Overwhelmed sorter',
      expected: 'A conversational instruction switches to map layout and filters conflicts.',
      run: async () => {
        await page.locator('#conversationTab').click();
        await page.locator('#conversationInput').fill('show conflicts as a map');
        await page.getByRole('button', { name: 'Send' }).click();
        await expectVisible(page.getByTestId('workspace-map'));
        const clusters = await page.locator('.map-cluster').count();
        return { actual: `mapClusters=${clusters}`, pass: clusters > 0 };
      },
    }));

    scenarios.push(await runScenario(page, {
      id: 'review_uncertain',
      persona: 'Review-focused curator',
      expected: 'The agent can open a focused review queue for uncertain items.',
      run: async () => {
        await page.locator('#conversationTab').click();
        await page.locator('#conversationInput').fill('review uncertain items');
        await page.getByRole('button', { name: 'Send' }).click();
        await expectVisible(page.getByTestId('page-review'));
        await expectVisible(page.locator('[data-review-decision="important"]'));
        return { actual: 'review decision controls visible', pass: true };
      },
    }));

    scenarios.push(await runScenario(page, {
      id: 'keyboard_review_decision',
      persona: 'Power reviewer',
      expected: 'Keyboard review decision advances the queue.',
      run: async () => {
        const before = await page.locator('.progress-block').innerText();
        await page.keyboard.press('1');
        await page.waitForTimeout(250);
        const after = await page.locator('.progress-block').innerText();
        return { actual: `before=${compact(before)}; after=${compact(after)}`, pass: before !== after };
      },
    }));

    scenarios.push(await runScenario(page, {
      id: 'large_workspace_budget',
      persona: 'Large-library user',
      expected: 'A 1000-resource view stays bounded in the DOM and renders quickly.',
      run: async () => {
        const started = Date.now();
        await page.getByTestId('nav-views').click();
        await page.getByTestId('view-toolbar').getByRole('button', { name: 'Board' }).click();
        await page.locator('[data-state-filter="visible"]').click();
        await expectVisible(page.getByTestId('workspace-board'));
        const elapsedMs = Date.now() - started;
        const domNodes = await page.locator('*').count();
        const cards = await page.locator('.resource-card').count();
        return {
          actual: `elapsedMs=${elapsedMs}; domNodes=${domNodes}; cards=${cards}`,
          pass: elapsedMs < 4000 && domNodes < 2500 && cards > 0 && cards <= 120,
          metrics: { elapsedMs, domNodes, cards },
        };
      },
    }));

    const accessibility = await lightweightAccessibilityCheck(page);
    const ok = scenarios.every(scenario => scenario.pass) && accessibility.pass;
    return {
      ok,
      generatedAt: new Date().toISOString(),
      viewId,
      reportPath: path.join(outputRoot, 'report.json'),
      scenarioCount: scenarios.length,
      accessibility,
      scenarios,
    };
  } finally {
    await browser.close();
  }
}

async function runScenario(
  page: Page,
  input: {
    id: string;
    persona: string;
    expected: string;
    run: () => Promise<{ pass: boolean; actual: string; metrics?: Record<string, number> }>;
  },
): Promise<ScenarioResult> {
  const errors: string[] = [];
  const screenshot = path.join(outputRoot, `${input.id}.png`);
  try {
    const result = await input.run();
    await page.screenshot({ path: screenshot, fullPage: true });
    return {
      id: input.id,
      persona: input.persona,
      expected: input.expected,
      pass: result.pass,
      actual: result.actual,
      screenshot,
      metrics: result.metrics,
      errors,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    return {
      id: input.id,
      persona: input.persona,
      expected: input.expected,
      pass: false,
      actual: 'scenario threw',
      screenshot,
      errors,
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

async function expectVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 5000 });
}

async function lightweightAccessibilityCheck(page: Page): Promise<EvalReport['accessibility']> {
  const issues = await page.evaluate(() => {
    const found: string[] = [];
    for (const button of document.querySelectorAll('button')) {
      const label = button.textContent?.trim() || button.getAttribute('aria-label') || button.getAttribute('title');
      if (!label) found.push('button_without_name');
    }
    for (const input of document.querySelectorAll('input, textarea, select')) {
      const id = input.getAttribute('id');
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const aria = input.getAttribute('aria-label') || input.getAttribute('placeholder');
      if (!label && !aria) found.push(`field_without_name:${id ?? input.tagName.toLowerCase()}`);
    }
    return found;
  });
  return { pass: issues.length === 0, issues };
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
