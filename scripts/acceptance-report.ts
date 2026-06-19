import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveAcceptanceReport, type LiveAcceptanceReport as LiveAcceptanceReportType } from '../src/acceptance/contracts.js';
import { auditReleaseEvidence } from '../src/acceptance/releaseEvidenceAudit.js';

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
const evidence = deriveEvidence(report);
const audit = auditReleaseEvidence({
  report,
  browserEvidence: report.browserEvidence,
  backupRestore: report.backupRestoreEvidence,
  packageFilesExist: evidence.app.exists && evidence.extension.exists,
  packageHashesMatch: !evidence.app.hashMismatch && !evidence.extension.hashMismatch,
  requiredPackageContentsPresent: evidence.app.missingEntries.length === 0 && evidence.extension.missingEntries.length === 0,
});
const blockers = [...new Set([...evidence.blockers, ...audit.blockers])];
const chromium = report.browserSmokes.find(item => item.browser === 'chromium');
const chrome = report.browserSmokes.find(item => item.browser === 'chrome');
const edge = report.browserSmokes.find(item => item.browser === 'edge');

console.log(`Acceptance report: ${report.schemaVersion}`);
console.log(`Generated at: ${report.generatedAt}`);
console.log(`Caller releaseReady: ${report.releaseReady ? 'yes' : 'no'} (ignored as authority)`);
console.log(`Runtime compatible: ${report.runtime.receiverListIncludesServer && report.runtime.manifestCoversServer && report.runtime.popupDefaultMatchesServer ? 'yes' : 'no'}`);
console.log(`Chromium automated popup: ${passedBrowser(chromium) ? 'pass' : 'fail'}`);
console.log(`Chrome popup: ${passedBrowser(chrome) ? 'pass' : 'fail'} (${audit.browserStrategies.chrome ?? 'missing strategy'})`);
console.log(`Edge popup: ${passedBrowser(edge) ? 'pass' : 'fail'} (${audit.browserStrategies.edge ?? 'missing strategy'})`);
console.log(`Private library commands: ${report.privateLibrarySmoke.ran ? report.privateLibrarySmoke.commands.filter(command => command.status === 'passed').length : 0}/${report.privateLibrarySmoke.commands.length}`);
console.log(`Validation commands: ${report.validationCommands.filter(command => command.passed).length}/${report.validationCommands.length}`);
console.log(`App package: ${evidence.app.path}`);
console.log(`App SHA-256: ${evidence.app.sha256 || '(missing)'}`);
console.log(`Extension package: ${evidence.extension.path}`);
console.log(`Extension SHA-256: ${evidence.extension.sha256 || '(missing)'}`);
console.log(`Release grade: ${audit.grade}`);

if (blockers.length) {
  console.error('Blockers:');
  for (const blocker of blockers) console.error(`- ${blocker}`);
}
if (audit.degradedReasons.length) {
  console.error('Degraded reasons:');
  for (const reason of audit.degradedReasons) console.error(`- ${reason}`);
}

console.log(`Release ready: ${audit.grade === 'release_ready' ? 'yes' : 'no'}`);
if (blockers.length || audit.grade === 'blocked') process.exit(1);
if (audit.grade === 'degraded_candidate') process.exit(2);

function deriveEvidence(reportValue: LiveAcceptanceReportType): {
  blockers: string[];
  app: ArtifactEvidence;
  extension: ArtifactEvidence;
} {
  const blockers: string[] = [];
  if (reportValue.validationCommands.length === 0) blockers.push('validation command evidence missing');
  for (const command of reportValue.validationCommands) {
    if (!command.passed) blockers.push(`validation failed: ${command.command}`);
  }
  const app = verifyArtifact('app', reportValue.releaseArtifacts.appPackagePath, reportValue.releaseArtifacts.appPackageSha256, [
    'package.json',
    'src/server/index.ts',
    'web-ui/index.html',
    'docs/32-release-candidate.md',
  ]);
  const extension = verifyArtifact('extension', reportValue.releaseArtifacts.extensionPackagePath, reportValue.releaseArtifacts.extensionPackageSha256, [
    'manifest.json',
    'service_worker.js',
    'popup.html',
    'popup.js',
  ]);
  blockers.push(...app.blockers, ...extension.blockers);
  for (const docPath of [reportValue.releaseArtifacts.installDocsPath, reportValue.releaseArtifacts.backupRestoreDocsPath]) {
    if (!fs.existsSync(resolveFromRoot(docPath))) blockers.push(`release doc missing: ${docPath}`);
  }
  return { blockers, app, extension };
}

type ArtifactEvidence = {
  label: string;
  path: string;
  exists: boolean;
  sha256?: string;
  hashMismatch: boolean;
  missingEntries: string[];
  blockers: string[];
};

function verifyArtifact(label: string, artifactPath: string, expectedHash: string | undefined, requiredEntries: string[]): ArtifactEvidence {
  const resolved = resolveFromRoot(artifactPath);
  const blockers: string[] = [];
  const exists = Boolean(artifactPath) && fs.existsSync(resolved);
  if (!exists) {
    blockers.push(`${label} package missing: ${artifactPath || '(empty path)'}`);
    return { label, path: resolved, exists, hashMismatch: true, missingEntries: requiredEntries, blockers };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    blockers.push(`${label} package is not a file: ${artifactPath}`);
    return { label, path: resolved, exists, hashMismatch: true, missingEntries: requiredEntries, blockers };
  }
  const sha256 = sha256File(resolved);
  let hashMismatch = false;
  if (expectedHash && expectedHash.toLowerCase() !== sha256.toLowerCase()) {
    hashMismatch = true;
    blockers.push(`${label} package hash mismatch`);
  }
  if (!expectedHash) hashMismatch = true;
  const missingEntries = inspectPackageContents(resolved, requiredEntries);
  for (const entry of missingEntries) blockers.push(`${label} package missing content: ${entry}`);
  return { label, path: resolved, exists, sha256, hashMismatch, missingEntries, blockers };
}

function inspectPackageContents(zipPath: string, requiredEntries: string[]): string[] {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-acceptance-report-'));
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(temp)} -Force`,
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
      return [`unable to inspect archive: ${(result.stderr || result.stdout).slice(0, 200)}`];
    }
    return requiredEntries.filter(entry => !fs.existsSync(path.join(temp, entry)));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function passedBrowser(smoke: LiveAcceptanceReportType['browserSmokes'][number] | undefined): boolean {
  return Boolean(smoke?.popupOpened
    && smoke.receiverReachable
    && smoke.pairedThroughPopup
    && smoke.snapshotExportedThroughPopup
    && smoke.snapshotArrived
    && smoke.revocationVisible
    && smoke.tokenAbsentFromSnapshot);
}

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.join(process.cwd(), value);
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
