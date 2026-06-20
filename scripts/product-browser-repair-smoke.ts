import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { openDatabase } from '../src/db/index.js';

declare const chrome: {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
};

type ProductBrowser = 'chrome' | 'edge';

type Args = {
  browser?: ProductBrowser;
  headless: boolean;
  timeoutMs: number;
};

type SmokeEvidence = {
  generatedAt: string;
  browser: ProductBrowser;
  strategy: 'chrome_product_cdp' | 'edge_product_cdp';
  automated: true;
  isolatedProfile: true;
  isolatedDatabase: true;
  receiverUrl: string;
  executableVersion: string;
  executablePathHash: string;
  extensionLoadMethod: 'cdp_extensions_load_unpacked';
  initialChallengeId: string;
  repairChallengeId: string;
  initialCapabilityId: string;
  repairedCapabilityId: string;
  initialSnapshotId: string;
  repairedSnapshotId: string;
  denialAuditId: string;
  popupOpened: boolean;
  receiverReachable: boolean;
  initialPairingSucceeded: boolean;
  initialSnapshotArrived: boolean;
  oldTokenDeniedAfterRepair: boolean;
  repairPairingSucceeded: boolean;
  repairedSnapshotArrived: boolean;
  secretRemovedFromDom: boolean;
  oldCapabilityRevoked: boolean;
  repairedCapabilityActive: boolean;
  tokenAbsentFromSnapshots: boolean;
  noSecretOrTokenMaterialStored: boolean;
  startedAt: string;
  finishedAt: string;
};

const root = process.cwd();

await main(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(args: Args): Promise<void> {
  if (!args.browser) throw new Error('Usage: npm run smoke:product-browser-repair -- --browser <chrome|edge>');
  const browser = args.browser;
  const outputDir = path.join(root, '.local', 'workspace-ux-eval', `product-${browser}-repair`);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const port = await receiverPort();
  const dbPath = path.join(outputDir, 'receiver.sqlite');
  const serverUrl = `http://127.0.0.1:${port}`;
  const server = startReceiver(dbPath, port);
  try {
    await waitForReceiver(serverUrl, server, 30_000);
    const admin = await createAdmin(serverUrl);
    const evidence = await runRepairSmoke({
      browser,
      serverUrl,
      adminToken: admin.token,
      dbPath,
      headless: args.headless,
      timeoutMs: args.timeoutMs,
    });
    const out = path.join(outputDir, 'evidence.json');
    fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.log(`Redacted ${browser} repair evidence written to ${out}`);
  } finally {
    await stopReceiver(server);
  }
}

async function runRepairSmoke(input: {
  browser: ProductBrowser;
  serverUrl: string;
  adminToken: string;
  dbPath: string;
  headless: boolean;
  timeoutMs: number;
}): Promise<SmokeEvidence> {
  const startedAt = new Date().toISOString();
  const extensionDir = extensionDirectory();
  const executable = productBrowserExecutable(input.browser);
  const executablePathHash = sha256Text(path.resolve(executable).toLowerCase());
  const debuggingPort = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `tabatlas-${input.browser}-repair-`));
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    child = launchProductBrowser({
      executable,
      userDataDir,
      debuggingPort,
      headless: input.headless,
    });
    await waitForDebuggingPort(debuggingPort, child, 30_000);
    const executableVersion = await browserVersion(debuggingPort);
    const extensionId = await loadUnpackedExtension(debuggingPort, extensionDir);
    await waitForExtensionWorker(debuggingPort, extensionId, 30_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Product browser CDP connection did not expose a context');
    const contentPage = await context.newPage();
    await contentPage.goto(input.serverUrl, { waitUntil: 'domcontentloaded' });
    await authenticateDashboard(contentPage, input.adminToken);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    const beforeSnapshots = await snapshotCount(input.serverUrl, input.adminToken);
    const initial = await createPairing(input.serverUrl, input.adminToken, input.browser, `${input.browser} extension repair initial`);
    await pairPopup(popup, input.serverUrl, initial.challenge.id, initial.secret);
    const afterInitialSnapshots = await waitForSnapshotCount(input.serverUrl, input.adminToken, beforeSnapshots, input.timeoutMs);
    const initialToken = await storedExtensionToken(popup);
    const initialCapabilityId = await challengeCapabilityId(input.serverUrl, input.adminToken, initial.challenge.id);
    const initialSnapshotId = latestSnapshotId(input.dbPath);

    const repaired = await repairThroughSecurityUi(contentPage, initialCapabilityId);
    await popup.click('#exportNow');
    await popup.waitForFunction(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('revoked') || text.includes('unauthorized') || text.includes('unpaired') || text.includes('pairing required');
    }, null, { timeout: 30_000 });
    const denialAuditId = await deniedSnapshotAuditId(input.serverUrl, input.dbPath, initialCapabilityId, initialToken);

    await pairPopup(popup, input.serverUrl, repaired.challenge.id, repaired.secret);
    await waitForSnapshotCount(input.serverUrl, input.adminToken, afterInitialSnapshots, input.timeoutMs);
    const repairedToken = await storedExtensionToken(popup);
    const repairedCapabilityId = await challengeCapabilityId(input.serverUrl, input.adminToken, repaired.challenge.id);
    const repairedSnapshotId = latestSnapshotId(input.dbPath);
    const secretRemovedFromDom = await acknowledgeRepairSecret(contentPage);
    const dbEvidence = readRepairDbEvidence(input.dbPath, {
      initialCapabilityId,
      repairedCapabilityId,
      initialToken,
      repairedToken,
      initialSecret: initial.secret,
      repairSecret: repaired.secret,
    });
    const finishedAt = new Date().toISOString();
    return {
      generatedAt: finishedAt,
      browser: input.browser,
      strategy: input.browser === 'chrome' ? 'chrome_product_cdp' : 'edge_product_cdp',
      automated: true,
      isolatedProfile: true,
      isolatedDatabase: true,
      receiverUrl: input.serverUrl,
      executableVersion,
      executablePathHash,
      extensionLoadMethod: 'cdp_extensions_load_unpacked',
      initialChallengeId: initial.challenge.id,
      repairChallengeId: repaired.challenge.id,
      initialCapabilityId,
      repairedCapabilityId,
      initialSnapshotId,
      repairedSnapshotId,
      denialAuditId,
      popupOpened: true,
      receiverReachable: await health(input.serverUrl),
      initialPairingSucceeded: Boolean(initialCapabilityId),
      initialSnapshotArrived: afterInitialSnapshots > beforeSnapshots && Boolean(initialSnapshotId),
      oldTokenDeniedAfterRepair: Boolean(denialAuditId),
      repairPairingSucceeded: Boolean(repairedCapabilityId),
      repairedSnapshotArrived: repairedSnapshotId !== initialSnapshotId,
      secretRemovedFromDom,
      oldCapabilityRevoked: dbEvidence.oldCapabilityRevoked,
      repairedCapabilityActive: dbEvidence.repairedCapabilityActive,
      tokenAbsentFromSnapshots: dbEvidence.tokenAbsentFromSnapshots,
      noSecretOrTokenMaterialStored: dbEvidence.noSecretOrTokenMaterialStored,
      startedAt,
      finishedAt,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await stopProductBrowser(child, userDataDir);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function authenticateDashboard(page: Page, token: string): Promise<void> {
  await page.evaluate(token => {
    localStorage.setItem('tabatlas.localToken', token);
    localStorage.setItem('tabatlas.workspace.page', 'settings');
  }, token);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'visible', timeout: 10_000 });
}

