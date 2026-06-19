import { describe, expect, it } from 'vitest';
import { LiveAcceptanceReport } from '../src/acceptance/contracts.js';
import {
  BrowserExecutionEvidence,
  validateBrowserExecutionEvidence,
} from '../src/acceptance/browserEvidencePolicy.js';
import {
  RELEASE_VALIDATION_COMMANDS,
  REQUIRED_BACKUP_TABLES,
  auditReleaseEvidence,
} from '../src/acceptance/releaseEvidenceAudit.js';

function browserEvidence(
  browser: 'chromium' | 'chrome' | 'edge',
): BrowserExecutionEvidence {
  const strategy = browser === 'chromium'
    ? 'bundled_chromium_playwright'
    : browser === 'chrome'
      ? 'chrome_product_cdp'
      : 'edge_product_cdp';
  return BrowserExecutionEvidence.parse({
    browser,
    strategy,
    automated: true,
    isolatedProfile: true,
    executableVersion: '140.0.0.0',
    extensionLoadMethod: browser === 'chromium'
      ? 'playwright_load_extension_flags'
      : 'cdp_extensions_load_unpacked',
    receiverUrl: 'http://127.0.0.1:9787',
    acceptanceSessionId: `session_${browser}`,
    capabilityId: `cap_${browser}`,
    snapshotId: `snapshot_${browser}`,
    denialAuditId: `audit_${browser}`,
    popupOpened: true,
    receiverReachable: true,
    pairedThroughPopup: true,
    snapshotExportedThroughPopup: true,
    snapshotArrived: true,
    revocationObserved: true,
    tokenAbsentFromSnapshot: true,
    startedAt: '2026-06-18T00:00:00.000Z',
    finishedAt: '2026-06-18T00:01:00.000Z',
  });
}

function report() {
  const browserRows = ['chromium', 'chrome', 'edge'].map(browser => ({
    browser,
    mode: 'automated',
    popupOpened: true,
    receiverReachable: true,
    pairedThroughPopup: true,
    snapshotExportedThroughPopup: true,
    snapshotArrived: true,
    revocationVisible: true,
    tokenAbsentFromSnapshot: true,
    notes: '',
  }));
  const privateCommands = [
    'tab-manager-project',
    'loose-inspiration',
    'collection-video-items',
    'opened-later-unmarked',
  ].map(commandId => ({
    commandId,
    description: commandId,
    status: 'passed',
    mode: 'codex',
    durationMs: 1000,
    candidateCount: 20,
    selectedCount: 10,
    retrievalSourceCoverage: { fts: 10 },
    retrievalRunId: `retrieval_${commandId}`,
    promptManifestIds: [`prompt_${commandId}`],
    agentRunId: `agent_${commandId}`,
    providerRole: 'semantic_planner',
    providerScope: `scope_${commandId}`,
    providerModel: 'gpt-5.5',
    providerReasoningEffort: 'medium',
    providerThreadId: `thread_${commandId}`,
    usage: { quotaTurns: 1 },
    hierarchicalPlanning: {
      mode: 'direct',
      chunkCount: 0,
      splitChunkCount: 0,
      failedChunkCount: 0,
    },
    codexTurns: 1,
    strongIncludeCount: 5,
    weakIncludeCount: 2,
    conflictCount: 0,
    needsReviewCount: 1,
    evidenceReasonCategories: ['user_annotation'],
    usedUserNotes: true,
    usedCodexScanEvidence: false,
    usedAtomicItems: false,
    promptRedactionOk: true,
  }));
  return LiveAcceptanceReport.parse({
    schemaVersion: 'tabatlas-live-acceptance-v1',
    generatedAt: '2026-06-18T00:00:00.000Z',
    runtime: {
      serverUrl: 'http://127.0.0.1:9787',
      receiverListIncludesServer: true,
      manifestCoversServer: true,
      popupDefaultMatchesServer: true,
    },
    browserSmokes: browserRows,
    privateLibrarySmoke: { ran: true, commands: privateCommands },
    validationCommands: RELEASE_VALIDATION_COMMANDS.map(command => ({ command, passed: true, summary: 'passed' })),
    releaseArtifacts: {
      appPackagePath: 'release/tabatlas-app.zip',
      extensionPackagePath: 'release/tabatlas-extension.zip',
      appPackageSha256: 'a'.repeat(64),
      extensionPackageSha256: 'b'.repeat(64),
      installDocsPath: 'docs/32-release-candidate.md',
      backupRestoreDocsPath: 'docs/32-release-candidate.md',
    },
    backupRestoreEvidence: {
      backupPath: 'backups/tabatlas.sqlite',
      backupSha256: 'c'.repeat(64),
      sourceDatabaseIntegrityOk: true,
      restoredDatabaseIntegrityOk: true,
      requiredTablesPresent: [...REQUIRED_BACKUP_TABLES],
      sourceSnapshotCount: 10,
      restoredSnapshotCount: 10,
      sourceResourceCount: 20,
      restoredResourceCount: 20,
      serverStoppedDuringRestore: true,
      completedAt: '2026-06-18T00:02:00.000Z',
    },
    safety: {
      privateUrlsCommitted: false,
      privateTitlesCommitted: false,
      rawPromptBodiesCommitted: false,
      tokensCommitted: false,
      rawAcceptanceReportCommitted: false,
    },
    blockers: [],
    releaseReady: false,
  });
}

