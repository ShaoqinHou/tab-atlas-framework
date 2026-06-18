import type Database from 'better-sqlite3';
import { z } from 'zod';
import { planSemanticViewHeuristic } from '../ai/heuristicSemanticView.js';
import { planSemanticViewHierarchical } from '../ai/hierarchicalPlanner.js';
import { buildResourceBriefsForIntent } from '../resources/briefs.js';
import type { LlmProvider, LlmUsage } from '../llm/types.js';
import { StructuredOutputError } from '../llm/runStructured.js';
import type { MembershipState, SemanticViewPlan } from '../shared/schemas.js';
import { createUserCommand, persistSemanticViewPlan, previewView, type ViewPreview } from '../views/service.js';
import { logAgentRun } from './runLog.js';
import { retrieveCandidatesForCommand } from '../retrieval/service.js';
import type { RetrievalMetrics } from '../retrieval/queryPlan.js';
import { withPromptManifestRecorder } from '../security/promptManifest.js';

export const RunAgentCommandInput = z.object({
  text: z.string().min(1),
  mode: z.enum(['heuristic', 'codex']).default('codex'),
  candidateLimit: z.number().int().positive().max(500).default(200),
  dryRun: z.boolean().default(false),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('medium'),
  seedResourceIds: z.array(z.string()).default([]),
  parentRevisionId: z.string().optional(),
});

export type RunAgentCommandInput = z.input<typeof RunAgentCommandInput>;

export interface RunAgentCommandResult {
  commandId: string | null;
  viewIds: string[];
  summary: Record<MembershipState, number>;
  message: string;
  previews: ViewPreview[];
  plan: SemanticViewPlan;
  codexTurnSpent: boolean;
  mode: 'heuristic' | 'codex';
  providerLabel: string;
  providerThreadId?: string | null;
  validationStatus: 'passed' | 'failed' | 'not_applicable';
  agentRunId?: string;
  dryRun: boolean;
  retrievalRunId: string;
  retrievalMetrics: RetrievalMetrics;
  candidateResourceIds: string[];
  usage?: LlmUsage;
  hierarchicalPlanning?: {
    mode: 'direct' | 'hierarchical';
    chunkCount: number;
    splitChunkCount: number;
    checkpointPath?: string;
  };
}

