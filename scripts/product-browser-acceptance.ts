import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium, type Browser } from 'playwright';
import { manualBrowserSessionToSmoke, type ManualBrowserAcceptanceRecord, type ProductBrowser } from '../src/acceptance/manualBrowserSession.js';
import { BrowserExecutionEvidence, type BrowserExecutionEvidence as BrowserExecutionEvidenceType } from '../src/acceptance/browserEvidencePolicy.js';

declare const chrome: {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
};

type Args = {
  browser?: ProductBrowser;
  serverUrl: string;
  adminToken?: string;
  confirmPopup: boolean;
  noWait: boolean;
  automateExtension: boolean;
  headless: boolean;
  headlessOnly: boolean;
  timeoutMs: number;
};

const outputDir = path.join(process.cwd(), '.local', 'acceptance');

await main(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(args: Args): Promise<void> {
  if (!args.browser) throw new Error('Usage: npm run acceptance:product-browsers -- --browser <chrome|edge>');
  const productArgs: Args & { browser: ProductBrowser } = { ...args, browser: args.browser };
  fs.mkdirSync(outputDir, { recursive: true });

  if (!await health(args.serverUrl)) {
    throw new Error(`TabAtlas receiver is not reachable at ${args.serverUrl}`);
  }

  const admin = args.adminToken
    ? { token: args.adminToken, capabilityId: undefined as string | undefined, temporary: false }
    : await createTemporaryAdmin(args.serverUrl);
  const adminToken = admin.token;

  try {
    const created = await fetchJson<{ session: ManualBrowserAcceptanceRecord; challengeSecret: string }>(
      `${args.serverUrl}/api/acceptance/browser-sessions`,
      {
        method: 'POST',
        token: adminToken,
        body: {
          browser: args.browser,
          receiverUrl: args.serverUrl,
          ttlMs: 15 * 60_000,
        },
      },
    );

    if (args.automateExtension) {
      console.log(`Browser: ${args.browser}`);
      console.log(`Session ID: ${created.session.id}`);
      console.log(`Extension directory: ${extensionDirectory()}`);
      console.log(`Receiver URL: ${args.serverUrl}`);
      console.log(`Challenge ID: ${created.session.challengeId}`);
      console.log('Driving the packaged extension automatically; the one-time pairing secret is not written to evidence.');
      const result = await runAutomatedProductBrowserAcceptance({
        args: productArgs,
        adminToken,
        sessionId: created.session.id,
        challengeId: created.session.challengeId ?? '',
        challengeSecret: created.challengeSecret,
      });
      await writeSessionEvidence(args.browser, args.serverUrl, adminToken, created.session.id, result.session, result.browserEvidence);
      if (result.session.status !== 'passed') {
        throw new Error(`${args.browser} CDP acceptance incomplete: ${result.session.status}`);
      }
      console.log(`${args.browser} CDP acceptance passed from server evidence.`);
      return;
    }

    const extensionDir = extensionDirectory();
    console.log(`Browser: ${args.browser}`);
    console.log(`Session ID: ${created.session.id}`);
    console.log(`Extension directory: ${extensionDir}`);
    console.log(`Extensions page: ${args.browser === 'chrome' ? 'chrome://extensions' : 'edge://extensions'}`);
    console.log(`Receiver URL: ${args.serverUrl}`);
    console.log(`Challenge ID: ${created.session.challengeId}`);
    console.log(`One-time pairing secret: ${created.challengeSecret}`);
    console.log('The secret is printed once and is not written to the redacted report.');

    if (args.noWait) {
      await writeSessionEvidence(args.browser, args.serverUrl, adminToken, created.session.id);
      return;
    }

    if (args.confirmPopup) {
      await postSession(args.serverUrl, adminToken, created.session.id, 'confirm-popup');
    } else if (process.stdin.isTTY) {
      const rl = createInterface({ input, output });
      await rl.question('After opening the popup in the product browser, press Enter to record popup-open confirmation.');
      rl.close();
      await postSession(args.serverUrl, adminToken, created.session.id, 'confirm-popup');
    } else {
      console.log('Non-interactive terminal detected; popup-open confirmation was not recorded. Re-run with --confirm-popup after opening the popup.');
    }

    console.log('Waiting for popup pairing and snapshot arrival...');
    let session = await waitForSession(args.serverUrl, adminToken, created.session.id, s => Boolean(s.capabilityId && s.snapshotId), args.timeoutMs);
    console.log(`Paired capability: ${session.capabilityId ?? '(missing)'}`);
    console.log(`Snapshot: ${session.snapshotId ?? '(missing)'}`);

    console.log('Revoking extension capability...');
    session = (await postSession(args.serverUrl, adminToken, created.session.id, 'revoke')).session;
    console.log(`Revoked at: ${session.revokedAt ?? '(pending)'}`);
    console.log('Trigger Export in the popup once more so the receiver records a denied post-revocation snapshot attempt.');
    session = await waitForSession(args.serverUrl, adminToken, created.session.id, s => Boolean(s.revocationObservedAt), args.timeoutMs);
    console.log(`Revocation denial observed at: ${session.revocationObservedAt ?? '(missing)'}`);

    session = (await postSession(args.serverUrl, adminToken, created.session.id, 'verify-token-absence')).session;
    await writeSessionEvidence(args.browser, args.serverUrl, adminToken, created.session.id, session);

    if (session.status !== 'passed') {
      throw new Error(`Manual ${args.browser} acceptance incomplete: ${session.status}`);
    }
    console.log(`Manual ${args.browser} acceptance passed from server evidence.`);
  } finally {
    await cleanupTemporaryAdmin(args.serverUrl, admin);
  }
}

async function writeSessionEvidence(
  browser: ProductBrowser,
  serverUrl: string,
  token: string,
  sessionId: string,
  knownSession?: ManualBrowserAcceptanceRecord,
  browserEvidence?: BrowserExecutionEvidenceType,
): Promise<void> {
  const session = knownSession ?? await refreshSession(serverUrl, token, sessionId);
  const smoke = browserEvidence ? smokeFromBrowserEvidence(browserEvidence) : manualBrowserSessionToSmoke(session);
  const evidence = {
    generatedAt: new Date().toISOString(),
    browser,
    serverUrl,
    session,
    browserEvidence: browserEvidence ? [browserEvidence] : [],
    browserSmokes: [smoke],
  };
  const out = path.join(outputDir, `product-browser-${browser}.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`Redacted ${browser} acceptance evidence written to ${out}`);
}

async function waitForSession(
  serverUrl: string,
  token: string,
  sessionId: string,
  predicate: (session: ManualBrowserAcceptanceRecord) => boolean,
  timeoutMs: number,
): Promise<ManualBrowserAcceptanceRecord> {
  const started = Date.now();
  let last = await refreshSession(serverUrl, token, sessionId);
  while (Date.now() - started < timeoutMs) {
    last = await refreshSession(serverUrl, token, sessionId);
    if (predicate(last)) return last;
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${sessionId}; last status=${last.status}`);
}

async function refreshSession(serverUrl: string, token: string, sessionId: string): Promise<ManualBrowserAcceptanceRecord> {
  return (await postSession(serverUrl, token, sessionId, 'refresh')).session;
}

async function postSession(
  serverUrl: string,
  token: string,
  sessionId: string,
  action: string,
  body?: unknown,
): Promise<{ session: ManualBrowserAcceptanceRecord }> {
  return fetchJson(`${serverUrl}/api/acceptance/browser-sessions/${sessionId}/${action}`, {
    method: 'POST',
    token,
    body,
  });
}

async function runAutomatedProductBrowserAcceptance(input: {
  args: Args & { browser: ProductBrowser };
  adminToken: string;
  sessionId: string;
  challengeId: string;
  challengeSecret: string;
}): Promise<{ session: ManualBrowserAcceptanceRecord; browserEvidence: BrowserExecutionEvidenceType }> {
  try {
    return await runAutomatedProductBrowserAttempt({ ...input, headless: input.args.headless });
  } catch (error) {
    if (!input.args.headless || input.args.headlessOnly) throw error;
    console.log(`Headless ${input.args.browser} extension run failed; retrying headful product browser automation.`);
    console.log(error instanceof Error ? error.message : String(error));
    return await runAutomatedProductBrowserAttempt({ ...input, headless: false });
  }
}

async function runAutomatedProductBrowserAttempt(input: {
  args: Args & { browser: ProductBrowser };
  adminToken: string;
  sessionId: string;
  challengeId: string;
  challengeSecret: string;
  headless: boolean;
}): Promise<{ session: ManualBrowserAcceptanceRecord; browserEvidence: BrowserExecutionEvidenceType }> {
  if (!input.challengeId || !input.challengeSecret) throw new Error('Acceptance session did not include a challenge');
  const extensionDir = extensionDirectory();
  const executable = productBrowserExecutable(input.args.browser);
  const executablePathHash = sha256Text(path.resolve(executable).toLowerCase());
  const debuggingPort = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `tabatlas-${input.args.browser}-`));
  const startedAt = new Date().toISOString();
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    child = launchProductBrowser({
      executable,
      userDataDir,
      extensionDir,
      debuggingPort,
      headless: input.headless,
    });
    await waitForDebuggingPort(debuggingPort, child, 30_000);
    const executableVersion = await browserVersion(debuggingPort);
    const receiverReachable = await health(input.args.serverUrl);
    const extensionId = await loadUnpackedExtension(debuggingPort, extensionDir);
    await waitForExtensionWorker(debuggingPort, extensionId, 30_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Product browser CDP connection did not expose a context');
    const contentPage = await context.newPage();
    await contentPage.goto(input.args.serverUrl, { waitUntil: 'domcontentloaded' });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await postSession(input.args.serverUrl, input.adminToken, input.sessionId, 'confirm-popup');
    await popup.fill('#receiver', input.args.serverUrl);
    await popup.fill('#challengeId', input.challengeId);
    await popup.fill('#secret', input.challengeSecret);
    await popup.click('#pair');
    await popup.waitForFunction(() => document.body.innerText.toLowerCase().includes('paired'), null, { timeout: 30_000 });
    const storedToken = await popup.evaluate(async () => {
      const value = await chrome.storage.local.get('tabAtlasToken');
      return typeof value.tabAtlasToken === 'string' ? value.tabAtlasToken : '';
    });

    let session = await waitForSession(
      input.args.serverUrl,
      input.adminToken,
      input.sessionId,
      value => Boolean(value.capabilityId && value.snapshotId),
      input.args.timeoutMs,
    );
    console.log(`Paired capability: ${session.capabilityId ?? '(missing)'}`);
    console.log(`Snapshot: ${session.snapshotId ?? '(missing)'}`);

    session = (await postSession(input.args.serverUrl, input.adminToken, input.sessionId, 'revoke')).session;
    console.log(`Revoked at: ${session.revokedAt ?? '(pending)'}`);
    await popup.click('#exportNow');
    await popup.waitForFunction(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('revoked') || text.includes('unauthorized') || text.includes('unpaired') || text.includes('pairing required');
    }, null, { timeout: 30_000 });

    session = await waitForSession(
      input.args.serverUrl,
      input.adminToken,
      input.sessionId,
      value => Boolean(value.revocationObservedAt),
      input.args.timeoutMs,
    );
    console.log(`Revocation denial observed at: ${session.revocationObservedAt ?? '(missing)'}`);

    session = (await postSession(input.args.serverUrl, input.adminToken, input.sessionId, 'verify-token-absence', {
      token: storedToken,
    })).session;
    const finishedAt = new Date().toISOString();
    const browserEvidence = BrowserExecutionEvidence.parse({
      browser: input.args.browser,
      strategy: input.args.browser === 'chrome' ? 'chrome_product_cdp' : 'edge_product_cdp',
      automated: true,
      isolatedProfile: true,
      executableVersion,
      executablePathHash,
      extensionLoadMethod: 'cdp_extensions_load_unpacked',
      receiverUrl: input.args.serverUrl,
      acceptanceSessionId: session.id,
      capabilityId: session.capabilityId,
      snapshotId: session.snapshotId,
      denialAuditId: session.denialAuditId,
      popupOpened: Boolean(session.popupOpenedConfirmedAt),
      receiverReachable,
      pairedThroughPopup: Boolean(session.capabilityId && session.pairedAt),
      snapshotExportedThroughPopup: Boolean(session.snapshotId),
      snapshotArrived: Boolean(session.snapshotId && session.snapshotObservedAt),
      revocationObserved: Boolean(session.revocationObservedAt),
      tokenAbsentFromSnapshot: Boolean(session.tokenAbsentVerifiedAt),
      startedAt,
      finishedAt,
    });
    return { session, browserEvidence };
  } finally {
    await browser?.close().catch(() => undefined);
    await stopProductBrowser(child, userDataDir);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function createTemporaryAdmin(serverUrl: string): Promise<{ token: string; capabilityId: string; temporary: true }> {
  const response = await fetch(`${serverUrl}/api/security/capabilities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'automation',
      scopes: ['admin'],
      label: 'Product browser acceptance admin',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Unable to create temporary admin token (${response.status}). Set TABATLAS_ACCEPTANCE_ADMIN_TOKEN and retry.`);
  }
  const payload = await response.json() as { token?: string; capability?: { id?: string } };
  if (!payload.token) throw new Error('Temporary admin response did not include a token');
  if (!payload.capability?.id) throw new Error('Temporary admin response did not include a capability ID');
  return { token: payload.token, capabilityId: payload.capability.id, temporary: true };
}

