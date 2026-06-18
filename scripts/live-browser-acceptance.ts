import fs from 'node:fs';
import path from 'node:path';
import { checkPortCompatibility } from '../src/acceptance/portCompatibility.js';
import { browserStrategyAdvice } from '../src/acceptance/browserStrategy.js';

const root = process.cwd();
const outputDir = path.join(root, '.local', 'acceptance');
const outputPath = path.join(outputDir, 'browser-smoke-template.json');
const runtime = checkPortCompatibility(root, process.env.TABATLAS_SERVER_URL);
const chromePath = findFirstExisting([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]);
const edgePath = findFirstExisting([
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]);
const adminToken = process.env.TABATLAS_ACCEPTANCE_ADMIN_TOKEN;

fs.mkdirSync(outputDir, { recursive: true });
const pairingChallenges = adminToken ? await createManualChallenges(runtime.serverUrl, adminToken) : {};
const template = {
  generatedAt: new Date().toISOString(),
  runtime,
  strategy: {
    chromium: browserStrategyAdvice('bundled_chromium_automated'),
    chrome: browserStrategyAdvice('chrome_manual_load_unpacked'),
    edge: browserStrategyAdvice('edge_manual_load_unpacked'),
  },
  browserExecutables: {
    chrome: chromePath,
    edge: edgePath,
  },
  pairingChallenges,
  requiredManualSteps: [
    'Start TabAtlas on runtime.serverUrl.',
    'Use browser Developer mode and Load unpacked with release/tabatlas-extension or the extension/ source directory.',
    'Open the TabAtlas extension popup.',
    'Create a separate pairing challenge for Chrome and Edge, or use the redacted challenge IDs generated in this template when present.',
    'Pair through the popup, export through the popup, verify snapshot arrival, revoke the capability, and verify the next export requires pairing.',
  ],
  browserSmokes: [
    emptySmoke('chrome'),
    emptySmoke('edge'),
  ],
};
fs.writeFileSync(outputPath, JSON.stringify(template, null, 2));

console.log(`Runtime server: ${runtime.serverUrl}`);
console.log(`Chrome executable: ${chromePath || '(not found)'}`);
console.log(`Edge executable: ${edgePath || '(not found)'}`);
if (!adminToken) console.log('No TABATLAS_ACCEPTANCE_ADMIN_TOKEN provided; pairing challenges were not generated.');
console.log(`Browser smoke template written to ${outputPath}`);
if (runtime.issues.length) {
  console.error('Port compatibility issues:');
  for (const issue of runtime.issues) console.error(`- ${issue}`);
  process.exit(1);
}

function emptySmoke(browser: 'chrome' | 'edge') {
  return {
    browser,
    mode: 'manual',
    popupOpened: false,
    receiverReachable: false,
    pairedThroughPopup: false,
    snapshotExportedThroughPopup: false,
    snapshotArrived: false,
    revocationVisible: false,
    tokenAbsentFromSnapshot: false,
    notes: 'Fill after live popup smoke. Do not include URLs, titles, tokens, or raw snapshot JSON.',
  };
}

function findFirstExisting(paths: string[]): string {
  return paths.find(item => fs.existsSync(item)) ?? '';
}

async function createManualChallenges(serverUrl: string, token: string): Promise<Record<string, { challengeId: string; expiresAt?: string }>> {
  const result: Record<string, { challengeId: string; expiresAt?: string }> = {};
  for (const browser of ['chrome', 'edge'] as const) {
    const response = await fetch(`${serverUrl}/api/security/pairing-codes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tab-atlas-token': token,
      },
      body: JSON.stringify({
        browser,
        ttlMs: 10 * 60_000,
        label: `${browser} manual acceptance`,
      }),
    });
    if (!response.ok) {
      result[browser] = { challengeId: `error:${response.status}` };
      continue;
    }
    const payload = await response.json() as { challenge?: { id?: string; expiresAt?: string } };
    result[browser] = {
      challengeId: payload.challenge?.id ?? '',
      expiresAt: payload.challenge?.expiresAt,
    };
  }
  return result;
}