export async function runAgentCommand(
  db: Database.Database,
  providerOrMode: LlmProvider | RunAgentCommandInput['mode'] | undefined,
  input: RunAgentCommandInput,
): Promise<RunAgentCommandResult> {
  const parsed = RunAgentCommandInput.parse(input);
  const provider = typeof providerOrMode === 'object' ? providerOrMode : undefined;
  const mode = typeof providerOrMode === 'string' ? providerOrMode : parsed.mode;
  const providerLabel = mode === 'codex' ? providerLabelFor(provider) : 'heuristic';
  let providerThreadId = mode === 'codex' ? providerThreadIdFor(provider) : null;
  const query = deriveCandidateSearchQuery(parsed.text);
  const retrieval = retrieveCandidatesForCommand(db, parsed.text, {
    maxCandidates: parsed.candidateLimit,
    knownRelevantResourceIds: parsed.seedResourceIds,
  });
  const candidateResourceIds = selectCandidateResourceIds(
    retrieval.selectedResourceIds,
    parsed.seedResourceIds,
    parsed.candidateLimit,
  );
  const briefs = buildResourceBriefsForIntent(db, candidateResourceIds, {
    commandText: parsed.text,
    revisionId: parsed.parentRevisionId,
  });

  let plan: SemanticViewPlan;
  let codexTurnSpent = false;
  let agentRunId: string | undefined;
  let validationStatus: RunAgentCommandResult['validationStatus'] = mode === 'codex' ? 'failed' : 'not_applicable';
  let usage: LlmUsage | undefined;
  let hierarchicalPlanning: RunAgentCommandResult['hierarchicalPlanning'];
  if (mode === 'codex') {
    if (!provider) throw new Error('Codex mode requires an LlmProvider');
    const startedAt = new Date().toISOString();
    const inputSummary = {
      commandText: parsed.text,
      candidateCount: candidateResourceIds.length,
      candidateResourceIds,
      retrievalRunId: retrieval.runId,
      retrievalMetrics: retrieval.metrics,
      seedResourceIds: parsed.seedResourceIds,
      parentRevisionId: parsed.parentRevisionId,
      reasoningEffort: parsed.reasoningEffort,
      dryRun: parsed.dryRun,
    };
    try {
      const result = await planSemanticViewHierarchical(withPromptManifestRecorder(db, provider, 'semantic_view_plan', {
        candidateCount: candidateResourceIds.length,
        retrievalRunId: retrieval.runId,
        dryRun: parsed.dryRun,
      }), parsed.text, briefs, {
        maxViews: 4,
        allowWeakMatches: true,
        askReviewForAmbiguous: true,
      });
      plan = result.value;
      usage = result.usage;
      hierarchicalPlanning = {
        mode: result.mode,
        chunkCount: result.chunkCount,
        splitChunkCount: result.splitChunkCount,
        checkpointPath: result.checkpointPath,
      };
      providerThreadId = providerThreadIdFor(provider);
      codexTurnSpent = (result.usage.quotaTurns ?? 0) > 0;
      validationStatus = 'passed';
      agentRunId = logAgentRun(db, {
        provider: providerLabel,
        purpose: 'semantic_view_plan',
        input: inputSummary,
        output: outputSummaryForPlan(plan),
        schemaId: 'SemanticViewPlan',
        validationStatus,
        usage: result.usage,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      logAgentRun(db, {
        provider: providerLabel,
        purpose: 'semantic_view_plan',
        input: inputSummary,
        schemaId: 'SemanticViewPlan',
        validationStatus: 'error',
        error: error instanceof Error ? error.message : String(error),
        usage: error instanceof StructuredOutputError ? error.usage : undefined,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }
  } else {
    plan = planSemanticViewHeuristic(parsed.text, briefs);
  }

  if (parsed.dryRun) {
    return {
      commandId: null,
      viewIds: [],
      summary: summarizePlan(plan),
      message: messageForPlan(plan, null),
      previews: [],
      plan,
      codexTurnSpent,
      mode,
      providerLabel,
      providerThreadId,
      validationStatus,
      agentRunId,
      dryRun: true,
      retrievalRunId: retrieval.runId,
      retrievalMetrics: retrieval.metrics,
      candidateResourceIds,
      usage,
      hierarchicalPlanning,
    };
  }

  const commandId = createUserCommand(db, parsed.text, {
    mode,
    query,
    candidateResourceIds,
    retrievalRunId: retrieval.runId,
    retrievalMetrics: retrieval.metrics,
  });
  const persisted = persistSemanticViewPlan(db, commandId, plan, {
    origin: mode,
    parentRevisionId: parsed.parentRevisionId,
  });
  const previews = persisted.viewIds.map(viewId => previewView(db, viewId));
  return {
    commandId,
    viewIds: persisted.viewIds,
    summary: summarizePreviews(previews),
    message: messageForPlan(plan, previews[0] ?? null),
    previews,
    plan,
    codexTurnSpent,
    mode,
    providerLabel,
    providerThreadId,
    validationStatus,
    agentRunId,
    dryRun: false,
    retrievalRunId: retrieval.runId,
    retrievalMetrics: retrieval.metrics,
    candidateResourceIds,
    usage,
    hierarchicalPlanning,
  };
}

export function deriveCandidateSearchQuery(text: string): string {
  const stopWords = new Set([
    'a', 'an', 'and', 'as', 'but', 'by', 'for', 'from', 'group', 'include', 'into',
    'make', 'mainly', 'mostly', 'of', 'or', 'the', 'this', 'to', 'view', 'with',
  ]);
  const terms = text
    .toLowerCase()
    .replace(/[^a-z0-9_ -]+/g, ' ')
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length > 1 && !stopWords.has(term));
  return [...new Set(terms)].join(' ');
}

function selectCandidateResourceIds(retrievedIds: string[], seedResourceIds: string[], limit: number): string[] {
  return [...new Set([...seedResourceIds, ...retrievedIds])].slice(0, limit);
}

function summarizePlan(plan: SemanticViewPlan): Record<MembershipState, number> {
  const summary = emptySummary();
  for (const view of plan.views) {
    for (const membership of view.memberships) {
      summary[membership.state] += 1;
    }
  }
  return summary;
}

function outputSummaryForPlan(plan: SemanticViewPlan): unknown {
  return {
    commandText: plan.commandText,
    viewCount: plan.views.length,
    viewNames: plan.views.map(view => view.name),
    summary: summarizePlan(plan),
    reviewQueueCount: plan.reviewQueues.length,
  };
}

function providerLabelFor(provider: LlmProvider | undefined): string {
  if (!provider) return 'codex:missing-provider';
  return provider.constructor?.name ?? 'codex-provider';
}

function providerThreadIdFor(provider: LlmProvider | undefined): string | null {
  if (!provider || typeof provider !== 'object') return null;
  const candidate = provider as { threadId?: unknown };
  return typeof candidate.threadId === 'string' ? candidate.threadId : null;
}

function summarizePreviews(previews: ViewPreview[]): Record<MembershipState, number> {
  const summary = emptySummary();
  for (const preview of previews) {
    for (const [state, count] of Object.entries(preview.countsByState) as Array<[MembershipState, number]>) {
      summary[state] += count;
    }
  }
  return summary;
}

function emptySummary(): Record<MembershipState, number> {
  return {
    strong_include: 0,
    weak_include: 0,
    conflict: 0,
    exclude: 0,
    needs_review: 0,
  };
}

function messageForPlan(plan: SemanticViewPlan, preview: ViewPreview | null): string {
  const name = preview?.name ?? plan.views[0]?.name ?? 'semantic view';
  const summary = preview?.countsByState ?? summarizePlan(plan);
  return [
    `I created a proposed ${name} view.`,
    `${summary.strong_include} strong, ${summary.weak_include} weak, ${summary.conflict} conflicts, ${summary.needs_review} need review, ${summary.exclude} excluded.`,
    'Preview before accepting; no browser tabs were changed.',
  ].join(' ');
}