async function cleanupTemporaryAdmin(
  serverUrl: string,
  admin: { token: string; capabilityId?: string; temporary: boolean },
): Promise<void> {
  if (!admin.temporary || !admin.capabilityId) return;
  try {
    await fetchJson(`${serverUrl}/api/security/capabilities/${admin.capabilityId}/revoke`, {
      method: 'POST',
      token: admin.token,
    });
    console.log('Temporary acceptance admin capability revoked.');
  } catch (error) {
    console.error(`Unable to revoke temporary acceptance admin capability: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchJson<T>(url: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { 'x-tab-atlas-token': options.token } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Request failed ${response.status} ${url}: ${text.slice(0, 500)}`);
  }
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

function extensionDirectory(): string {
  const packaged = path.join(process.cwd(), 'release', 'tabatlas-extension');
  if (fs.existsSync(path.join(packaged, 'manifest.json'))) return packaged;
  return path.join(process.cwd(), 'extension');
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
  extensionDir: string;
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
  ], { stdio: 'ignore' });
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

async function loadUnpackedExtension(port: number, extensionDir: string): Promise<string> {
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`);
  if (!version.webSocketDebuggerUrl) throw new Error('Product browser did not expose a browser debugging websocket');
  const response = await sendBrowserCdp<{ id?: string }>(version.webSocketDebuggerUrl, 'Extensions.loadUnpacked', {
    path: extensionDir,
  });
  if (!response.id) throw new Error('Extensions.loadUnpacked did not return an extension ID');
  return response.id;
}

async function browserVersion(port: number): Promise<string> {
  const version = await fetchJson<{ Browser?: string }>(`http://127.0.0.1:${port}/json/version`);
  return version.Browser ?? 'unknown-product-browser';
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
  ], { stdio: 'ignore' });
}

