import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { openDatabase } from '../src/db/index.js';
import {
  BrowserExecutionEvidence,
  pairingBrowserForExecution,
  type BrowserExecutionEvidence as BrowserExecutionEvidenceType,
  type ExtensionPairingBrowser,
} from '../src/acceptance/browserEvidencePolicy.js';

declare const chrome: {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
};

type ServerHandle = {
  started: boolean;
  serverUrl: string;
  dbPath?: string;
  stop: () => Promise<void>;
};

type AdminToken = {
  token: string;
  capabilityId?: string;
  createdByScript: boolean;
};

type PairingChallenge = {
  challengeId: string;
  secret: string;
};

const root = process.cwd();
const outputDir = path.join(root, '.local', 'acceptance');
const outputPath = path.join(outputDir, 'chromium-smoke.json');
const screenshotPath = path.join(outputDir, 'chromium-popup.png');
const defaultServerUrl = 'http://127.0.0.1:9787';
const serverUrl = process.env.TABATLAS_SERVER_URL ?? defaultServerUrl;
const explicitHeadless = process.env.TABATLAS_CHROMIUM_HEADLESS;
const preferHeadless = explicitHeadless !== '0';
const executionBrowser = 'chromium' as const;
const pairingBrowser = pairingBrowserForExecution(executionBrowser);

fs.mkdirSync(outputDir, { recursive: true });

const server = await ensureServer(serverUrl);
let admin: AdminToken | undefined;
let fallbackUsed = false;
try {
  admin = await getAdminToken(server.serverUrl);
  const beforeStatus = await fetchJson<{ snapshots: number }>(`${server.serverUrl}/api/status`, {
    token: admin.token,
  });
  const firstChallenge = await createPairingChallenge(server.serverUrl, admin.token, pairingBrowser);
  let result;
  try {
    result = await runSmoke({
      serverUrl: server.serverUrl,
      adminToken: admin.token,
      challenge: firstChallenge,
      headless: preferHeadless,
      snapshotBefore: beforeStatus.snapshots,
      dbPath: server.dbPath,
    });
  } catch (error) {
    if (!preferHeadless || explicitHeadless !== undefined) throw error;
    fallbackUsed = true;
    const retryChallenge = await createPairingChallenge(server.serverUrl, admin.token, pairingBrowser);
    result = await runSmoke({
      serverUrl: server.serverUrl,
      adminToken: admin.token,
      challenge: retryChallenge,
      headless: false,
      snapshotBefore: beforeStatus.snapshots,
      dbPath: server.dbPath,
    });
  }
  const extensionCapabilityId = result.extensionCapabilityId;
  const smoke = smokeFromBrowserEvidence(result.browserEvidence);
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    strategy: 'bundled_chromium_automated',
    serverUrl: server.serverUrl,
    startedReceiver: server.started,
    extensionDir: result.extensionDir,
    headless: result.headless,
    fallbackUsed,
    executionBrowser,
    pairingBrowser,
    browserEvidence: [result.browserEvidence],
    browserSmokes: [smoke],
    evidence: {
      snapshotBefore: beforeStatus.snapshots,
      snapshotAfter: result.snapshotAfter,
      extensionCapabilityId,
      screenshotPath,
    },
  }, null, 2));
  console.log(`Chromium extension acceptance written to ${outputPath}`);
  console.log(JSON.stringify(smoke, null, 2));
  if (!Object.entries(smoke).every(([key, value]) => key === 'notes' || key === 'browser' || key === 'mode' || value === true)) {
    process.exitCode = 1;
  }
} finally {
  if (admin?.createdByScript && admin.capabilityId) {
    await fetchJson(`${server.serverUrl}/api/security/capabilities/${admin.capabilityId}/revoke`, {
      method: 'POST',
      token: admin.token,
    }).catch(() => undefined);
  }
  await server.stop();
}

