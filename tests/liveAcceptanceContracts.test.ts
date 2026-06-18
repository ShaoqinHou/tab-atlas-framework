import { describe, expect, it } from 'vitest';
import { acceptanceBlockers, LiveAcceptanceReport } from '../src/acceptance/contracts.js';
import { checkPortCompatibility } from '../src/acceptance/portCompatibility.js';

describe('live acceptance contracts', () => {
  it('validates a release-ready redacted acceptance report', () => {
    const report = LiveAcceptanceReport.parse({
      schemaVersion: 'tabatlas-live-acceptance-v1',
      generatedAt: new Date().toISOString(),
      runtime: {
        serverUrl: 'http://127.0.0.1:9787',
        receiverListIncludesServer: true,
        manifestCoversServer: true,
        popupDefaultMatchesServer: true,
      },
      browserSmokes: [
        browserSmoke('chromium', 'automated'),
        browserSmoke('chrome'),
        browserSmoke('edge'),
      ],
      privateLibrarySmoke: {
        ran: true,
        commands: ['a', 'b', 'c', 'd'].map(commandId => ({
          commandId,
          description: 'redacted command category',
          status: 'passed',
          mode: 'codex',
          candidateCount: 40,
          selectedCount: 25,
          retrievalSourceCoverage: { user_annotations: 4, fts: 10 },
          retrievalRunId: `retrieval_${commandId}`,
          promptManifestIds: [`prompt_manifest_${commandId}`],
          codexTurns: 1,
          strongIncludeCount: 8,
          weakIncludeCount: 3,
          conflictCount: 1,
          needsReviewCount: 2,
          evidenceReasonCategories: ['user_annotation', 'local_evidence'],
          usedUserNotes: true,
          usedCodexScanEvidence: false,
          usedAtomicItems: false,
          promptRedactionOk: true,
        })),
      },
      validationCommands: [{ command: 'npm test', passed: true, summary: 'ok' }],
      releaseArtifacts: {
        appPackagePath: 'release/tabatlas-app.zip',
        extensionPackagePath: 'release/tabatlas-extension.zip',
        installDocsPath: 'docs/32-release-candidate.md',
        backupRestoreDocsPath: 'docs/32-release-candidate.md',
      },
      safety: {
        privateUrlsCommitted: false,
        privateTitlesCommitted: false,
        rawPromptBodiesCommitted: false,
        tokensCommitted: false,
        rawAcceptanceReportCommitted: false,
      },
      blockers: [],
      releaseReady: true,
    });

    expect(acceptanceBlockers(report)).toEqual([]);
  });

  it('marks missing popup smoke and private-library smoke as blockers', () => {
    const report = LiveAcceptanceReport.parse({
      schemaVersion: 'tabatlas-live-acceptance-v1',
      generatedAt: new Date().toISOString(),
      runtime: {
        serverUrl: 'http://127.0.0.1:9788',
        receiverListIncludesServer: false,
        manifestCoversServer: false,
        popupDefaultMatchesServer: false,
      },
      browserSmokes: [
        { ...browserSmoke('chromium', 'automated'), snapshotArrived: false },
        { ...browserSmoke('chrome'), pairedThroughPopup: false },
        { ...browserSmoke('edge'), revocationVisible: false },
      ],
      privateLibrarySmoke: { ran: false, commands: [] },
      validationCommands: [],
      releaseArtifacts: {
        appPackagePath: '',
        extensionPackagePath: '',
        installDocsPath: 'docs/32-release-candidate.md',
        backupRestoreDocsPath: 'docs/32-release-candidate.md',
      },
      safety: {
        privateUrlsCommitted: false,
        privateTitlesCommitted: false,
        rawPromptBodiesCommitted: false,
        tokensCommitted: true,
        rawAcceptanceReportCommitted: false,
      },
      blockers: [],
      releaseReady: false,
    });

    expect(acceptanceBlockers(report)).toEqual(expect.arrayContaining([
      'runtime port incompatible',
      'chromium automated acceptance incomplete',
      'chrome popup acceptance incomplete',
      'edge popup acceptance incomplete',
      'private-library smoke skipped',
      'private data or token committed',
      'release archive missing',
    ]));
  });

  it('checks current extension/server receiver port compatibility', () => {
    const details = checkPortCompatibility(process.cwd(), 'http://127.0.0.1:9787');

    expect(details.receiverListIncludesServer).toBe(true);
    expect(details.manifestCoversServer).toBe(true);
    expect(details.popupDefaultMatchesServer).toBe(true);
    expect(details.issues).toEqual([]);
  });
});

function browserSmoke(browser: 'chromium' | 'chrome' | 'edge', mode: 'automated' | 'manual' = 'manual') {
  return {
    browser,
    mode,
    popupOpened: true,
    receiverReachable: true,
    pairedThroughPopup: true,
    snapshotExportedThroughPopup: true,
    snapshotArrived: true,
    revocationVisible: true,
    tokenAbsentFromSnapshot: true,
    notes: '',
  };
}