function parseArgs(raw: string[]): Args {
  const parsed: Args = {
    serverUrl: process.env.TABATLAS_SERVER_URL ?? 'http://127.0.0.1:9787',
    adminToken: process.env.TABATLAS_ACCEPTANCE_ADMIN_TOKEN,
    confirmPopup: false,
    noWait: false,
    automateExtension: false,
    headless: true,
    headlessOnly: false,
    timeoutMs: 5 * 60_000,
  };
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index];
    if (arg === '--browser') {
      const browser = raw[++index];
      if (browser !== 'chrome' && browser !== 'edge') throw new Error(`Unsupported browser: ${browser}`);
      parsed.browser = browser;
    } else if (arg === '--server-url') parsed.serverUrl = raw[++index];
    else if (arg === '--admin-token') parsed.adminToken = raw[++index];
    else if (arg === '--confirm-popup') parsed.confirmPopup = true;
    else if (arg === '--no-wait') parsed.noWait = true;
    else if (arg === '--automate-extension') parsed.automateExtension = true;
    else if (arg === '--headful') parsed.headless = false;
    else if (arg === '--headless') parsed.headless = true;
    else if (arg === '--headless-only') {
      parsed.headless = true;
      parsed.headlessOnly = true;
    }
    else if (arg === '--timeout-ms') parsed.timeoutMs = Number(raw[++index]);
  }
  return parsed;
}

