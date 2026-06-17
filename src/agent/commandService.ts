import type Database from 'better-sqlite3';
import { z } from 'zod';
import { planSemanticViewHeuristic } from '../ai/heuristicSemanticView.js';
import { planSemanticView } from '../ai/planSemanticView.js';
import { buildResourceBriefs } from '../resources/briefs.js';
import type { LlmProvider } from '../llm/types.js';
import type { MembershipState, SemanticViewPlan } from '../shared/schemas.js';
import { createUserCommand, persistSemanticViewPlan, previewView, type ViewPreview } from '../views/service.js';
import { searchResources } from './tools.js';

export const RunAgentCommandInput = z.object({
  text: z.string().min(1),
  mode: z.enum(['heuristic', 'codex']).default('heuristic'),
  candidateLimit: z.number().int().positive().max(500).default(80),
  dryRun: z.boolean().default(false),
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
  dryRun: boolean;
}

export async function runAgentCommand(
  db: Database.Database,
  providerOrMode: LlmProvider | RunAgentCommandInput['mode'] | undefined,
  input: RunAgentCommandInput,
): Promise<RunAgentCommandResult> {
  const parsed = RunAgentCommandInput.parse(input);
  const provider = typeof providerOrMode === 'object' ? providerOrMode : undefined;
  const mode = typeof providerOrMode === 'string' ? providerOrMode : parsed.mode;
  const query = deriveCandidateSearchQuery(parsed.text);
  const matches = searchResources(db, {
    query,
    filters: { annotationStatus: 'any', limit: parsed.candidateLimit },
  }).matches;
  const candidateResourceIds = matches.length
    ? matches.map(match => match.resourceId)
    : getRecentResourceIds(db, parsed.candidateLimit);
  const briefs = buildResourceBriefs(db, candidateResourceIds);

  let plan: SemanticViewPlan;
  let codexTurnSpent = false;
  if (mode === 'codex') {
    if (!provider) throw new Error('Codex mode requires an LlmProvider');
    const result = await planSemanticView(provider, parsed.text, briefs, {
      maxViews: 4,
      allowWeakMatches: true,
      askReviewForAmbiguous: true,
    });
    plan = result.value;
    codexTurnSpent = (result.usage.quotaTurns ?? 0) > 0;
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
      dryRun: true,
    };
  }

  const commandId = createUserCommand(db, parsed.text, { mode, query, candidateResourceIds });
  const persisted = persistSemanticViewPlan(db, commandId, plan, mode);
  const previews = persisted.viewIds.map(viewId => previewView(db, viewId));
  return {
    commandId,
    viewIds: persisted.viewIds,
    summary: summarizePreviews(previews),
    message: messageForPlan(plan, previews[0] ?? null),
    previews,
    plan,
    codexTurnSpent,
    dryRun: false,
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

function summarizePlan(plan: SemanticViewPlan): Record<MembershipState, number> {
  const summary = emptySummary();
  for (const view of plan.views) {
    for (const membership of view.memberships) {
      summary[membership.state] += 1;
    }
  }
  return summary;
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

function getRecentResourceIds(db: Database.Database, limit: number): string[] {
  const rows = db.prepare(`
    SELECT id
    FROM resources
    ORDER BY last_seen_at DESC
    LIMIT ?
  `).all(limit) as { id: string }[];
  return rows.map(row => row.id);
}