async function repairThroughSecurityUi(
  page: Page,
  capabilityId: string,
): Promise<{ challenge: { id: string }; secret: string }> {
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('tabatlas.workspace.page', 'settings');
    const nav = document.querySelector('.secondary-nav') as HTMLDetailsElement | null;
    if (nav) nav.open = true;
    const security = document.querySelector<HTMLElement>('.secondary-nav-list [data-settings-panel="security"]');
    security?.click();
  });
  await page.waitForFunction(() => {
    return document.querySelector('#page-settings')?.classList.contains('active')
      && Boolean(document.querySelector('#settings-security'));
  }, null, { timeout: 10_000 });
  await page.locator(`[data-capability-action="rotate"][data-capability-id="${capabilityId}"]`).click();
  await page.waitForFunction(() => /requires re-pairing/i.test(document.querySelector('#securityRotationResult')?.textContent ?? ''), null, { timeout: 10_000 });
  await page.locator(`[data-extension-repair="${capabilityId}"]`).click();
  await page.waitForFunction(() => /re-pair challenge/i.test(document.querySelector('#securityRotationResult')?.textContent ?? ''), null, { timeout: 10_000 });
  const values = await page.locator('#securityRotationResult .one-time-token').evaluateAll(elements => elements.map(element => element.textContent?.trim() ?? ''));
  const [challengeId, secret] = values;
  if (!challengeId || !secret) throw new Error('Security UI did not display a repair challenge ID and secret');
  return { challenge: { id: challengeId }, secret };
}

async function acknowledgeRepairSecret(page: Page): Promise<boolean> {
  await page.locator('[data-ack-pairing-secret]').click();
  await page.waitForFunction(() => document.querySelectorAll('#securityRotationResult .one-time-token').length === 0, null, { timeout: 10_000 });
  return await page.locator('#securityRotationResult .one-time-token').count() === 0;
}