function smokeFromBrowserEvidence(evidence: BrowserExecutionEvidenceType): {
  browser: 'chromium' | 'chrome' | 'edge';
  mode: 'automated' | 'manual';
  popupOpened: boolean;
  receiverReachable: boolean;
  pairedThroughPopup: boolean;
  snapshotExportedThroughPopup: boolean;
  snapshotArrived: boolean;
  revocationVisible: boolean;
  tokenAbsentFromSnapshot: boolean;
  notes: string;
} {
  return {
    browser: evidence.browser,
    mode: evidence.automated ? 'automated' : 'manual',
    popupOpened: evidence.popupOpened,
    receiverReachable: evidence.receiverReachable,
    pairedThroughPopup: evidence.pairedThroughPopup,
    snapshotExportedThroughPopup: evidence.snapshotExportedThroughPopup,
    snapshotArrived: evidence.snapshotArrived,
    revocationVisible: evidence.revocationObserved,
    tokenAbsentFromSnapshot: evidence.tokenAbsentFromSnapshot,
    notes: [
      `strategy=${evidence.strategy}`,
      `session=${evidence.acceptanceSessionId}`,
      `capability=${evidence.capabilityId}`,
      `snapshot=${evidence.snapshotId}`,
      `denialAudit=${evidence.denialAuditId}`,
    ].join('; '),
  };
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
