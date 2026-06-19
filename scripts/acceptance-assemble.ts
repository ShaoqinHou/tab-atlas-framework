import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BrowserExecutionEvidence, type BrowserExecutionEvidence as BrowserExecutionEvidenceType } from '../src/acceptance/browserEvidencePolicy.js';
import { checkPortCompatibility } from '../src/acceptance/portCompatibility.js';
import { LiveAcceptanceReport, PrivateLibraryCommandSmoke, ValidationCommandResult, type LiveAcceptanceReport as LiveAcceptanceReportType } from '../src/acceptance/contracts.js';
import { RELEASE_VALIDATION_COMMANDS, auditReleaseEvidence } from '../src/acceptance/releaseEvidenceAudit.js';

const root = process.cwd();
const acceptanceDir = path.join(root, '.local', 'acceptance');
const outputPath = path.join(acceptanceDir, 'live-acceptance-redacted.json');
const summaryPath = path.join(acceptanceDir, 'release-evidence-summary.json');
const hashPath = path.join(acceptanceDir, 'live-acceptance-redacted.sha256');

fs.mkdirSync(acceptanceDir, { recursive: true });

const browserEvidence = [
  readSingleBrowserEvidence('chromium', path.join(acceptanceDir, 'chromium-smoke.json')),
  readSingleBrowserEvidence('chrome', path.join(acceptanceDir, 'product-browser-chrome.json')),
  readSingleBrowserEvidence('edge', path.join(acceptanceDir, 'product-browser-edge.json')),
];
validateDistinctBrowserEvidence(browserEvidence);

const validationCommands = readValidationCommands();
const releaseManifest = readReleaseManifest();
const packageEvidence = verifyPackages(releaseManifest);
const privateLibrary = readPrivateLibrarySmoke();
const backupRestoreEvidence = redactedBackupRestoreEvidence(readJson(path.join(acceptanceDir, 'restore-evidence.json')));
const runtime = checkPortCompatibility(root, process.env.TABATLAS_SERVER_URL ?? 'http://127.0.0.1:9787');

const report = LiveAcceptanceReport.parse({
  schemaVersion: 'tabatlas-live-acceptance-v1',
  generatedAt: new Date().toISOString(),
  runtime,
  browserSmokes: browserEvidence.map(smokeFromBrowserEvidence),
  browserEvidence,
  privateLibrarySmoke: {
    ran: privateLibrary.commands.length > 0,
    commands: privateLibrary.commands,
  },
  validationCommands,
  releaseArtifacts: {
    appPackagePath: packageEvidence.app.path,
    extensionPackagePath: packageEvidence.extension.path,
    appPackageSha256: packageEvidence.app.sha256,
    extensionPackageSha256: packageEvidence.extension.sha256,
    installDocsPath: releaseManifest.contents?.installDocs ?? 'docs/32-release-candidate.md',
    backupRestoreDocsPath: 'docs/32-release-candidate.md',
  },
  backupRestoreEvidence,
  safety: safetyFlags({
    browserEvidence,
    privateCommands: privateLibrary.commands,
    backupRestoreEvidence,
    validationCommands,
    releaseArtifacts: packageEvidence,
  }),
  blockers: [],
  releaseReady: false,
});

const audit = auditReleaseEvidence({
  report,
  browserEvidence,
  backupRestore: report.backupRestoreEvidence,
  packageFilesExist: packageEvidence.app.exists && packageEvidence.extension.exists,
  packageHashesMatch: !packageEvidence.app.hashMismatch && !packageEvidence.extension.hashMismatch,
  requiredPackageContentsPresent: packageEvidence.app.missingEntries.length === 0 && packageEvidence.extension.missingEntries.length === 0,
});
const finalReport = LiveAcceptanceReport.parse({
  ...report,
  blockers: audit.blockers,
  releaseReady: audit.grade === 'release_ready',
});
const serialized = `${JSON.stringify(finalReport, null, 2)}\n`;
const reportHash = sha256Text(serialized);
fs.writeFileSync(outputPath, serialized);
fs.writeFileSync(hashPath, `${reportHash}  ${path.relative(root, outputPath).replace(/\\/g, '/')}\n`);
fs.writeFileSync(summaryPath, `${JSON.stringify({
  generatedAt: finalReport.generatedAt,
  reportPath: path.relative(root, outputPath).replace(/\\/g, '/'),
  reportSha256: reportHash,
  grade: audit.grade,
  blockers: audit.blockers,
  degradedReasons: audit.degradedReasons,
  browserStrategies: audit.browserStrategies,
  packages: {
    app: { path: packageEvidence.app.path, sha256: packageEvidence.app.sha256 },
    extension: { path: packageEvidence.extension.path, sha256: packageEvidence.extension.sha256 },
  },
}, null, 2)}\n`);

console.log(`Evidence bundle: ${outputPath}`);
console.log(`Evidence SHA-256: ${reportHash}`);
console.log(`Release grade: ${audit.grade}`);
if (audit.blockers.length) {
  console.error('Blockers:');
  for (const blocker of audit.blockers) console.error(`- ${blocker}`);
}
if (audit.degradedReasons.length) {
  console.error('Degraded reasons:');
  for (const reason of audit.degradedReasons) console.error(`- ${reason}`);
}
if (audit.grade === 'blocked') process.exit(1);
if (audit.grade === 'degraded_candidate') process.exit(2);

function readSingleBrowserEvidence(
  browser: 'chromium' | 'chrome' | 'edge',
  filePath: string,
): BrowserExecutionEvidenceType {
  const payload = readJson(filePath) as { browserEvidence?: unknown[] };
  const raw = payload.browserEvidence?.find(item => isRecord(item) && item.browser === browser);
  if (!raw) throw new Error(`browserEvidence missing for ${browser}: ${filePath}`);
  return BrowserExecutionEvidence.parse(raw);
}

