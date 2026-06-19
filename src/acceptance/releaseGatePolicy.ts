import { z } from 'zod';
import type { LiveAcceptanceReport } from './contracts.js';

export const REQUIRED_VALIDATION_COMMANDS = [
  'npm run typecheck',
  'npm run lint',
  'npm test',
  'npm run eval:semantic',
  'npm run eval:agent',
  'npm run eval:security',
  'npm run eval:privacy',
  'npm run eval:onboarding',
  'npm run eval:retrieval',
  'npm run eval:review',
  'npm run acceptance:ports',
  'npm run acceptance:chromium',
  'npm run acceptance:private-library -- --mode codex --resume',
  'npm run package:extension',
  'npm run package:app',
  'npm run release:manifest',
  'npm run acceptance:report',
] as const;

export const REQUIRED_PRIVATE_LIBRARY_COMMAND_IDS = [
  'tab-manager-project',
  'loose-inspiration',
  'collection-video-items',
  'opened-later-unmarked',
] as const;

export const BackupRestoreEvidence = z.object({
  backupPath: z.string().min(1),
  backupSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDatabaseIntegrityOk: z.boolean(),
  restoredDatabaseIntegrityOk: z.boolean(),
  requiredTablesPresent: z.array(z.string()).min(1),
  sourceSnapshotCount: z.number().int().min(0),
  restoredSnapshotCount: z.number().int().min(0),
  sourceResourceCount: z.number().int().min(0),
  restoredResourceCount: z.number().int().min(0),
  serverStoppedDuringRestore: z.boolean(),
  completedAt: z.string(),
});
export type BackupRestoreEvidence = z.infer<typeof BackupRestoreEvidence>;

export interface StrictReleaseEvidenceInput {
  report: LiveAcceptanceReport;
  backupRestore?: BackupRestoreEvidence;
  packageFilesExist: boolean;
  packageHashesMatch: boolean;
  requiredPackageContentsPresent: boolean;
}

export function strictReleaseBlockers(input: StrictReleaseEvidenceInput): string[] {
  const blockers: string[] = [];
  const report = input.report;

  const byBrowser = new Map(report.browserSmokes.map(smoke => [smoke.browser, smoke]));
  const chromium = byBrowser.get('chromium');
  const chrome = byBrowser.get('chrome');
  const edge = byBrowser.get('edge');

  if (!chromium || chromium.mode !== 'automated') blockers.push('bundled Chromium automated evidence missing or mislabeled');
  if (!chrome || chrome.mode !== 'manual') blockers.push('Chrome manual product acceptance missing or mislabeled');
  if (!edge || edge.mode !== 'manual') blockers.push('Edge manual product acceptance missing or mislabeled');
  for (const smoke of [chromium, chrome, edge].filter(Boolean)) {
    if (!browserSmokePassed(smoke!)) blockers.push(`${smoke!.browser} acceptance evidence incomplete`);
  }

  for (const required of REQUIRED_VALIDATION_COMMANDS) {
    const row = report.validationCommands.find(candidate => commandMatches(candidate.command, required));
    if (!row) blockers.push(`required validation missing: ${required}`);
    else if (!row.passed) blockers.push(`required validation failed: ${required}`);
  }

  const commandMap = new Map(report.privateLibrarySmoke.commands.map(command => [command.commandId, command]));
  for (const commandId of REQUIRED_PRIVATE_LIBRARY_COMMAND_IDS) {
    const command = commandMap.get(commandId);
    if (!command) {
      blockers.push(`private-library evidence missing: ${commandId}`);
      continue;
    }
    if (command.status !== 'passed') blockers.push(`private-library command did not pass: ${commandId}`);
    if (command.mode !== 'codex') blockers.push(`private-library command was not Codex mode: ${commandId}`);
    if (!command.retrievalRunId) blockers.push(`retrieval run ID missing: ${commandId}`);
    if (!command.agentRunId) blockers.push(`agent run ID missing: ${commandId}`);
    if (!command.promptManifestIds.length) blockers.push(`prompt manifest IDs missing: ${commandId}`);
    if (!command.providerRole) blockers.push(`provider role missing: ${commandId}`);
    if (!command.providerScope) blockers.push(`provider scope missing: ${commandId}`);
    if (!command.providerModel) blockers.push(`provider model missing: ${commandId}`);
    if (!command.providerReasoningEffort) blockers.push(`provider reasoning effort missing: ${commandId}`);
    if (!command.providerThreadId) blockers.push(`provider thread ID missing: ${commandId}`);
    if (!command.usage || command.usage.quotaTurns === undefined) blockers.push(`actual usage missing: ${commandId}`);
    if (!command.promptRedactionOk) blockers.push(`prompt redaction evidence failed: ${commandId}`);
  }

  if (!report.releaseArtifacts.appPackageSha256) blockers.push('app package SHA-256 missing from report');
  if (!report.releaseArtifacts.extensionPackageSha256) blockers.push('extension package SHA-256 missing from report');
  if (!input.packageFilesExist) blockers.push('release package file missing');
  if (!input.packageHashesMatch) blockers.push('release package hash mismatch');
  if (!input.requiredPackageContentsPresent) blockers.push('required release package content missing');

  if (!input.backupRestore) {
    blockers.push('backup/restore evidence missing');
  } else {
    const backup = BackupRestoreEvidence.parse(input.backupRestore);
    if (!backup.sourceDatabaseIntegrityOk || !backup.restoredDatabaseIntegrityOk) blockers.push('SQLite integrity check failed');
    if (!backup.serverStoppedDuringRestore) blockers.push('restore was not performed with server stopped');
    if (backup.sourceSnapshotCount !== backup.restoredSnapshotCount) blockers.push('restored snapshot count differs from source');
    if (backup.sourceResourceCount !== backup.restoredResourceCount) blockers.push('restored resource count differs from source');
  }

  if (Object.values(report.safety).some(Boolean)) blockers.push('safety flag is set');
  return [...new Set(blockers)];
}

export function browserSmokePassed(smoke: LiveAcceptanceReport['browserSmokes'][number]): boolean {
  return smoke.popupOpened
    && smoke.receiverReachable
    && smoke.pairedThroughPopup
    && smoke.snapshotExportedThroughPopup
    && smoke.snapshotArrived
    && smoke.revocationVisible
    && smoke.tokenAbsentFromSnapshot;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

function commandMatches(actual: string, required: string): boolean {
  const normalizedActual = normalizeCommand(actual);
  const normalizedRequired = normalizeCommand(required);
  return normalizedActual === normalizedRequired || normalizedActual.startsWith(`${normalizedRequired} `);
}
