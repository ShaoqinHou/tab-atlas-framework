import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { addUserAnnotation } from '../src/annotations/service.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { ensureDatabaseIdentity, readDatabaseIdentity } from '../src/runtime/databaseIdentity.js';
import { fingerprintDatabase, sameDatabaseFingerprint } from '../src/runtime/databaseFingerprint.js';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

type TabSeed = {
  title: string;
  url: string;
  groupTitle: string;
  browser?: 'chrome' | 'edge';
};

const root = process.cwd();
const outputRoot = path.join(root, '.local', 'pilot-readiness-fixture-eval');
const sourceDb = path.join(outputRoot, 'source-production.sqlite');
const cloneDb = path.join(outputRoot, 'clone-roleplay.sqlite');
const bootstrapDir = path.join(outputRoot, 'bootstrap');
const port = Number(process.env.TABATLAS_PILOT_READINESS_PORT ?? 9894);
const baseUrl = `http://127.0.0.1:${port}`;
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!await canBind(port)) {
  throw new Error(`Pilot readiness fixture evaluation port ${port} is not available.`);
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

seedSourceDatabase(sourceDb);
const sourceBefore = fingerprintDatabase(sourceDb);
await cloneSourceDatabase(sourceDb, cloneDb);
const cloneIdentity = readDatabaseIdentity(cloneDb);
if (!cloneIdentity || cloneIdentity.environment !== 'clone' || cloneIdentity.sourceDatabaseId !== sourceBefore.databaseId) {
  throw new Error('Pilot readiness fixture clone identity verification failed.');
}

const server = startServer();
let browser: Browser | undefined;
try {
  await waitForServer(server, 30_000);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = await runBrowserEvaluation(page);
  await browser.close();
  browser = undefined;

  const sourceAfter = fingerprintDatabase(sourceDb);
  const cloneAfter = fingerprintDatabase(cloneDb);
  results.push(result(
    'Runtime isolation',
    'UI interactions create state only in the role-play clone and leave the source production fixture unchanged',
    `sourceUnchanged=${sameDatabaseFingerprint(sourceBefore, sourceAfter)}; cloneConversations=${cloneAfter.counts.conversations}; cloneViews=${cloneAfter.counts.views}; cloneActions=${cloneAfter.counts.actions}`,
    sameDatabaseFingerprint(sourceBefore, sourceAfter)
      && cloneAfter.databaseId === cloneIdentity.databaseId
      && cloneAfter.counts.conversations > sourceBefore.counts.conversations
      && cloneAfter.counts.views > sourceBefore.counts.views,
  ));

  const report = {
    ok: results.every(item => item.pass),
    scope: 'Pilot readiness fixture evaluation. This is a regression gate, not pre-human role-play evidence.',
    generatedAt: new Date().toISOString(),
    sourceDatabaseId: sourceBefore.databaseId,
    cloneDatabaseId: cloneIdentity.databaseId,
    cloneSourceDatabaseId: cloneIdentity.sourceDatabaseId,
    results,
  };
  const reportPath = path.join(outputRoot, 'pilot-readiness-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const item of results) {
    console.log(`Case: ${item.caseName}`);
    console.log(`Expected: ${item.expected}`);
    console.log(`Actual: ${item.actual}`);
    console.log(`Pass/fail: ${item.pass ? 'pass' : 'fail'}`);
    console.log('');
  }
  console.log(`Pilot readiness fixture report written to ${reportPath}`);
  if (!report.ok) process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer(server);
}

async function runBrowserEvaluation(page: Page): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  const setupVisible = await page.locator('.setup-prompt').isVisible({ timeout: 10_000 }).catch(() => false);
  await page.locator('#continueSetupButton').click();
  const settingsOpened = await page.locator('#page-settings.active #settings-security').isVisible({ timeout: 10_000 }).catch(() => false);
  await bootstrapDashboard(page);
  await createEvalExtensionCapability(page);

  results.push(await reviewOverlapCase(page));
  results.push(await knowledgeMinerCase(page));
  results.push(await sectionFidelityCase(page));
  const hiddenAfterCompletion = await setupPromptHidden(page);
  results.unshift(result(
    'Onboarding',
    'Setup prompt is visible from Ask, Continue opens the existing setup panel, and completed setup hides the prompt',
    `visible=${setupVisible}; settingsOpened=${settingsOpened}; hiddenAfterCompletion=${hiddenAfterCompletion}`,
    setupVisible && settingsOpened && hiddenAfterCompletion,
  ));
  return results;
}