function validateDistinctBrowserEvidence(evidence: BrowserExecutionEvidenceType[]): void {
  for (const field of ['acceptanceSessionId', 'capabilityId', 'snapshotId', 'denialAuditId'] as const) {
    const values = evidence.map(item => item[field]);
    if (new Set(values).size !== values.length) {
      throw new Error(`browser evidence has duplicate ${field}`);
    }
  }
}

function readPrivateLibrarySmoke(): { commands: z.infer<typeof PrivateLibraryCommandSmoke>[] } {
  const payload = readJson(path.join(acceptanceDir, 'private-library-smoke.json')) as { commands?: unknown[] };
  return { commands: z.array(PrivateLibraryCommandSmoke).parse(payload.commands ?? []) };
}

function readValidationCommands(): z.infer<typeof ValidationCommandResult>[] {
  const validationPath = path.join(acceptanceDir, 'validation-results.json');
  if (fs.existsSync(validationPath)) {
    const payload = readJson(validationPath) as { validationCommands?: unknown[] } | unknown[];
    const rows = Array.isArray(payload) ? payload : payload.validationCommands;
    return z.array(ValidationCommandResult).parse(rows ?? []);
  }
  const previousPath = path.join(acceptanceDir, 'local-redacted-report.json');
  if (fs.existsSync(previousPath)) {
    const previous = LiveAcceptanceReport.parse(readJson(previousPath));
    return previous.validationCommands.filter(row => RELEASE_VALIDATION_COMMANDS.some(required => commandMatches(row.command, required)));
  }
  return RELEASE_VALIDATION_COMMANDS.map(command => ({
    command,
    passed: false,
    summary: 'not recorded in .local/acceptance/validation-results.json',
  }));
}

function readReleaseManifest(): {
  contents?: { installDocs?: string };
  packages?: Array<{ label: string; path: string; exists: boolean; sha256?: string }>;
} {
  return readJson(path.join(root, 'release', 'release-manifest.json')) as {
    contents?: { installDocs?: string };
    packages?: Array<{ label: string; path: string; exists: boolean; sha256?: string }>;
  };
}

function verifyPackages(manifest: ReturnType<typeof readReleaseManifest>): {
  app: PackageEvidence;
  extension: PackageEvidence;
} {
  return {
    app: verifyPackage(manifest, 'app', ['package.json', 'src/server/index.ts', 'web-ui/index.html', 'docs/32-release-candidate.md']),
    extension: verifyPackage(manifest, 'extension', ['manifest.json', 'service_worker.js', 'popup.html', 'popup.js']),
  };
}

type PackageEvidence = {
  path: string;
  exists: boolean;
  sha256?: string;
  hashMismatch: boolean;
  missingEntries: string[];
};

function verifyPackage(
  manifest: ReturnType<typeof readReleaseManifest>,
  label: 'app' | 'extension',
  requiredEntries: string[],
): PackageEvidence {
  const entry = manifest.packages?.find(item => item.label === label);
  const relativePath = entry?.path ?? (label === 'app' ? 'release/tabatlas-app.zip' : 'release/tabatlas-extension.zip');
  const resolved = path.join(root, relativePath);
  const exists = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  const sha256 = exists ? sha256File(resolved) : undefined;
  const hashMismatch = Boolean(entry?.sha256 && sha256 && entry.sha256.toLowerCase() !== sha256.toLowerCase()) || !entry?.sha256;
  return {
    path: relativePath.replace(/\\/g, '/'),
    exists,
    sha256,
    hashMismatch,
    missingEntries: exists ? inspectPackageContents(resolved, requiredEntries) : requiredEntries,
  };
}

function inspectPackageContents(zipPath: string, requiredEntries: string[]): string[] {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-assemble-'));
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(temp)} -Force`,
    ], { encoding: 'utf8' });
    if (result.status !== 0) return [`unable to inspect archive: ${(result.stderr || result.stdout).slice(0, 200)}`];
    return requiredEntries.filter(entry => !fs.existsSync(path.join(temp, entry)));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function redactedBackupRestoreEvidence(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const copy = { ...raw };
  if (typeof copy.backupPath === 'string') copy.backupPath = redactLocalPath(copy.backupPath);
  return copy;
}

function safetyFlags(value: unknown): {
  privateUrlsCommitted: boolean;
  privateTitlesCommitted: boolean;
  rawPromptBodiesCommitted: boolean;
  tokensCommitted: boolean;
  rawAcceptanceReportCommitted: boolean;
} {
  const text = JSON.stringify(value);
  return {
    privateUrlsCommitted: /https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(text),
    privateTitlesCommitted: false,
    rawPromptBodiesCommitted: /rawPrompt|promptBody|resourceText/i.test(text),
    tokensCommitted: /\b(?:TA-[A-Z0-9-]{10,}|ta_[A-Za-z0-9_-]{20,}|x-tab-atlas-token)\b/.test(text),
    rawAcceptanceReportCommitted: false,
  };
}

function smokeFromBrowserEvidence(evidence: BrowserExecutionEvidenceType): LiveAcceptanceReportType['browserSmokes'][number] {
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

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function redactLocalPath(value: string): string {
  const resolved = path.resolve(value);
  const relative = path.relative(root, resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative.replace(/\\/g, '/');
  return `sha256:${sha256Text(resolved.toLowerCase())}`;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function commandMatches(actual: string, required: string): boolean {
  const left = actual.trim().replace(/\s+/g, ' ').toLowerCase();
  const right = required.trim().replace(/\s+/g, ' ').toLowerCase();
  return left === right || left.startsWith(`${right} `);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