describe('release evidence audit', () => {
  it('labels installed Chrome and Edge CDP runs as automated product-browser evidence', () => {
    const chrome = browserEvidence('chrome');
    const edge = browserEvidence('edge');
    expect(validateBrowserExecutionEvidence(chrome)).toEqual([]);
    expect(validateBrowserExecutionEvidence(edge)).toEqual([]);
    expect(chrome.strategy).toBe('chrome_product_cdp');
    expect(edge.strategy).toBe('edge_product_cdp');
  });

  it('derives release readiness without requiring acceptance:report to validate itself', () => {
    expect(RELEASE_VALIDATION_COMMANDS).not.toContain('npm run acceptance:report');
    const result = auditReleaseEvidence({
      report: report(),
      browserEvidence: [browserEvidence('chromium'), browserEvidence('chrome'), browserEvidence('edge')],
      packageFilesExist: true,
      packageHashesMatch: true,
      requiredPackageContentsPresent: true,
      backupRestore: report().backupRestoreEvidence,
    });
    expect(result).toMatchObject({ grade: 'release_ready', blockers: [], degradedReasons: [] });
  });

  it('grades passed commands with failed hierarchical chunks as degraded rather than release ready', () => {
    const value = report();
    value.privateLibrarySmoke.commands[0].hierarchicalPlanning = {
      mode: 'hierarchical',
      chunkCount: 4,
      splitChunkCount: 1,
      failedChunkCount: 1,
    };
    const result = auditReleaseEvidence({
      report: value,
      browserEvidence: [browserEvidence('chromium'), browserEvidence('chrome'), browserEvidence('edge')],
      packageFilesExist: true,
      packageHashesMatch: true,
      requiredPackageContentsPresent: true,
      backupRestore: value.backupRestoreEvidence,
    });
    expect(result.grade).toBe('degraded_candidate');
    expect(result.degradedReasons[0]).toContain('degraded hierarchical chunks');
  });

  it('blocks release when restored database evidence omits required tables', () => {
    const value = report();
    const backup = { ...value.backupRestoreEvidence!, requiredTablesPresent: ['snapshots'] };
    const result = auditReleaseEvidence({
      report: value,
      browserEvidence: [browserEvidence('chromium'), browserEvidence('chrome'), browserEvidence('edge')],
      packageFilesExist: true,
      packageHashesMatch: true,
      requiredPackageContentsPresent: true,
      backupRestore: backup,
    });
    expect(result.grade).toBe('blocked');
    expect(result.blockers.some(blocker => blocker.includes('resources'))).toBe(true);
  });
});