async function bootstrapDashboard(page: Page): Promise<void> {
  const secret = await waitForBootstrapSecret(bootstrapDir, 10_000);
  await page.locator('#bootstrapSecret').fill(secret);
  await page.locator('#bootstrapButton').click();
  await page.waitForResponse(response => response.url().includes('/api/onboarding/bootstrap') && response.ok(), { timeout: 10_000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'visible', timeout: 10_000 });
}

async function createEvalExtensionCapability(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const response = await fetch('/api/security/capabilities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'extension',
        label: 'Pilot readiness paired extension fixture',
        scopes: ['snapshot:write', 'api:read'],
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    });
    if (!response.ok) throw new Error(`extension capability failed: ${response.status}`);
  });
}

async function setupPromptHidden(page: Page): Promise<boolean> {
  await page.getByTestId('nav-ask').click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  return await page.locator('.setup-prompt').count() === 0;
}

async function reviewOverlapCase(page: Page): Promise<EvalResult> {
  const viewports = [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1024, height: 800 },
  ];
  const decisions = ['important', 'watch_later', 'project_reference', 'inspiration', 'skip', 'ignore'];
  const actual: string[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      localStorage.removeItem('tabatlas.workspace.reviewSessionId');
      localStorage.setItem('tabatlas.workspace.page', 'ask');
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('nav-review').click();
    await page.locator('[data-review-start="unmarked"]').click();
    await page.waitForSelector('.review-current [data-review-inspect]', { state: 'visible', timeout: 10_000 });
    const beforeTyping = await page.locator('.review-current [data-review-inspect]').getAttribute('data-review-inspect');
    await page.locator('#reviewNote').fill('typing S and I here should not submit');
    const afterTyping = await page.locator('.review-current [data-review-inspect]').getAttribute('data-review-inspect');
    for (const decision of decisions) {
      await page.locator('#reviewNote').fill(decision === 'important' ? 'pilot eval note' : '');
      await page.locator(`[data-review-decision="${decision}"]`).click({ timeout: 10_000 });
      await page.waitForTimeout(150);
    }
    const progress = await page.locator('.progress-block').innerText().catch(() => '');
    actual.push(`${viewport.width}x${viewport.height}: typingSafe=${beforeTyping === afterTyping}; progress=${compact(progress)}`);
  }
  return result(
    'Review overlap',
    'Every decision button is clickable at all target viewports and typing S/I in the note does not trigger shortcuts',
    actual.join(' | '),
    actual.every(item => item.includes('typingSafe=true')),
  );
}

async function knowledgeMinerCase(page: Page): Promise<EvalResult> {
  await page.getByTestId('nav-ask').click();
  await sendConversation(page, 'What do we actually know inside these videos? Be honest about transcripts and improve evidence only for relevant videos.');
  await page.waitForFunction(() => document.querySelector('#conversationThread')?.textContent?.includes('Evidence readiness'), undefined, { timeout: 30_000 });
  const text = await page.locator('#conversationThread').innerText();
  const action = latestAction('scan_resources');
  const boundedIds = Array.isArray(action?.resourceIds) ? action.resourceIds.length : 0;
  return result(
    'Knowledge Miner',
    'Conversation reports known atomic items, metadata-only videos, unavailable transcripts, and one bounded targeted scan action',
    `hasKnown=${/Known atomic items/i.test(text)}; hasMetadataOnly=${/metadata only/i.test(text)}; hasUnavailable=${/Unavailable transcripts/i.test(text)}; actionKind=${action?.kind}; boundedIds=${boundedIds}`,
    /Known atomic items/i.test(text)
      && /metadata only/i.test(text)
      && /Unavailable transcripts/i.test(text)
      && action?.kind === 'scan_resources'
      && boundedIds > 0
      && boundedIds <= 8,
  );
}

