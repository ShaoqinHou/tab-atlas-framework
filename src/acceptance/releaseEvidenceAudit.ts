import type { LiveAcceptanceReport } from './contracts.js';
import { BackupRestoreEvidence } from './releaseGatePolicy.js';
import {
  BrowserExecutionEvidence,
  allBehaviorProofPassed,
  validateBrowserExecutionEvidence,
} from './browserEvidencePolicy.js';

export const RELEASE_VALIDATION_COMMANDS = [
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
] as const;

export const REQUIRED_BACKUP_TABLES = [
  'snapshots',
  'resources',
  'tab_observations',
  'extraction_artifacts',
  'user_annotations',
  'views',
  'memberships',
  'conversation_threads',
  'agent_actions',
  'local_capabilities',
  'manual_browser_acceptance_sessions',
] as const;

export type ReleaseGrade = 'release_ready' | 'degraded_candidate' | 'blocked';

export interface ReleaseEvidenceAuditInput {
  report: LiveAcceptanceReport;
  browserEvidence: BrowserExecutionEvidence[];
  packageFilesExist: boolean;
  packageHashesMatch: boolean;
  requiredPackageContentsPresent: boolean;
  backupRestore?: unknown;
}

export interface ReleaseEvidenceAuditResult {
  grade: ReleaseGrade;
  blockers: string[];
  degradedReasons: string[];
  browserStrategies: Record<string, string>;
}

/**
 * Final, non-recursive release audit. `acceptance:report` validates this
 * evidence; it is intentionally not a prerequisite row inside the evidence
 * being validated.
 */