async function createPairing(
  serverUrl: string,
  token: string,
  browser: ProductBrowser,
  label: string,
): Promise<{ challenge: { id: string }; secret: string }> {
  return fetchJson(`${serverUrl}/api/security/pairing-codes`, {
    method: 'POST',
    token,
    body: { browser, label, ttlMs: 10 * 60_000 },
  });
}

async function pairPopup(page: Page, serverUrl: string, challengeId: string, secret: string): Promise<void> {
  await page.fill('#receiver', serverUrl);
  await page.fill('#challengeId', challengeId);
  await page.fill('#secret', secret);
  await page.click('#pair');
  await page.waitForFunction(() => {
    const message = document.querySelector('#message')?.textContent?.toLowerCase() ?? '';
    const status = document.querySelector('#status')?.textContent?.toLowerCase() ?? '';
    return message.includes('paired') && status.includes('paired') && !status.includes('unpaired');
  }, null, { timeout: 30_000 });
}

async function storedExtensionToken(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const value = await chrome.storage.local.get('tabAtlasToken');
    return typeof value.tabAtlasToken === 'string' ? value.tabAtlasToken : '';
  });
}

async function challengeCapabilityId(serverUrl: string, token: string, challengeId: string): Promise<string> {
  const status = await fetchJson<{ pairingChallenges: Array<{ id: string; capabilityId?: string }> }>(`${serverUrl}/api/security/status`, { token });
  const challenge = status.pairingChallenges.find(item => item.id === challengeId);
  if (!challenge?.capabilityId) throw new Error(`Pairing challenge ${challengeId} did not expose a capability ID`);
  return challenge.capabilityId;
}

async function snapshotCount(serverUrl: string, token: string): Promise<number> {
  const status = await fetchJson<{ snapshots: number }>(`${serverUrl}/api/status`, { token });
  return status.snapshots;
}

async function waitForSnapshotCount(serverUrl: string, token: string, before: number, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const count = await snapshotCount(serverUrl, token);
    if (count > before) return count;
    await delay(500);
  }
  throw new Error(`Snapshot count did not advance beyond ${before}`);
}

function latestSnapshotId(dbPath: string): string {
  return withDb(dbPath, db => {
    const row = db.prepare('SELECT id FROM snapshots ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined;
    if (!row?.id) throw new Error('No snapshot was recorded');
    return row.id;
  });
}

async function deniedSnapshotAuditId(
  serverUrl: string,
  dbPath: string,
  capabilityId: string,
  token: string,
): Promise<string> {
  const existing = latestDeniedSnapshotAuditIdOrNull(dbPath, capabilityId);
  if (existing) return existing;
  const response = await fetch(`${serverUrl}/snapshot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tab-atlas-token': token,
    },
    body: JSON.stringify({ capturedAt: new Date().toISOString(), tabs: [] }),
  });
  if (response.status !== 401 && response.status !== 403) {
    throw new Error(`Old token denial probe returned ${response.status}`);
  }
  const recorded = latestDeniedSnapshotAuditIdOrNull(dbPath, capabilityId);
  if (!recorded) throw new Error('No denied post-repair snapshot audit was recorded');
  return recorded;
}

function latestDeniedSnapshotAuditIdOrNull(dbPath: string, capabilityId: string): string {
  return withDb(dbPath, db => {
    const row = db.prepare(`
      SELECT id
      FROM security_audit_events
      WHERE outcome = 'denied'
        AND route = '/snapshot'
        AND capability_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(capabilityId) as { id: string } | undefined;
    return row?.id ?? '';
  });
}

function readRepairDbEvidence(
  dbPath: string,
  input: {
    initialCapabilityId: string;
    repairedCapabilityId: string;
    initialToken: string;
    repairedToken: string;
    initialSecret: string;
    repairSecret: string;
  },
): {
  oldCapabilityRevoked: boolean;
  repairedCapabilityActive: boolean;
  tokenAbsentFromSnapshots: boolean;
  noSecretOrTokenMaterialStored: boolean;
} {
  return withDb(dbPath, db => {
    const oldCapability = db.prepare('SELECT status FROM local_capabilities WHERE id = ?').get(input.initialCapabilityId) as { status: string } | undefined;
    const repairedCapability = db.prepare('SELECT status FROM local_capabilities WHERE id = ?').get(input.repairedCapabilityId) as { status: string } | undefined;
    const snapshots = db.prepare('SELECT raw_json FROM snapshots').all() as Array<{ raw_json: string | null }>;
    const rawSnapshots = JSON.stringify(snapshots);
    const persisted = JSON.stringify([
      ...db.prepare('SELECT id, kind, label, token_hash, status FROM local_capabilities').all() as unknown[],
      ...db.prepare('SELECT id, secret_hash, kind, browser, label, status, capability_id FROM pairing_challenges').all() as unknown[],
      ...db.prepare('SELECT id, event_type, reason, capability_id, details_json FROM security_audit_events').all() as unknown[],
    ]);
    return {
      oldCapabilityRevoked: oldCapability?.status === 'revoked',
      repairedCapabilityActive: repairedCapability?.status === 'active',
      tokenAbsentFromSnapshots: !rawSnapshots.includes(input.initialToken) && !rawSnapshots.includes(input.repairedToken),
      noSecretOrTokenMaterialStored: !persisted.includes(input.initialToken)
        && !persisted.includes(input.repairedToken)
        && !persisted.includes(input.initialSecret)
        && !persisted.includes(input.repairSecret),
    };
  });
}