async function sectionFidelityCase(page: Page): Promise<EvalResult> {
  const requested = ['Extension', 'Receiver', 'Codex', 'Storage', 'Extraction', 'Transcripts', 'Security', 'UX', 'Installation', 'Packaging', 'Testing'];
  await sendConversation(page, 'Build a TabAtlas project board with sections extension, receiver, Codex, storage, extraction, transcripts, security, UX, installation, packaging, testing.');
  await page.getByTestId('nav-views').click();
  await page.waitForSelector('[data-testid="view-workspace"]', { state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => (document.querySelector('[data-testid="view-workspace"]')?.textContent ?? '').includes('Extension'), undefined, { timeout: 30_000 });
  const workspaceText = await page.getByTestId('view-workspace').innerText();
  const visible = requested.filter(section => workspaceText.includes(section));
  const genericOther = /\bOther\b/.test(workspaceText);
  return result(
    'Section fidelity',
    'Requested dimensions remain visible or are transparently merged, without generic unexplained Other collapse',
    `visible=${visible.join(',')}; genericOther=${genericOther}`,
    visible.length >= 8 && !genericOther,
  );
}

async function sendConversation(page: Page, text: string): Promise<void> {
  await page.locator('#conversationInput').fill(text);
  await page.getByTestId('conversation-form').locator('button[type="submit"]').click();
  await page.waitForFunction(
    content => [...document.querySelectorAll('#conversationThread .message.user')]
      .some(element => element.textContent?.includes(content as string)),
    text.slice(0, 40),
    { timeout: 10_000 },
  );
}

function latestAction(kind: string): Record<string, unknown> | null {
  const db = openDatabase(cloneDb);
  try {
    const row = db.prepare(`
      SELECT action_json
      FROM agent_actions
      WHERE action_kind = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(kind) as { action_json: string } | undefined;
    return row ? JSON.parse(row.action_json) as Record<string, unknown> : null;
  } finally {
    db.close();
  }
}

function seedSourceDatabase(databasePath: string): void {
  const db = openDatabase(databasePath);
  try {
    ensureDatabaseIdentity(db, {
      runtimeProfile: 'production',
      environment: 'production',
      allowInitialize: true,
    });
    importSnapshot(db, {
      capturedAt: '2026-06-25T00:00:00.000Z',
      tabs: pilotTabs(),
    }, 'pilot_readiness_seed');
    const resources = db.prepare('SELECT id, title_best AS title FROM resources ORDER BY title_best').all() as Array<{ id: string; title: string }>;
    seedEvidence(db, resources);
    seedAtomicItems(db, resources);
    seedOneAnnotation(db, resources);
  } finally {
    db.close();
  }
}

function pilotTabs(): TabSeed[] {
  const requested = [
    ['Extension popup capture safety', 'extension'],
    ['Receiver startup runtime health', 'receiver'],
    ['Codex planner thread reuse', 'codex'],
    ['SQLite WAL storage identity', 'storage'],
    ['Evidence extraction queue', 'extraction'],
    ['Video transcript availability', 'transcripts'],
    ['Token security capability rotation', 'security'],
    ['UX review workspace layout', 'ux'],
    ['Installation bootstrap path', 'installation'],
    ['Release packaging hashes', 'packaging'],
    ['Acceptance testing matrix', 'testing'],
  ];
  const tabs: TabSeed[] = requested.flatMap(([title, slug], index) => [
    {
      title: `${title} reference ${index}`,
      url: `https://example.test/tabatlas/${slug}/${index}`,
      groupTitle: 'TabAtlas project',
      browser: index % 2 ? 'edge' : 'chrome',
    },
    {
      title: `${title} implementation note ${index}`,
      url: `https://docs.example.test/tabatlas/${slug}/${index}`,
      groupTitle: 'Implementation',
      browser: index % 2 ? 'chrome' : 'edge',
    },
  ]);
  for (let index = 0; index < 12; index += 1) {
    tabs.push({
      title: index % 3 === 0
        ? `YouTube videos transcript-backed TabAtlas evidence demo ${index}`
        : `YouTube videos metadata-only TabAtlas evidence demo ${index}`,
      url: `https://www.youtube.com/watch?v=pilot${String(index).padStart(2, '0')}`,
      groupTitle: 'Video evidence',
      browser: index % 2 ? 'edge' : 'chrome',
    });
  }
  for (let index = 0; index < 36; index += 1) {
    tabs.push({
      title: `Pilot review unmarked resource ${index}`,
      url: `https://review.example.test/item/${index}`,
      groupTitle: 'Review queue',
      browser: index % 2 ? 'edge' : 'chrome',
    });
  }
  return tabs;
}

