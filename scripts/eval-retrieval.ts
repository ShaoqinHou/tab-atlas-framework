import { addUserAnnotation } from '../src/annotations/service.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { retrieveCandidatesForCommand } from '../src/retrieval/service.js';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

const db = openDatabase(':memory:');
const ids = seedLibrary();
const results: EvalResult[] = [];

results.push(tabManagerProjectCoverage());
results.push(looseInspirationMarkedRecall());
results.push(misleadingTitleFoundThroughNote());
results.push(atomicItemRetrievedSeparately());
results.push(largeLibraryStaysBounded());

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Retrieval evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Retrieval evaluation passed: ${results.length}/${results.length} cases.`);

function seedLibrary() {
  const tabs = [
    { browser: 'chrome', title: 'Browser extension popup pairing flow', url: 'https://example.com/extension-popup', groupTitle: 'Tab manager project' },
    { browser: 'chrome', title: 'Local receiver service architecture', url: 'https://example.com/local-receiver', groupTitle: 'Tab manager project' },
    { browser: 'chrome', title: 'SQLite schema migrations for local app', url: 'https://example.com/sqlite-migrations', groupTitle: 'Tab manager project' },
    { browser: 'chrome', title: 'Codex SDK local agent planning', url: 'https://example.com/codex-agent', groupTitle: 'Tab manager project' },
    { browser: 'chrome', title: 'Workspace UI navigation notes', url: 'https://example.com/workspace-ui', groupTitle: 'Tab manager project' },
    { browser: 'chrome', title: 'Privacy and local safety checklist', url: 'https://example.com/privacy-safety', groupTitle: 'Tab manager project' },
    { browser: 'chrome', title: 'YouTube transcript extraction pipeline', url: 'https://www.youtube.com/watch?v=transcript01', groupTitle: 'Tab manager project' },
    { browser: 'chrome', title: 'Color palette article', url: 'https://example.com/color-palette', groupTitle: 'Art inspiration' },
    { browser: 'chrome', title: 'Untitled saved page', url: 'https://example.com/misleading-note', groupTitle: 'Inbox' },
    { browser: 'chrome', title: 'Long collection video', url: 'https://www.youtube.com/watch?v=collection01', groupTitle: 'Research' },
    ...Array.from({ length: 1000 }, (_, index) => ({
      browser: 'chrome' as const,
      title: `Filler resource ${index + 1}`,
      url: `https://filler.example/resource-${index + 1}`,
      groupTitle: index % 2 === 0 ? 'Inbox' : 'Later',
    })),
  ];
  importSnapshot(db, { capturedAt: '2026-06-19T00:00:00.000Z', tabs }, 'retrieval_eval');
  const rows = db.prepare('SELECT id, title_best FROM resources').all() as Array<{ id: string; title_best: string }>;
  const byTitle = Object.fromEntries(rows.map(row => [row.title_best, row.id]));
  for (const title of [
    'Browser extension popup pairing flow',
    'Local receiver service architecture',
    'SQLite schema migrations for local app',
    'Codex SDK local agent planning',
    'Workspace UI navigation notes',
    'Privacy and local safety checklist',
    'YouTube transcript extraction pipeline',
  ]) {
    addUserAnnotation(db, {
      targetKind: 'resource',
      targetId: byTitle[title],
      tags: ['project_reference', 'tab-manager'],
      description: `${title} reference for the tab-manager workspace.`,
      decision: 'project_reference',
      source: 'focused_review',
    });
  }
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: byTitle['Color palette article'],
    tags: ['inspiration', 'art'],
    description: 'Cross-domain inspiration marked by the user.',
    decision: 'inspiration',
    source: 'focused_review',
  });
  addUserAnnotation(db, {
    targetKind: 'resource',
    targetId: byTitle['Untitled saved page'],
    tags: ['project_reference'],
    description: 'Important receiver recovery UX note despite the misleading title.',
    decision: 'project_reference',
    source: 'focused_review',
  });
  db.prepare(`
    INSERT INTO extraction_artifacts
      (id, resource_id, recipe_id, artifact_kind, text_excerpt, json_payload, source_url, provenance, confidence, status, extracted_at)
    VALUES
      ('art_codex_scan_ui', ?, 'codex_resource_analysis.v1', 'codex_resource_analysis', 'Workspace UI navigation and privacy controls.', '{}', '', 'codex', 0.8, 'complete', ?)
  `).run(byTitle['Workspace UI navigation notes'], new Date().toISOString());
  db.prepare(`
    INSERT INTO atomic_items (id, resource_id, item_kind, name, summary, evidence_refs, confidence, created_by, created_at)
    VALUES ('item_collection_tool', ?, 'tool', 'Agentic paper collection tool', 'A tool mentioned inside the collection video.', '[]', 0.8, 'codex_scan', ?)
  `).run(byTitle['Long collection video'], new Date().toISOString());
  return {
    project: [
      byTitle['Browser extension popup pairing flow'],
      byTitle['Local receiver service architecture'],
      byTitle['SQLite schema migrations for local app'],
      byTitle['Codex SDK local agent planning'],
      byTitle['Workspace UI navigation notes'],
      byTitle['Privacy and local safety checklist'],
      byTitle['YouTube transcript extraction pipeline'],
    ],
    inspiration: byTitle['Color palette article'],
    misleading: byTitle['Untitled saved page'],
    collection: byTitle['Long collection video'],
  };
}

