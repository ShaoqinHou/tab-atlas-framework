import fs from 'node:fs';
import { acceptanceBlockers, LiveAcceptanceReport } from '../src/acceptance/contracts.js';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Usage: npm run acceptance:report -- <local-redacted-report.json>');
  process.exit(1);
}

const parsed = LiveAcceptanceReport.safeParse(JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, '')));
if (!parsed.success) {
  console.error('Acceptance report schema validation failed.');
  for (const issue of parsed.error.issues) {
    console.error(`- ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

const report = parsed.data;
const blockers = acceptanceBlockers(report);
const chrome = report.browserSmokes.find(item => item.browser === 'chrome');
const edge = report.browserSmokes.find(item => item.browser === 'edge');

console.log(`Acceptance report: ${report.schemaVersion}`);
console.log(`Generated at: ${report.generatedAt}`);
console.log(`Runtime compatible: ${report.runtime.receiverListIncludesServer && report.runtime.manifestCoversServer && report.runtime.popupDefaultMatchesServer ? 'yes' : 'no'}`);
console.log(`Chrome popup: ${chrome?.pairedThroughPopup && chrome.snapshotArrived && chrome.revocationVisible ? 'pass' : 'fail'}`);
console.log(`Edge popup: ${edge?.pairedThroughPopup && edge.snapshotArrived && edge.revocationVisible ? 'pass' : 'fail'}`);
console.log(`Private library commands: ${report.privateLibrarySmoke.ran ? report.privateLibrarySmoke.commands.length : 0}`);
console.log(`App package: ${report.releaseArtifacts.appPackagePath}`);
console.log(`Extension package: ${report.releaseArtifacts.extensionPackagePath}`);

if (blockers.length) {
  console.error('Blockers:');
  for (const blocker of blockers) console.error(`- ${blocker}`);
}

const ready = report.releaseReady && blockers.length === 0;
console.log(`Release ready: ${ready ? 'yes' : 'no'}`);
if (!ready) process.exit(1);