function withDb<T>(dbPath: string, read: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(dbPath);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function startReceiver(dbPath: string, port: number): ChildProcess {
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return spawn(process.execPath, [tsx, 'src/server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      TABATLAS_DB: dbPath,
      TABATLAS_PORT: String(port),
      TABATLAS_WORKER_POLL_MS: '60000',
    },
    stdio: 'ignore',
  });
}

async function waitForReceiver(serverUrl: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Receiver exited early with code ${child.exitCode}`);
    if (await health(serverUrl)) return;
    await delay(250);
  }
  throw new Error(`Receiver did not become ready at ${serverUrl}`);
}

async function stopReceiver(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(3000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function createAdmin(serverUrl: string): Promise<{ token: string; capabilityId: string }> {
  const response = await fetch(`${serverUrl}/api/security/capabilities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'automation',
      scopes: ['admin'],
      label: 'Product browser repair smoke admin',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`Unable to create repair smoke admin (${response.status})`);
  const payload = await response.json() as { token?: string; capability?: { id?: string } };
  if (!payload.token || !payload.capability?.id) throw new Error('Repair smoke admin response was incomplete');
  return { token: payload.token, capabilityId: payload.capability.id };
}

function extensionDirectory(): string {
  const packaged = path.join(root, 'release', 'tabatlas-extension');
  if (fs.existsSync(path.join(packaged, 'manifest.json'))) return packaged;
  return path.join(root, 'extension');
}

function productBrowserExecutable(browser: ProductBrowser): string {
  const candidates = browser === 'chrome'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : [
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`${browser} executable was not found`);
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

async function waitForDebuggingPort(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Product browser exited early with code ${child.exitCode}`);
    if (await canFetchJson(`http://127.0.0.1:${port}/json/version`)) return;
    await delay(500);
  }
  throw new Error(`Product browser debugging port did not open on ${port}`);
}

async function browserVersion(port: number): Promise<string> {
  const version = await fetchJson<{ Browser?: string }>(`http://127.0.0.1:${port}/json/version`);
  return version.Browser ?? 'unknown-product-browser';
}

async function loadUnpackedExtension(port: number, extensionDir: string): Promise<string> {
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`);
  if (!version.webSocketDebuggerUrl) throw new Error('Product browser did not expose a browser debugging websocket');
  const response = await sendBrowserCdp<{ id?: string }>(version.webSocketDebuggerUrl, 'Extensions.loadUnpacked', {
    path: extensionDir,
  });
  if (!response.id) throw new Error('Extensions.loadUnpacked did not return an extension ID');
  return response.id;
}

async function waitForExtensionWorker(port: number, extensionId: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await fetchDebugTargets(port).catch(() => []);
    const worker = targets.find(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`));
    if (worker) return;
    await delay(500);
  }
  throw new Error('Product browser did not start the TabAtlas extension service worker');
}

async function sendBrowserCdp<T>(
  webSocketUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
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

async function fetchDebugTargets(port: number): Promise<Array<{ type: string; url: string }>> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`);
  return await response.json() as Array<{ type: string; url: string }>;
}

async function fetchJson<T>(
  url: string,
  input: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: input.method ?? 'GET',
    headers: {
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(input.token ? { 'x-tab-atlas-token': input.token } : {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function health(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function canFetchJson(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
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

async function receiverPort(): Promise<number> {
  for (const port of [9786, 9787]) {
    if (!await canFetchJson(`http://127.0.0.1:${port}/health`) && await canBind(port)) return port;
  }
  throw new Error('No extension-permitted receiver port is free; close the receiver on 9786/9787 and retry');
}

async function canBind(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
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

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(raw: string[]): Args {
  const parsed: Args = {
    browser: undefined,
    headless: true,
    timeoutMs: 90_000,
  };
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index];
    if (arg === '--browser') {
      const browser = raw[++index];
      if (browser !== 'chrome' && browser !== 'edge') throw new Error(`Unsupported browser: ${browser}`);
      parsed.browser = browser;
    } else if (arg === '--headful') parsed.headless = false;
    else if (arg === '--headless') parsed.headless = true;
    else if (arg === '--timeout-ms') parsed.timeoutMs = Number(raw[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
