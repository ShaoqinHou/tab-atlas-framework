import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { addUserAnnotation } from '../src/annotations/service.js';
import { planSemanticViewHeuristic } from '../src/ai/heuristicSemanticView.js';
import { buildResourceBrief, buildResourceBriefForIntent } from '../src/resources/briefs.js';
import { searchResources } from '../src/agent/tools.js';
import { createCodexScanJob, resumeCodexScanJob } from '../src/agent/scanService.js';
import { importManualYouTubeTranscript } from '../src/extract/youtube.js';
import { recordMembershipFeedback } from '../src/views/feedbackService.js';
import type { LlmProvider } from '../src/llm/types.js';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  evidenceUsed: string;
  pass: boolean;
};

const db = openDatabase(':memory:');
const ids = seedFixtures();
const results: EvalResult[] = [];

results.push(strictGameInspiration());
results.push(looseCrossDomainInspiration());
results.push(artInspiration());
results.push(tabManagerProjectReferences());
results.push(misleadingTitleCorrectedByUserNote());
results.push(paintingTutorialRejectionDoesNotAffectGameArt());
results.push(relatedGameUiPinInclusion());
results.push(transcriptUnavailable());
results.push(await denseVideoTranscriptAtomicItems());
results.push(await titleOnlyDenseLookingNoAtomicItems());

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Evidence used: ${result.evidenceUsed}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Semantic evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Semantic evaluation passed: ${results.length}/${results.length} cases.`);

function seedFixtures() {
  importSnapshot(db, {
    capturedAt: '2026-06-18T00:00:00.000Z',
    tabs: [
      { browser: 'chrome', title: 'Combat mechanics design notes', url: 'https://example.com/combat-mechanics', groupTitle: 'Game Ideas' },
      { browser: 'chrome', title: 'Watercolor forest painting process', url: 'https://www.youtube.com/watch?v=watercolor1', groupTitle: 'Art' },
      { browser: 'chrome', title: 'Color composition reference', url: 'https://example.com/color-composition', groupTitle: 'Art Ideas' },
      { browser: 'edge', title: 'TabAtlas local receiver architecture', url: 'https://github.com/example/tabatlas', groupTitle: 'Tab manager project' },
      { browser: 'chrome', title: 'Inventory UI layout breakdown', url: 'https://www.youtube.com/watch?v=inventory01', groupTitle: 'Game UI' },
      { browser: 'chrome', title: 'Dense AI paper reading list', url: 'https://www.youtube.com/watch?v=densepaper1', groupTitle: 'Research' },
      { browser: 'chrome', title: 'Top 10 AI papers you must know', url: 'https://www.youtube.com/watch?v=titleonly01', groupTitle: 'Research' },
      { browser: 'chrome', title: 'Untitled random page', url: 'https://example.com/random', groupTitle: 'Inbox' },
    ],
  }, 'semantic_eval');

  const rows = db.prepare('SELECT id, title_best FROM resources').all() as { id: string; title_best: string }[];
  const byTitle = Object.fromEntries(rows.map(row => [row.title_best, row.id]));
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: byTitle['Watercolor forest painting process'],
    tags: ['inspiration'],
    description: 'Use this for forest level moodboard in a game environment.',
    decision: 'inspiration',
    source: 'focused_review',
  });
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: byTitle['Color composition reference'],
    tags: ['inspiration', 'art'],
    description: 'Cross-domain color composition inspiration.',
    decision: 'inspiration',
    source: 'focused_review',
  });
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: byTitle['TabAtlas local receiver architecture'],
    tags: ['project_reference'],
    description: 'Tab-manager project reference for receiver architecture.',
    decision: 'project_reference',
    source: 'focused_review',
  });
  createView('view_painting');
  recordMembershipFeedback(db, {
    viewId: 'view_painting',
    targetKind: 'resource',
    targetId: byTitle['Watercolor forest painting process'],
    decision: 'reject',
    reason: 'Not a painting tutorial.',
    sourceCommandText: 'Collect painting tutorials I should follow step by step',
    sourceGoal: 'Practical painting lessons',
    sourceRules: ['Exclude inspiration-only moodboards'],
  });
  createView('view_game_ui');
  recordMembershipFeedback(db, {
    viewId: 'view_game_ui',
    targetKind: 'resource',
    targetId: byTitle['Inventory UI layout breakdown'],
    decision: 'pin_include',
    reason: 'Strong inventory UI reference.',
    sourceCommandText: 'Make a game UI inspiration board',
    sourceGoal: 'Collect game interface references',
    sourceRules: ['Include inventory UI examples'],
  });
  return {
    game: byTitle['Combat mechanics design notes'],
    watercolor: byTitle['Watercolor forest painting process'],
    art: byTitle['Color composition reference'],
    project: byTitle['TabAtlas local receiver architecture'],
    inventory: byTitle['Inventory UI layout breakdown'],
    dense: byTitle['Dense AI paper reading list'],
    titleOnly: byTitle['Top 10 AI papers you must know'],
    random: byTitle['Untitled random page'],
  };
}

function strictGameInspiration(): EvalResult {
  const brief = buildResourceBriefForIntent(db, ids.game, { commandText: 'Strict game inspiration' });
  const membership = planSemanticViewHeuristic('Strict game inspiration', [brief]).views[0].memberships[0];
  return result(
    'Strict game inspiration',
    'combat mechanics resource is strong_include using system game evidence',
    `${membership.state} / ${membership.section ?? '(none)'}`,
    membership.evidenceRefs.join(', '),
    membership.state === 'strong_include' && hasEvidenceKind(brief, membership.evidenceRefs, 'title'),
  );
}

function looseCrossDomainInspiration(): EvalResult {
  const brief = buildResourceBriefForIntent(db, ids.art, { commandText: 'Make a loose board mostly game inspiration but welcome all marked inspiration' });
  const membership = planSemanticViewHeuristic('Make a loose board mostly game inspiration but welcome all marked inspiration', [brief]).views[0].memberships[0];
  return result(
    'Loose cross-domain inspiration',
    'user-marked art inspiration is strong_include in Cross-domain inspiration',
    `${membership.state} / ${membership.section ?? '(none)'}`,
    membership.evidenceRefs.join(', '),
    membership.state === 'strong_include' && membership.section === 'Cross-domain inspiration' && membership.evidenceRefs.some(ref => ref.startsWith('user_annotation:')),
  );
}

function artInspiration(): EvalResult {
  const brief = buildResourceBriefForIntent(db, ids.art, { commandText: 'Art inspiration' });
  const membership = planSemanticViewHeuristic('Art inspiration', [brief]).views[0].memberships[0];
  return result(
    'Art inspiration',
    'color composition resource is strong_include',
    membership.state,
    membership.evidenceRefs.join(', '),
    membership.state === 'strong_include',
  );
}

function tabManagerProjectReferences(): EvalResult {
  const search = searchResources(db, {
    query: 'tab-manager project reference receiver architecture',
    filters: { annotationStatus: 'any', limit: 5 },
  });
  const first = search.matches[0];
  return result(
    'Tab-manager project references',
    'project reference annotation ranks project resource first',
    first?.resourceId ?? '(none)',
    first?.reasons.join('; ') ?? '(none)',
    first?.resourceId === ids.project && first.reasons.some(reason => reason.includes('user annotation')),
  );
}

function misleadingTitleCorrectedByUserNote(): EvalResult {
  const brief = buildResourceBriefForIntent(db, ids.watercolor, { commandText: 'Game environment inspiration' });
  const membership = planSemanticViewHeuristic('Game environment inspiration', [brief]).views[0].memberships[0];
  return result(
    'Misleading title corrected by user note',
    'watercolor title is included for game inspiration because user note says forest level moodboard',
    membership.state,
    membership.evidenceRefs.join(', '),
    membership.state === 'strong_include' && membership.evidenceRefs.some(ref => ref.startsWith('user_annotation:')),
  );
}

function paintingTutorialRejectionDoesNotAffectGameArt(): EvalResult {
  const brief = buildResourceBriefForIntent(db, ids.watercolor, { commandText: 'Game environment inspiration' });
  const membership = planSemanticViewHeuristic('Game environment inspiration', [brief]).views[0].memberships[0];
  const feedbackUsed = membership.evidenceRefs.some(ref => ref.startsWith('feedback:'));
  return result(
    'Painting-tutorial rejection that must not affect game-art inspiration',
    'painting-tutorial rejection is not used; resource remains strong_include via user note',
    `${membership.state}; feedbackUsed=${feedbackUsed}`,
    membership.evidenceRefs.join(', '),
    membership.state === 'strong_include' && !feedbackUsed,
  );
}

function relatedGameUiPinInclusion(): EvalResult {
  const brief = buildResourceBriefForIntent(db, ids.inventory, { commandText: 'Game interface reference links' });
  const membership = planSemanticViewHeuristic('Game interface reference links', [brief]).views[0].memberships[0];
  return result(
    'Related game-UI pin inclusion',
    'game UI pin is strong_include with membership_feedback evidence',
    membership.state,
    membership.evidenceRefs.join(', '),
    membership.state === 'strong_include' && membership.evidenceRefs.some(ref => ref.startsWith('feedback:')),
  );
}

function transcriptUnavailable(): EvalResult {
  const brief = buildResourceBrief(db, ids.titleOnly);
  const hasTranscriptArtifact = brief.evidence.some(evidence => evidence.kind.includes('transcript'));
  return result(
    'Transcript unavailable',
    'no transcript artifact is claimed for title-only YouTube resource',
    `transcriptArtifact=${hasTranscriptArtifact}`,
    brief.evidence.map(evidence => `${evidence.kind}:${evidence.text}`).join(' | '),
    !hasTranscriptArtifact,
  );
}

async function denseVideoTranscriptAtomicItems(): Promise<EvalResult> {
  importManualYouTubeTranscript(db, {
    resourceId: ids.dense,
    plainText: 'This dense video lists Paper Alpha, Paper Beta, and Paper Gamma with reasons to read each one.',
    language: 'en',
  });
  const brief = buildResourceBrief(db, ids.dense);
  const transcriptEvidence = brief.evidence.find(evidence => evidence.kind === 'youtube_manual_transcript');
  if (!transcriptEvidence) {
    return result('Dense video with transcript producing justified atomic items', 'manual transcript evidence exists and one atomic item persists', 'missing transcript evidence', '(none)', false);
  }
  await runFakeScan(ids.dense, transcriptEvidence.id, [{
    itemKind: 'paper',
    name: 'Paper Alpha',
    summary: 'A named paper supported by transcript text.',
    confidence: 0.82,
    evidenceRefs: [transcriptEvidence.id],
  }]);
  const count = db.prepare('SELECT COUNT(*) AS count FROM atomic_items WHERE resource_id = ?').get(ids.dense) as { count: number };
  return result(
    'Dense video with transcript producing justified atomic items',
    'one supported atomic paper item is persisted',
    `atomicItems=${count.count}`,
    transcriptEvidence.id,
    count.count === 1,
  );
}

async function titleOnlyDenseLookingNoAtomicItems(): Promise<EvalResult> {
  const before = db.prepare('SELECT COUNT(*) AS count FROM atomic_items WHERE resource_id = ?').get(ids.titleOnly) as { count: number };
  const brief = buildResourceBrief(db, ids.titleOnly);
  const titleEvidence = brief.evidence.find(evidence => evidence.kind === 'title');
  if (!titleEvidence) return result('Dense-looking title without evidence producing no detailed atomic items', 'title evidence exists', 'missing title evidence', '(none)', false);
  await runFakeScan(ids.titleOnly, titleEvidence.id, [{
    itemKind: 'paper',
    name: 'Imagined Paper',
    summary: 'Should be rejected because only the title supports it.',
    confidence: 0.82,
    evidenceRefs: [titleEvidence.id],
  }]);
  const after = db.prepare('SELECT COUNT(*) AS count FROM atomic_items WHERE resource_id = ?').get(ids.titleOnly) as { count: number };
  return result(
    'Dense-looking title without evidence producing no detailed atomic items',
    'unsupported atomic item count remains zero',
    `before=${before.count}; after=${after.count}`,
    titleEvidence.id,
    before.count === 0 && after.count === 0,
  );
}

async function runFakeScan(
  resourceId: string,
  evidenceRef: string,
  atomicItems: Array<{ itemKind: string; name: string; summary: string; confidence: number; evidenceRefs: string[] }>,
) {
  const provider: LlmProvider = {
    async complete() {
      return {
        text: JSON.stringify({
          resources: [{
            resourceId,
            summary: 'Fixture scan output.',
            contentKind: 'youtube_video',
            userPurposeGuess: 'reference',
            topics: ['papers'],
            suggestedTags: ['reference'],
            confidence: 0.75,
            evidenceRefs: [evidenceRef],
            missingEvidence: [],
            reviewReason: '',
            atomicItems,
          }],
        }),
        usage: { quotaTurns: 1 },
      };
    },
  };
  const job = createCodexScanJob(db, { resourceIds: [resourceId], force: true, limit: 1, batchSize: 1 }).job;
  await resumeCodexScanJob(db, provider, job.id, { maxItems: 1 });
}

function hasEvidenceKind(brief: ReturnType<typeof buildResourceBrief>, refs: string[], kind: string): boolean {
  const evidence = new Map(brief.evidence.map(item => [item.id, item.kind]));
  return refs.some(ref => evidence.get(ref) === kind);
}

function result(caseName: string, expected: string, actual: string, evidenceUsed: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, evidenceUsed, pass };
}

function createView(viewId: string): void {
  db.prepare(`
    INSERT INTO views (id, name, description, origin, status, created_at)
    VALUES (?, ?, '', 'semantic_eval', 'proposed', ?)
  `).run(viewId, viewId, new Date().toISOString());
}
