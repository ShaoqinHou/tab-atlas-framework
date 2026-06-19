import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import {
  createManualBrowserAcceptanceSession,
  getManualBrowserAcceptanceSession,
} from '../src/acceptance/manualBrowserSession.js';
import {
  hierarchicalEvidenceFingerprint,
  unresolvedTargetDescriptors,
  validateSemanticChunkCoverage,
} from '../src/ai/hierarchicalPlannerSafety.js';
import { strictReleaseBlockers } from '../src/acceptance/releaseGatePolicy.js';
import { LiveAcceptanceReport } from '../src/acceptance/contracts.js';
import type { ResourceBrief } from '../src/shared/schemas.js';

function brief(): ResourceBrief {
  return {
    resourceId: 'res_1',
    canonicalUrl: 'https://example.com/reference?token=secret',
    redactedUrl: 'https://example.com/reference',
    urlKind: 'web_page',
    host: 'example.com',
    title: 'Forest art reference',
    browserGroupTitles: ['Game ideas'],
    userAnnotations: [{
      id: 'ann_1',
      targetKind: 'resource',
      targetId: 'res_1',
      tags: ['inspiration', 'game'],
      description: 'Use this as a forest level moodboard.',
      decision: 'inspiration',
      source: 'focused_review',
      createdAt: '2026-06-18T00:00:00.000Z',
    }],
    systemTags: ['web_page'],
    summary: 'Forest art reference',
    atomicItems: [{
      itemId: 'item_1',
      itemKind: 'idea',
      name: 'Forest lighting idea',
      summary: 'Lighting reference.',
      evidenceRefs: ['ev_title_1'],
      confidence: 0.7,
    }],
    extractionStatus: 'complete',
    evidence: [{
      id: 'ev_title_1',
      kind: 'title',
      text: 'Forest art reference',
      provenance: 'extension_snapshot',
      confidence: 0.45,
    }],
  };
}

describe('release closure scaffold', () => {
  it('loads release acceptance tables through the normal database opener', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'manual_browser_acceptance_sessions',
        'hierarchical_planning_runs',
        'hierarchical_planning_chunks'
      )
      ORDER BY name
    `).all() as { name: string }[];
    expect(tables.map(row => row.name)).toEqual([
      'hierarchical_planning_chunks',
      'hierarchical_planning_runs',
      'manual_browser_acceptance_sessions',
    ]);
  });

  it('invalidates hierarchical checkpoints when user evidence changes', () => {
    const first = brief();
    const second = brief();
    second.userAnnotations[0].description = 'Use this only as a painting reference.';
    const identity = {
      commandText: 'Make a game inspiration board.',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      providerRole: 'semantic_planner',
      providerScopeKey: 'conversation:1',
    };
    expect(hierarchicalEvidenceFingerprint(first ? [first] : [], identity))
      .not.toBe(hierarchicalEvidenceFingerprint([second], identity));
  });

  it('rejects silent resource loss and preserves unresolved atomic-item kind', () => {
    const inputBrief = brief();
    const result = {
      commandText: 'Make a game inspiration board.',
      chunkId: 'chunk_1',
      decisions: [{
        targetKind: 'atomic_item' as const,
        targetId: 'item_1',
        state: 'weak_include' as const,
        confidence: 0.6,
        reason: 'Possible lighting inspiration.',
        evidenceRefs: ['ev_title_1'],
      }],
      unresolvedTargets: [],
      notes: [],
    };
    expect(validateSemanticChunkCoverage(result, [inputBrief]))
      .toContain('resource res_1 is missing from decisions and unresolvedTargets');

    const unresolved = unresolvedTargetDescriptors([{
      ...result,
      decisions: [{
        targetKind: 'resource' as const,
        targetId: 'res_1',
        state: 'needs_review' as const,
        confidence: 0.4,
        reason: 'Needs review.',
        evidenceRefs: ['ev_title_1'],
      }],
      unresolvedTargets: ['item_1'],
    }], [inputBrief]);
    expect(unresolved).toEqual([{ targetKind: 'atomic_item', targetId: 'item_1' }]);
  });

  it('returns a pairing secret once without storing it in the acceptance session', () => {
    const db = openDatabase(':memory:');
    const created = createManualBrowserAcceptanceSession(db, {
      browser: 'chrome',
      receiverUrl: 'http://127.0.0.1:9787',
    });
    expect(created.challengeSecret.length).toBeGreaterThan(20);
    const session = getManualBrowserAcceptanceSession(db, created.session.id);
    expect(JSON.stringify(session)).not.toContain(created.challengeSecret);
    const row = db.prepare('SELECT * FROM manual_browser_acceptance_sessions WHERE id = ?').get(session.id);
    expect(JSON.stringify(row)).not.toContain(created.challengeSecret);
  });

  it('blocks release when browser mode, exact evidence, or backup proof is missing', () => {
    const report = LiveAcceptanceReport.parse({
      schemaVersion: 'tabatlas-live-acceptance-v1',
      generatedAt: '2026-06-18T00:00:00.000Z',
      runtime: {
        serverUrl: 'http://127.0.0.1:9787',
        receiverListIncludesServer: true,
        manifestCoversServer: true,
        popupDefaultMatchesServer: true,
      },
      browserSmokes: [{
        browser: 'chromium', mode: 'automated', popupOpened: true, receiverReachable: true,
        pairedThroughPopup: true, snapshotExportedThroughPopup: true, snapshotArrived: true,
        revocationVisible: true, tokenAbsentFromSnapshot: true,
      }, {
        browser: 'chrome', mode: 'automated', popupOpened: true, receiverReachable: true,
        pairedThroughPopup: true, snapshotExportedThroughPopup: true, snapshotArrived: true,
        revocationVisible: true, tokenAbsentFromSnapshot: true,
      }, {
        browser: 'edge', mode: 'manual', popupOpened: true, receiverReachable: true,
        pairedThroughPopup: true, snapshotExportedThroughPopup: true, snapshotArrived: true,
        revocationVisible: true, tokenAbsentFromSnapshot: true,
      }],
      privateLibrarySmoke: {
        ran: true,
        commands: ['tab-manager-project', 'loose-inspiration', 'collection-video-items', 'opened-later-unmarked'].map(commandId => ({
          commandId,
          description: commandId,
          status: 'passed',
          mode: 'codex',
          candidateCount: 10,
          selectedCount: 5,
          retrievalSourceCoverage: {},
          retrievalRunId: `retrieval_${commandId}`,
          promptManifestIds: [],
          providerScope: `scope_${commandId}`,
          providerThreadId: null,
          codexTurns: 1,
          strongIncludeCount: 1,
          weakIncludeCount: 0,
          conflictCount: 0,
          needsReviewCount: 0,
          evidenceReasonCategories: [],
          usedUserNotes: false,
          usedCodexScanEvidence: false,
          usedAtomicItems: false,
          promptRedactionOk: true,
        })),
      },
      validationCommands: [],
      releaseArtifacts: {
        appPackagePath: 'release/app.zip',
        extensionPackagePath: 'release/extension.zip',
        installDocsPath: 'docs/install.md',
        backupRestoreDocsPath: 'docs/backup.md',
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

    const blockers = strictReleaseBlockers({
      report,
      packageFilesExist: false,
      packageHashesMatch: false,
      requiredPackageContentsPresent: false,
    });
    expect(blockers).toEqual(expect.arrayContaining([
      'Chrome manual product acceptance missing or mislabeled',
      'backup/restore evidence missing',
      'app package SHA-256 missing from report',
    ]));
    expect(blockers.some(blocker => blocker.includes('prompt manifest IDs missing'))).toBe(true);
  });
});