function tabManagerProjectCoverage(): EvalResult {
  const retrieval = retrieveCandidatesForCommand(db, 'Make a project group for the tab-manager app covering extension receiver SQLite Codex UI privacy YouTube transcript', {
    maxCandidates: 200,
    knownRelevantResourceIds: ids.project,
  });
  const top20 = new Set(retrieval.candidates.slice(0, 20).map(candidate => candidate.resourceId));
  const hits = ids.project.filter(id => top20.has(id));
  return result(
    'Tab-manager project query coverage',
    'all seven known project resources appear in top 20 with multi-source coverage',
    `hits=${hits.length}/7; candidates=${retrieval.metrics.candidateCount}; sources=${Object.keys(retrieval.metrics.sourceCoverage).join(',')}`,
    hits.length === ids.project.length
      && retrieval.metrics.candidateCount <= 200
      && Object.keys(retrieval.metrics.sourceCoverage).length >= 4,
  );
}

function looseInspirationMarkedRecall(): EvalResult {
  const retrieval = retrieveCandidatesForCommand(db, 'Make a loose inspiration board mainly game inspiration but include anything I marked inspiration', {
    maxCandidates: 100,
    knownRelevantResourceIds: [ids.inspiration],
  });
  return result(
    'Loose inspiration marked recall',
    'cross-domain user-marked inspiration is selected',
    `selected=${retrieval.selectedResourceIds.includes(ids.inspiration)}; recall=${retrieval.metrics.userMarkedRecall}`,
    retrieval.selectedResourceIds.includes(ids.inspiration),
  );
}

function misleadingTitleFoundThroughNote(): EvalResult {
  const retrieval = retrieveCandidatesForCommand(db, 'Find receiver recovery UX references', {
    maxCandidates: 100,
    knownRelevantResourceIds: [ids.misleading],
  });
  return result(
    'Misleading title through note',
    'resource with irrelevant title is found through user note',
    `selected=${retrieval.selectedResourceIds.includes(ids.misleading)}; knownRecall=${retrieval.metrics.knownRelevantRecall}`,
    retrieval.selectedResourceIds.includes(ids.misleading),
  );
}

function atomicItemRetrievedSeparately(): EvalResult {
  const retrieval = retrieveCandidatesForCommand(db, 'Show AI papers and tools inside collection videos, not only parent videos', {
    maxCandidates: 100,
    knownRelevantResourceIds: [ids.collection],
  });
  const atomic = retrieval.candidates.find(candidate => candidate.targetKind === 'atomic_item' && candidate.resourceId === ids.collection);
  return result(
    'Atomic item retrieval',
    'atomic tool item is retrieved separately from parent video',
    `atomic=${atomic?.targetId ?? '(missing)'}; selectedParent=${retrieval.selectedResourceIds.includes(ids.collection)}`,
    Boolean(atomic) && retrieval.selectedResourceIds.includes(ids.collection),
  );
}

function largeLibraryStaysBounded(): EvalResult {
  const retrieval = retrieveCandidatesForCommand(db, 'Find links I probably opened for later but never marked', { maxCandidates: 120 });
  return result(
    '1000-resource fixture stays bounded',
    'candidate and selected counts stay within configured caps',
    `candidates=${retrieval.candidates.length}; selected=${retrieval.selectedResourceIds.length}`,
    retrieval.candidates.length <= 120 && retrieval.selectedResourceIds.length <= 120,
  );
}

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}