async function runSmoke(input: {
  serverUrl: string;
  adminToken: string;
  challenge: PairingChallenge;
  headless: boolean;
  snapshotBefore: number;
  dbPath?: string;
}): Promise<{
  extensionDir: string;
  extensionCapabilityId: string;
  popupOpened: boolean;
  receiverReachable: boolean;
  pairedThroughPopup: boolean;
  snapshotExportedThroughPopup: boolean;
  snapshotArrived: boolean;
  snapshotAfter: number;
  revocationVisible: boolean;
  tokenAbsentFromSnapshot: boolean;
  headless: boolean;
  browserEvidence: BrowserExecutionEvidenceType;
}> {
  const extensionDir = extensionDirectory();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-chromium-'));
  const startedAt = new Date().toISOString();
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: input.headless,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });
    const executableVersion = context.browser()?.version() ?? 'bundled-chromium-unknown';
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = extensionIdFromWorkerUrl(worker.url());
    const contentPage = await context.newPage();
    await contentPage.goto(`${input.serverUrl}/health`);
    const receiverReachable = await health(input.serverUrl);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.fill('#receiver', input.serverUrl);
    await popup.fill('#challengeId', input.challenge.challengeId);
    await popup.fill('#secret', input.challenge.secret);
    await popup.click('#pair');
    await popup.waitForFunction(() => document.body.innerText.toLowerCase().includes('paired'), null, { timeout: 30_000 });
    await popup.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('cap_'), null, { timeout: 10_000 });
    const statusText = await popup.locator('#status').textContent({ timeout: 10_000 });
    const capabilityId = statusText?.match(/Capability:\s*(cap_[A-Za-z0-9_-]+)/)?.[1] ?? '';
    if (!capabilityId) throw new Error('paired popup did not expose extension capability id');
    const storedToken = await popup.evaluate(async () => {
      const value = await chrome.storage.local.get('tabAtlasToken');
      return typeof value.tabAtlasToken === 'string' ? value.tabAtlasToken : '';
    });
    const snapshotAfterPair = await waitForSnapshot(input.serverUrl, input.adminToken, input.snapshotBefore);
    await popup.screenshot({ path: screenshotPath });
    if (capabilityId) {
      await fetchJson(`${input.serverUrl}/api/security/capabilities/${capabilityId}/revoke`, {
        method: 'POST',
        token: input.adminToken,
      });
    }
    await popup.click('#exportNow');
    await popup.waitForFunction(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('revoked') || text.includes('unauthorized') || text.includes('unpaired') || text.includes('pairing required');
    }, null, { timeout: 20_000 });
    const statusAfterRevoke = await popup.locator('#status').textContent({ timeout: 10_000 });
    if (!input.dbPath) throw new Error('Chromium acceptance requires a known receiver database path for exact evidence');
    const dbEvidence = chromiumEvidenceFromDatabase(input.dbPath, capabilityId, storedToken);
    const finishedAt = new Date().toISOString();
    const browserEvidence = BrowserExecutionEvidence.parse({
      browser: executionBrowser,
      strategy: 'bundled_chromium_playwright',
      automated: true,
      isolatedProfile: true,
      executableVersion,
      extensionLoadMethod: 'playwright_load_extension_flags',
      receiverUrl: input.serverUrl,
      acceptanceSessionId: `chromium_playwright_${capabilityId}`,
      capabilityId,
      snapshotId: dbEvidence.snapshotId,
      denialAuditId: dbEvidence.denialAuditId,
      popupOpened: true,
      receiverReachable,
      pairedThroughPopup: statusText?.toLowerCase().includes('paired') ?? false,
      snapshotExportedThroughPopup: snapshotAfterPair > input.snapshotBefore,
      snapshotArrived: snapshotAfterPair > input.snapshotBefore,
      revocationObserved: Boolean(statusAfterRevoke?.toLowerCase().includes('unpaired') || statusAfterRevoke?.toLowerCase().includes('revoked') || statusAfterRevoke?.toLowerCase().includes('token')),
      tokenAbsentFromSnapshot: dbEvidence.tokenAbsentFromSnapshot,
      startedAt,
      finishedAt,
    });
    return {
      extensionDir,
      extensionCapabilityId: capabilityId,
      popupOpened: true,
      receiverReachable,
      pairedThroughPopup: statusText?.toLowerCase().includes('paired') ?? false,
      snapshotExportedThroughPopup: snapshotAfterPair > input.snapshotBefore,
      snapshotArrived: snapshotAfterPair > input.snapshotBefore,
      snapshotAfter: snapshotAfterPair,
      revocationVisible: Boolean(statusAfterRevoke?.toLowerCase().includes('unpaired') || statusAfterRevoke?.toLowerCase().includes('revoked') || statusAfterRevoke?.toLowerCase().includes('token')),
      tokenAbsentFromSnapshot: dbEvidence.tokenAbsentFromSnapshot,
      headless: input.headless,
      browserEvidence,
    };
  } finally {
    await context?.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function ensureServer(url: string): Promise<ServerHandle> {
  if (await health(url)) {
    return { started: false, serverUrl: url, dbPath: existingServerDatabasePath(url), stop: async () => undefined };
  }
  const parsed = new URL(url);
  const port = parsed.port || '80';
  const serverDir = fs.mkdtempSync(path.join(outputDir, 'chromium-server-'));
  const dbPath = path.join(serverDir, 'tabatlas.sqlite');
  const log = fs.createWriteStream(path.join(outputDir, 'chromium-server.log'), { flags: 'a' });
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, 'src/server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      TABATLAS_RUNTIME_PROFILE: 'acceptance',
      TABATLAS_PORT: port,
      TABATLAS_DB: dbPath,
      TABATLAS_BOOTSTRAP_DIR: serverDir,
      TABATLAS_INSTANCE_NAME: 'chromium-extension-acceptance',
      TABATLAS_ALLOW_IDENTITY_INIT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  await waitForHealth(url, 30_000, child);
  return {
    started: true,
    serverUrl: url,
    dbPath,
    stop: async () => {
      await stopProcess(child);
      log.end();
    },
  };
}

function existingServerDatabasePath(url: string): string | undefined {
  const parsed = new URL(url);
  const port = parsed.port || '80';
  const infoPath = path.join(root, '.local', `tabatlas-server-${port}.json`);
  if (!fs.existsSync(infoPath)) return undefined;
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { database?: string };
    if (!info.database) return undefined;
    return path.isAbsolute(info.database) ? info.database : path.join(root, info.database);
  } catch {
    return undefined;
  }
}

