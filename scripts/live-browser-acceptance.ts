import fs from 'node:fs';
import path from 'node:path';
import { checkPortCompatibility } from '../src/acceptance/portCompatibility.js';
import { browserStrategyAdvice } from '../src/acceptance/browserStrategy.js';

const root = process.cwd();
const outputDir = path.join(root, '.local', 'acceptance');
const outputPath = path.join(outputDir, 'browser-acceptance-guide.json');
const runtime = checkPortCompatibility(root, process.env.TABATLAS_SERVER_URL);
const chromePath = findFirstExisting([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]);
const edgePath = findFirstExisting([
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]);

fs.mkdirSync(outputDir, { recursive: true });
const guide = {
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
  extensionDirectory: extensionDirectory(),
  productBrowserAcceptance: [
    'npm run acceptance:product-browsers -- --browser chrome',
    'npm run acceptance:product-browsers -- --browser edge',
  ],
  notes: [
    'This command only writes a guide. It does not create pairing challenges because the pairing secret must be shown once and must not be stored in a template.',
    'Use acceptance:product-browsers for evidence-backed Chrome and Edge acceptance. That flow creates the session, prints the one-time secret, verifies snapshot arrival, revokes the capability, and writes redacted evidence.',
  ],
  browserSmokes: [
    emptySmoke('chrome'),
    emptySmoke('edge'),
  ],
};
fs.writeFileSync(outputPath, JSON.stringify(guide, null, 2));

console.log(`Runtime server: ${runtime.serverUrl}`);
console.log(`Chrome executable: ${chromePath || '(not found)'}`);
console.log(`Edge executable: ${edgePath || '(not found)'}`);
console.log(`Extension directory: ${extensionDirectory()}`);
console.log('Run product browser acceptance with:');
console.log('  npm run acceptance:product-browsers -- --browser chrome');
console.log('  npm run acceptance:product-browsers -- --browser edge');
console.log(`Browser acceptance guide written to ${outputPath}`);
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

function extensionDirectory(): string {
  const packaged = path.join(root, 'release', 'tabatlas-extension');
  if (fs.existsSync(path.join(packaged, 'manifest.json'))) return packaged;
  return path.join(root, 'extension');
}