export function auditReleaseEvidence(input: ReleaseEvidenceAuditInput): ReleaseEvidenceAuditResult {
  const blockers: string[] = [];
  const degradedReasons: string[] = [];
  const report = input.report;

  const evidenceByBrowser = new Map<string, BrowserExecutionEvidence>();
  for (const raw of input.browserEvidence) {
    const evidence = BrowserExecutionEvidence.parse(raw);
    if (evidenceByBrowser.has(evidence.browser)) blockers.push(`duplicate browser evidence: ${evidence.browser}`);
    evidenceByBrowser.set(evidence.browser, evidence);
    blockers.push(...validateBrowserExecutionEvidence(evidence));
  }
  for (const browser of ['chromium', 'chrome', 'edge'] as const) {
    const evidence = evidenceByBrowser.get(browser);
    if (!evidence) {
      blockers.push(`browser evidence missing: ${browser}`);
      continue;
    }
    if (!allBehaviorProofPassed(evidence)) blockers.push(`browser evidence incomplete: ${browser}`);
    const reportRow = report.browserSmokes.find(row => row.browser === browser);
    if (!reportRow) blockers.push(`acceptance report row missing: ${browser}`);
    else if (!reportRowMatchesEvidence(reportRow, evidence)) blockers.push(`acceptance report row disagrees with server evidence: ${browser}`);
  }

  for (const required of RELEASE_VALIDATION_COMMANDS) {
    const row = report.validationCommands.find(candidate => commandMatches(candidate.command, required));
    if (!row) blockers.push(`required validation missing: ${required}`);
    else if (!row.passed) blockers.push(`required validation failed: ${required}`);
  }

  const requiredCommands = new Set([
    'tab-manager-project',
    'loose-inspiration',
    'collection-video-items',
    'opened-later-unmarked',
  ]);
  const seenCommands = new Set<string>();
  for (const command of report.privateLibrarySmoke.commands) {
    if (!requiredCommands.has(command.commandId)) continue;
    seenCommands.add(command.commandId);
    if (command.status !== 'passed') blockers.push(`private-library command did not pass: ${command.commandId}`);
    if (command.mode !== 'codex') blockers.push(`private-library command was not Codex mode: ${command.commandId}`);
    if (!command.retrievalRunId || !command.agentRunId || !command.promptManifestIds.length) {
      blockers.push(`private-library exact IDs missing: ${command.commandId}`);
    }
    if (!command.providerRole || !command.providerScope || !command.providerModel || !command.providerReasoningEffort || !command.providerThreadId) {
      blockers.push(`private-library provider identity missing: ${command.commandId}`);
    }
    if (!command.usage || command.usage.quotaTurns === undefined || command.usage.quotaTurns <= 0) {
      blockers.push(`private-library actual Codex usage missing: ${command.commandId}`);
    }
    if (!command.promptRedactionOk) blockers.push(`private-library prompt redaction failed: ${command.commandId}`);
    if (command.hierarchicalPlanning?.failedChunkCount && command.hierarchicalPlanning.failedChunkCount > 0) {
      degradedReasons.push(`private-library command used degraded hierarchical chunks: ${command.commandId}`);
    }
  }
  for (const commandId of requiredCommands) {
    if (!seenCommands.has(commandId)) blockers.push(`private-library command evidence missing: ${commandId}`);
  }

  if (!report.releaseArtifacts.appPackageSha256 || !report.releaseArtifacts.extensionPackageSha256) {
    blockers.push('package SHA-256 evidence missing');
  }
  if (!input.packageFilesExist) blockers.push('release package file missing');
  if (!input.packageHashesMatch) blockers.push('release package hash mismatch');
  if (!input.requiredPackageContentsPresent) blockers.push('required package content missing');

  if (!input.backupRestore) {
    blockers.push('backup/restore evidence missing');
  } else {
    const backup = BackupRestoreEvidence.parse(input.backupRestore);
    if (!backup.sourceDatabaseIntegrityOk || !backup.restoredDatabaseIntegrityOk) blockers.push('SQLite integrity check failed');
    if (!backup.serverStoppedDuringRestore) blockers.push('restore was not performed while the server was stopped');
    if (backup.sourceSnapshotCount !== backup.restoredSnapshotCount) blockers.push('restored snapshot count differs from source');
    if (backup.sourceResourceCount !== backup.restoredResourceCount) blockers.push('restored resource count differs from source');
    const tables = new Set(backup.requiredTablesPresent);
    for (const table of REQUIRED_BACKUP_TABLES) {
      if (!tables.has(table)) blockers.push(`restored database required table missing: ${table}`);
    }
  }

  if (Object.values(report.safety).some(Boolean)) blockers.push('safety flag is set');
  if (!report.runtime.receiverListIncludesServer || !report.runtime.manifestCoversServer || !report.runtime.popupDefaultMatchesServer) {
    blockers.push('runtime port compatibility failed');
  }

  const uniqueBlockers = [...new Set(blockers)];
  const uniqueDegraded = [...new Set(degradedReasons)];
  return {
    grade: uniqueBlockers.length ? 'blocked' : uniqueDegraded.length ? 'degraded_candidate' : 'release_ready',
    blockers: uniqueBlockers,
    degradedReasons: uniqueDegraded,
    browserStrategies: Object.fromEntries([...evidenceByBrowser.entries()].map(([browser, evidence]) => [browser, evidence.strategy])),
  };
}

function reportRowMatchesEvidence(
  row: LiveAcceptanceReport['browserSmokes'][number],
  evidence: BrowserExecutionEvidence,
): boolean {
  return row.popupOpened === evidence.popupOpened
    && row.receiverReachable === evidence.receiverReachable
    && row.pairedThroughPopup === evidence.pairedThroughPopup
    && row.snapshotExportedThroughPopup === evidence.snapshotExportedThroughPopup
    && row.snapshotArrived === evidence.snapshotArrived
    && row.revocationVisible === evidence.revocationObserved
    && row.tokenAbsentFromSnapshot === evidence.tokenAbsentFromSnapshot;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

function commandMatches(actual: string, required: string): boolean {
  const left = normalizeCommand(actual);
  const right = normalizeCommand(required);
  return left === right || left.startsWith(`${right} `);
}
