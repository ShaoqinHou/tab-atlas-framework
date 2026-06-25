import { runAgentCommand } from '../src/agent/commandService.js';
import { openDatabase } from '../src/db/index.js';
import { createCodexProviderRegistry } from '../src/llm/providerScope.js';
import type { LlmUsage } from '../src/llm/types.js';
import { PROMPT_REDACTION_VERSION } from '../src/security/urlPrivacy.js';

export const privateLibraryCommands = [
  { commandId: 'tab-manager-project', description: 'tab-manager project group', text: 'Make a project group for the tab-manager app.' },
  { commandId: 'loose-inspiration', description: 'loose inspiration board', text: 'Make a loose inspiration board, mainly game inspiration, but include anything I marked as inspiration.' },
  { commandId: 'collection-video-items', description: 'AI papers and tools inside collection videos', text: 'Show AI papers and tools inside collection videos, not only parent videos.' },
  { commandId: 'opened-later-unmarked', description: 'probably opened for later but never marked', text: 'Find links I probably opened for later but never marked.' },
];

export type PrivateLibraryMode = 'codex' | 'heuristic';

export type CommandSmoke = {
  commandId: string;
  description: string;
  status: 'passed' | 'failed' | 'timeout' | 'skipped';
  mode: PrivateLibraryMode;
  durationMs: number;
  candidateCount: number;
  selectedCount: number;
  retrievalSourceCoverage: Record<string, number>;
  retrievalRunId?: string;
  promptManifestIds: string[];
  agentRunId?: string;
  providerRole?: string;
  providerScope?: string;
  providerModel?: string;
  providerReasoningEffort?: string;
  providerThreadId?: string | null;
  usage?: LlmUsage;
  hierarchicalPlanning?: {
    mode: 'direct' | 'hierarchical';
    chunkCount: number;
    splitChunkCount: number;
    failedChunkCount: number;
    runId?: string;
    evidenceFingerprint?: string;
  };
  codexTurns: number;
  strongIncludeCount: number;
  weakIncludeCount: number;
  conflictCount: number;
  needsReviewCount: number;
  evidenceReasonCategories: string[];
  usedUserNotes: boolean;
  usedCodexScanEvidence: boolean;
  usedAtomicItems: boolean;
  promptRedactionOk: boolean;
  error?: string;
};

export async function runPrivateLibraryCommand(commandId: string, mode: PrivateLibraryMode): Promise<CommandSmoke> {
  const command = privateLibraryCommands.find(item => item.commandId === commandId);
  if (!command) throw new Error(`Unknown command id: ${commandId}`);
  if (!process.env.TABATLAS_DB) throw new Error('TABATLAS_DB is required for private library acceptance.');
  const db = openDatabase(process.env.TABATLAS_DB);
  const registry = createCodexProviderRegistry(db, { workingDirectory: process.cwd() });
  const started = Date.now();
  const providerScope = `private-acceptance:${command.commandId}`;
  const promptStartedAt = new Date(Date.now() - 1).toISOString();
  try {
    const result = await runAgentCommand(
      db,
      mode === 'codex'
        ? registry.getProvider({ role: 'semantic_planner', scopeKey: providerScope, reuseThread: false })
        : 'heuristic',
      {
        text: command.text,
        mode,
        candidateLimit: Number(process.env.TABATLAS_ACCEPTANCE_CANDIDATE_LIMIT ?? 200),
        dryRun: true,
        reasoningEffort: 'medium',
      },
    );
    const promptManifestIds = promptManifestsForScope(db, providerScope, promptStartedAt);
    return {
      commandId: command.commandId,
      description: command.description,
      status: 'passed',
      mode,
      durationMs: Date.now() - started,
      candidateCount: result.retrievalMetrics.candidateCount,
      selectedCount: result.retrievalMetrics.selectedCount,
      retrievalSourceCoverage: normalizeCoverage(result.retrievalMetrics.sourceCoverage),
      retrievalRunId: result.retrievalRunId,
      promptManifestIds,
      agentRunId: result.agentRunId,
      providerRole: result.providerRole,
      providerScope: result.providerScope ?? providerScope,
      providerModel: result.providerModel,
      providerReasoningEffort: result.providerReasoningEffort,
      providerThreadId: result.providerThreadId,
      usage: result.usage,
      hierarchicalPlanning: result.hierarchicalPlanning,
      codexTurns: mode === 'codex' ? result.usage?.quotaTurns ?? 0 : 0,
      strongIncludeCount: result.summary.strong_include,
      weakIncludeCount: result.summary.weak_include,
      conflictCount: result.summary.conflict,
      needsReviewCount: result.summary.needs_review,
      evidenceReasonCategories: evidenceCategories(result.plan),
      usedUserNotes: JSON.stringify(result.plan).includes('user_annotation:'),
      usedCodexScanEvidence: JSON.stringify(result.retrievalMetrics.sourceCoverage).includes('codex_scan'),
      usedAtomicItems: JSON.stringify(result.plan).includes('"targetKind":"atomic_item"') || result.retrievalMetrics.atomicItemRecall > 0,
      promptRedactionOk: promptRedactionOk(db, promptManifestIds, mode),
    };
  } finally {
    db.close();
  }
}

export function failedSmoke(
  commandId: string,
  mode: PrivateLibraryMode,
  status: 'failed' | 'timeout',
  durationMs: number,
  error: string,
): CommandSmoke {
  const command = privateLibraryCommands.find(item => item.commandId === commandId);
  return {
    commandId,
    description: command?.description ?? commandId,
    status,
    mode,
    durationMs,
    candidateCount: 0,
    selectedCount: 0,
    retrievalSourceCoverage: {},
    promptManifestIds: [],
    providerRole: 'semantic_planner',
    providerScope: `private-acceptance:${commandId}`,
    providerModel: 'unknown',
    providerReasoningEffort: 'medium',
    codexTurns: 0,
    strongIncludeCount: 0,
    weakIncludeCount: 0,
    conflictCount: 0,
    needsReviewCount: 0,
    evidenceReasonCategories: [],
    usedUserNotes: false,
    usedCodexScanEvidence: false,
    usedAtomicItems: false,
    promptRedactionOk: false,
    error,
  };
}

function promptManifestsForScope(dbHandle: ReturnType<typeof openDatabase>, providerScope: string, startedAt: string): string[] {
  const rows = dbHandle.prepare(`
    SELECT id
    FROM codex_prompt_manifests
    WHERE provider_scope_key = ?
      AND created_at >= ?
    ORDER BY created_at ASC
  `).all(providerScope, startedAt) as Array<{ id: string }>;
  return rows.map(row => row.id);
}

function promptRedactionOk(dbHandle: ReturnType<typeof openDatabase>, ids: string[], mode: PrivateLibraryMode): boolean {
  if (mode === 'heuristic') return ids.length === 0;
  if (ids.length === 0) return false;
  const rows = dbHandle.prepare(`
    SELECT prompt_hash, redaction_version, metadata_json
    FROM codex_prompt_manifests
    WHERE id IN (${ids.map(() => '?').join(',')})
  `).all(...ids) as Array<{ prompt_hash: string; redaction_version: string; metadata_json: string }>;
  if (rows.length !== ids.length) return false;
  return rows.every(row => {
    if (!/^[a-f0-9]{64}$/.test(row.prompt_hash)) return false;
    if (row.redaction_version !== PROMPT_REDACTION_VERSION) return false;
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    return !('prompt' in metadata) && !('rawPrompt' in metadata) && !('resourceText' in metadata);
  });
}

function normalizeCoverage(value: Partial<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).map(([key, count]) => [key, count ?? 0]));
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