async function getAdminToken(url: string): Promise<AdminToken> {
  if (process.env.TABATLAS_ACCEPTANCE_ADMIN_TOKEN) {
    return { token: process.env.TABATLAS_ACCEPTANCE_ADMIN_TOKEN, createdByScript: false };
  }
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const response = await fetch(`${url}/api/security/capabilities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'automation',
      scopes: ['admin'],
      label: 'Chromium acceptance admin',
      expiresAt,
    }),
  });
  if (!response.ok) {
    throw new Error(`Unable to create temporary admin token (${response.status}). Set TABATLAS_ACCEPTANCE_ADMIN_TOKEN for an existing receiver.`);
  }
  const payload = await response.json() as { token: string; capability?: { id?: string } };
  return {
    token: payload.token,
    capabilityId: payload.capability?.id,
    createdByScript: true,
  };
}

async function createPairingChallenge(url: string, token: string, browser: ExtensionPairingBrowser): Promise<PairingChallenge> {
  const payload = await fetchJson<{ challenge: { id: string }; secret: string }>(`${url}/api/security/pairing-codes`, {
    method: 'POST',
    token,
    body: {
      browser,
      ttlMs: 5 * 60_000,
      label: 'Automated bundled Chromium acceptance (Chrome-compatible extension pairing identity)',
    },
  });
  return { challengeId: payload.challenge.id, secret: payload.secret };
}

async function waitForSnapshot(url: string, token: string, before: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const status = await fetchJson<{ snapshots: number }>(`${url}/api/status`, { token });
    if (status.snapshots > before) return status.snapshots;
    await delay(500);
  }
  throw new Error('snapshot did not arrive');
}

async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`receiver exited early with code ${child.exitCode}`);
    if (await health(url)) return;
    await delay(500);
  }
  throw new Error(`receiver did not become healthy at ${url}`);
}

async function fetchJson<T = unknown>(url: string, options: {
  method?: string;
  token?: string;
  body?: unknown;
} = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { 'x-tab-atlas-token': options.token } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Request failed ${response.status} ${url}: ${text.slice(0, 400)}`);
  }
  return await response.json() as T;
}

function chromiumEvidenceFromDatabase(dbPath: string, tokenCapabilityId: string, token: string): {
  snapshotId: string;
  denialAuditId: string;
  tokenAbsentFromSnapshot: boolean;
} {
  const db = openDatabase(dbPath);
  try {
    const snapshot = db.prepare(`
      SELECT id, raw_json
      FROM snapshots
      ORDER BY captured_at DESC
      LIMIT 1
    `).get() as { id: string; raw_json: string | null } | undefined;
    const denial = db.prepare(`
      SELECT id
      FROM security_audit_events
      WHERE capability_id = ?
        AND outcome = 'denied'
        AND route = '/snapshot'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(tokenCapabilityId) as { id: string } | undefined;
    if (!snapshot?.id) throw new Error('Chromium acceptance snapshot ID was not found in receiver DB');
    if (!denial?.id) throw new Error('Chromium acceptance denial audit ID was not found in receiver DB');
    const raw = snapshot.raw_json ?? '';
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    return {
      snapshotId: snapshot.id,
      denialAuditId: denial.id,
      tokenAbsentFromSnapshot: !token || (!raw.includes(token) && !raw.includes(tokenHash)),
    };
  } finally {
    db.close();
  }
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
    notes: `strategy=${evidence.strategy}; session=${evidence.acceptanceSessionId}; capability=${evidence.capabilityId}; snapshot=${evidence.snapshotId}; denialAudit=${evidence.denialAuditId}`,
  };
}

function extensionDirectory(): string {
  const packaged = path.join(root, 'release', 'tabatlas-extension');
  if (fs.existsSync(path.join(packaged, 'manifest.json'))) return packaged;
  return path.join(root, 'extension');
}

function extensionIdFromWorkerUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'chrome-extension:') throw new Error(`Unexpected extension worker URL: ${url}`);
  return parsed.hostname;
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    if (child.connected) child.send('tabatlas:shutdown');
    else child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 3_000).unref();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
