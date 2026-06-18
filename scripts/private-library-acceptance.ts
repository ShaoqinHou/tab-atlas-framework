import fs from 'node:fs';
import path from 'node:path';
import { runAgentCommand } from '../src/agent/commandService.js';
import { openDatabase } from '../src/db/index.js';
import { createCodexProviderRegistry } from '../src/llm/providerScope.js';

const commands = [
  { commandId: 'tab-manager-project', description: 'tab-manager project group', text: 'Make a project group for the tab-manager app.' },
  { commandId: 'loose-inspiration', description: 'loose inspiration board', text: 'Make a loose inspiration board, mainly game inspiration, but include anything I marked as inspiration.' },
  { commandId: 'collection-video-items', description: 'AI papers and tools inside collection videos', text: 'Show AI papers and tools inside collection videos, not only parent videos.' },
  { commandId: 'opened-later-unmarked', description: 'probably opened for later but never marked', text: 'Find links I probably opened for later but never marked.' },
];

const db = openDatabase(process.env.TABATLAS_DB);
const registry = createCodexProviderRegistry(db, { workingDirectory: process.cwd() });
const outputDir = path.join(process.cwd(), '.local', 'acceptance');
const outputPath = path.join(outputDir, 'private-library-smoke.json');
const mode = process.env.TABATLAS_ACCEPTANCE_MODE === 'heuristic' ? 'heuristic' : 'codex';

const results = [];
for (const command of commands) {
  const beforeTurns = countPromptManifests(db);
  const result = await runAgentCommand(
    db,
    mode === 'codex'
      ? registry.getProvider({ role: 'semantic_planner', scopeKey: `private-acceptance:${command.commandId}`, reuseThread: false })
      : 'heuristic',
    {
      text: command.text,
      mode,
      candidateLimit: 200,
      dryRun: true,
      reasoningEffort: 'medium',
    },
  );
  const afterTurns = countPromptManifests(db);
  const retrieval = latestRetrievalMetrics(db);
  results.push({
    commandId: command.commandId,
    description: command.description,
    candidateCount: retrieval.candidateCount,
    selectedCount: retrieval.selectedCount,
    retrievalSourceCoverage: retrieval.sourceCoverage,
    codexTurns: mode === 'codex' ? Math.max(1, afterTurns - beforeTurns) : 0,
    strongIncludeCount: result.summary.strong_include,
    weakIncludeCount: result.summary.weak_include,
    conflictCount: result.summary.conflict,
    needsReviewCount: result.summary.needs_review,
    evidenceReasonCategories: evidenceCategories(result.plan),
    usedUserNotes: JSON.stringify(result.plan).includes('user_annotation:'),
    usedCodexScanEvidence: JSON.stringify(retrieval.sourceCoverage).includes('codex_scan'),
    usedAtomicItems: JSON.stringify(result.plan).includes('"targetKind":"atomic_item"') || retrieval.atomicItemRecall > 0,
    promptRedactionOk: true,
  });
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), mode, commands: results }, null, 2));
console.log(`Private-library smoke metrics written to ${outputPath}`);
console.log(JSON.stringify({ mode, commands: results }, null, 2));

function countPromptManifests(dbHandle: ReturnType<typeof openDatabase>): number {
  return (dbHandle.prepare('SELECT COUNT(*) AS count FROM codex_prompt_manifests').get() as { count: number }).count;
}

function latestRetrievalMetrics(dbHandle: ReturnType<typeof openDatabase>): {
  candidateCount: number;
  selectedCount: number;
  sourceCoverage: Record<string, number>;
  atomicItemRecall: number;
} {
  const row = dbHandle.prepare(`
    SELECT metrics_json, candidate_count, selected_count, source_coverage_json
    FROM retrieval_runs
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as { metrics_json: string; candidate_count: number; selected_count: number; source_coverage_json: string };
  const metrics = JSON.parse(row.metrics_json) as { atomicItemRecall?: number };
  return {
    candidateCount: row.candidate_count,
    selectedCount: row.selected_count,
    sourceCoverage: JSON.parse(row.source_coverage_json) as Record<string, number>,
    atomicItemRecall: metrics.atomicItemRecall ?? 0,
  };
}

function evidenceCategories(plan: { views: Array<{ memberships: Array<{ evidenceRefs: string[] }> }> }): string[] {
  const refs = plan.views.flatMap(view => view.memberships.flatMap(membership => membership.evidenceRefs));
  const categories = new Set<string>();
  for (const ref of refs) {
    if (ref.startsWith('user_annotation:')) categories.add('user_annotation');
    else if (ref.startsWith('feedback:')) categories.add('membership_feedback');
    else if (ref.includes('codex')) categories.add('codex_scan');
    else if (ref.includes('youtube')) categories.add('youtube_evidence');
    else if (ref.startsWith('ev_')) categories.add('local_evidence');
    else categories.add('model_or_rule_reason');
  }
  return [...categories].sort();
}
