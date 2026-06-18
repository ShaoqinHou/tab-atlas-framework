import fs from 'node:fs';
import path from 'node:path';
import { checkPortCompatibility } from '../src/acceptance/portCompatibility.js';

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

fs.mkdirSync(outputDir, { recursive: true });
const template = {
  generatedAt: new Date().toISOString(),
  runtime,
  browserExecutables: {
    chrome: chromePath,
    edge: edgePath,
  },
  requiredManualSteps: [
    'Start TabAtlas on runtime.serverUrl.',
    'Load release/tabatlas-extension or release/tabatlas-extension.zip as an unpacked extension.',
    'Open the TabAtlas extension popup.',
    'Create a pairing challenge from the dashboard.',
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