function seedEvidence(db: ReturnType<typeof openDatabase>, resources: Array<{ id: string; title: string }>): void {
  const insert = db.prepare(`
    INSERT INTO extraction_artifacts
      (id, resource_id, recipe_id, artifact_kind, text_excerpt, json_payload, source_url, provenance, confidence, status, error_code, extracted_at)
    VALUES (?, ?, ?, 'summary', ?, NULL, NULL, ?, ?, 'complete', NULL, ?)
    ON CONFLICT(resource_id, recipe_id) DO NOTHING
  `);
  for (const [index, resource] of resources.entries()) {
    if (!/transcript-backed|extension|receiver|codex|storage|extraction|security|installation|packaging|testing|ux/i.test(resource.title)) continue;
    insert.run(
      `ev_pilot_${index}`,
      resource.id,
      `pilot_summary_${index}`,
      /transcript-backed/i.test(resource.title)
        ? `Transcript evidence for ${resource.title}: receiver setup, safe extension capture, and review workflow are discussed.`
        : `Summary evidence for ${resource.title}.`,
      /transcript-backed/i.test(resource.title) ? 'transcript_seed' : 'summary_seed',
      0.82,
      '2026-06-25T00:00:00.000Z',
    );
  }
}

function seedAtomicItems(db: ReturnType<typeof openDatabase>, resources: Array<{ id: string; title: string }>): void {
  const insert = db.prepare(`
    INSERT INTO atomic_items
      (id, resource_id, item_kind, name, summary, evidence_refs, confidence, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pilot_readiness_seed', ?)
  `);
  for (const [index, resource] of resources.filter(resource => /transcript-backed|Codex|Receiver|Security/i.test(resource.title)).slice(0, 8).entries()) {
    const id = `item_pilot_${index}`;
    insert.run(
      id,
      resource.id,
      index % 2 ? 'task' : 'decision',
      `Known TabAtlas item ${index}`,
      `Known atomic item grounded in ${resource.title}.`,
      JSON.stringify([`pilot:${resource.id}`]),
      0.78,
      '2026-06-25T00:00:00.000Z',
    );
  }
}

function seedOneAnnotation(db: ReturnType<typeof openDatabase>, resources: Array<{ id: string; title: string }>): void {
  const resource = resources.find(item => /UX review/i.test(item.title));
  if (!resource) return;
  addUserAnnotation(db, {
    id: 'ann_pilot_readiness_seed',
    targetKind: 'resource',
    targetId: resource.id,
    tags: ['project-reference', 'ux'],
    description: 'Use this as a project UX reference.',
    decision: 'project_reference',
    source: 'resource_detail',
    createdAt: '2026-06-25T00:00:00.000Z',
  });
}

async function cloneSourceDatabase(source: string, destination: string): Promise<void> {
  const child = spawn(process.execPath, [
    tsx,
    'scripts/environment-clone.ts',
    '--source',
    source,
    '--destination',
    destination,
    '--environment',
    'clone',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  if (code !== 0) throw new Error(`environment-clone failed with ${code}: ${output}`);
}

function startServer(): ChildProcess {
  const log = fs.createWriteStream(path.join(outputRoot, 'receiver.log'), { flags: 'a' });
  const child = spawn(process.execPath, [tsx, 'src/server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      TABATLAS_RUNTIME_PROFILE: 'roleplay',
      TABATLAS_PORT: String(port),
      TABATLAS_DB: cloneDb,
      TABATLAS_BOOTSTRAP_DIR: bootstrapDir,
      TABATLAS_INSTANCE_NAME: 'pilot-readiness-eval',
      TABATLAS_FAKE_CODEX_PROVIDER: 'workspace_ux',
      TABATLAS_CAPTURE_ROOTS: outputRoot,
      TABATLAS_WORKER_POLL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once('exit', () => log.end());
  return child;
}

async function waitForServer(child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Pilot readiness fixture receiver exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Wait for receiver startup.
    }
    await delay(250);
  }
  throw new Error(`Pilot readiness fixture receiver did not become healthy at ${baseUrl}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
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

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
