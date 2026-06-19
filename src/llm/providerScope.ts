import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CodexSdkProvider, type CodexSdkProviderConfig } from './CodexSdkProvider.js';
import type { LlmProvider, LlmResult, LlmTurnOptions } from './types.js';

export type CodexProviderRole =
  | 'conversation_planner'
  | 'semantic_planner'
  | 'resource_scan'
  | 'semantic_eval'
  | 'one_shot';

export type ReasoningEffort = NonNullable<CodexSdkProviderConfig['reasoningEffort']>;

export interface ScopedProviderRequest {
  role: CodexProviderRole;
  scopeKey: string;
  ownerKey?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reuseThread?: boolean;
}

export interface ProviderFactoryConfig {
  role: CodexProviderRole;
  scopeKey: string;
  ownerKey: string;
  model: string;
  generation: number;
  reasoningEffort: ReasoningEffort;
  reuseThread: boolean;
}

export type ProviderFactory = (config: ProviderFactoryConfig) => LlmProvider;

export interface ScopedProviderRegistryOptions {
  maxTurnsPerThread?: number;
  providerFactory: ProviderFactory;
}

type ProviderThreadRow = {
  id: string;
  role: CodexProviderRole;
  scope_key: string;
  owner_key: string;
  model: string;
  reasoning_effort: ReasoningEffort;
  generation: number;
  thread_id: string | null;
  turn_count: number;
};

export class ScopedLlmProvider implements LlmProvider {
  constructor(
    private readonly db: Database.Database,
    private readonly rowId: string,
    private readonly delegate: LlmProvider,
    readonly role: CodexProviderRole,
    readonly scopeKey: string,
    readonly ownerKey: string,
    readonly model: string,
    readonly reasoningEffort: ReasoningEffort,
    readonly generation: number,
  ) {}

  get threadId(): string | null {
    return providerThreadIdFor(this.delegate);
  }

  async complete(prompt: string, opts?: LlmTurnOptions): Promise<LlmResult> {
    const result = await this.delegate.complete(prompt, opts);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE codex_provider_threads
      SET thread_id = COALESCE(?, thread_id),
          turn_count = turn_count + ?,
          updated_at = ?
      WHERE id = ?
    `).run(this.threadId, Math.max(1, result.usage.quotaTurns ?? 1), now, this.rowId);
    return result;
  }
}

export class ScopedProviderRegistry {
  private readonly providers = new Map<string, ScopedLlmProvider>();
  private readonly maxTurnsPerThread: number;

  constructor(
    private readonly db: Database.Database,
    private readonly options: ScopedProviderRegistryOptions,
  ) {
    this.maxTurnsPerThread = Math.max(1, options.maxTurnsPerThread ?? 20);
  }

  getProvider(request: ScopedProviderRequest): ScopedLlmProvider {
    const reasoningEffort = request.reasoningEffort ?? 'medium';
    const ownerKey = request.ownerKey ?? 'local';
    const model = request.model ?? 'gpt-5.5';
    const reuseThread = request.reuseThread !== false;
    const row = reuseThread
      ? this.currentReusableRow(request.role, request.scopeKey, ownerKey, model, reasoningEffort)
      : this.createNextGenerationRow(request.role, request.scopeKey, ownerKey, model, reasoningEffort);
    const cacheKey = row.id;
    const cached = reuseThread ? this.providers.get(cacheKey) : undefined;
    if (cached) return cached;

    const provider = new ScopedLlmProvider(
      this.db,
      row.id,
      this.options.providerFactory({
        role: request.role,
        scopeKey: request.scopeKey,
        ownerKey,
        model,
        generation: row.generation,
        reasoningEffort,
        reuseThread,
      }),
      request.role,
      request.scopeKey,
      ownerKey,
      model,
      reasoningEffort,
      row.generation,
    );
    if (reuseThread) this.providers.set(cacheKey, provider);
    return provider;
  }

  private currentReusableRow(
    role: CodexProviderRole,
    scopeKey: string,
    ownerKey: string,
    model: string,
    reasoningEffort: ReasoningEffort,
  ): ProviderThreadRow {
    const current = this.latestRow(role, scopeKey, ownerKey, model, reasoningEffort);
    if (!current) return this.createGenerationRow(role, scopeKey, ownerKey, model, reasoningEffort, this.nextGeneration(role, scopeKey));
    if (current.turn_count >= this.maxTurnsPerThread) {
      return this.createGenerationRow(role, scopeKey, ownerKey, model, reasoningEffort, this.nextGeneration(role, scopeKey));
    }
    return current;
  }

  private createNextGenerationRow(
    role: CodexProviderRole,
    scopeKey: string,
    ownerKey: string,
    model: string,
    reasoningEffort: ReasoningEffort,
  ): ProviderThreadRow {
    return this.createGenerationRow(role, scopeKey, ownerKey, model, reasoningEffort, this.nextGeneration(role, scopeKey));
  }

  private latestRow(
    role: CodexProviderRole,
    scopeKey: string,
    ownerKey: string,
    model: string,
    reasoningEffort: ReasoningEffort,
  ): ProviderThreadRow | undefined {
    return this.db.prepare(`
      SELECT id, role, scope_key, owner_key, model, reasoning_effort, generation, thread_id, turn_count
      FROM codex_provider_threads
      WHERE role = ? AND scope_key = ? AND owner_key = ? AND model = ? AND reasoning_effort = ?
      ORDER BY generation DESC
      LIMIT 1
    `).get(role, scopeKey, ownerKey, model, reasoningEffort) as ProviderThreadRow | undefined;
  }

  private nextGeneration(role: CodexProviderRole, scopeKey: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(generation), 0) AS generation
      FROM codex_provider_threads
      WHERE role = ? AND scope_key = ?
    `).get(role, scopeKey) as { generation: number };
    return row.generation + 1;
  }

  private createGenerationRow(
    role: CodexProviderRole,
    scopeKey: string,
    ownerKey: string,
    model: string,
    reasoningEffort: ReasoningEffort,
    generation: number,
  ): ProviderThreadRow {
    const now = new Date().toISOString();
    const id = `provider_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO codex_provider_threads
        (id, role, scope_key, owner_key, model, reasoning_effort, generation, thread_id, turn_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
    `).run(id, role, scopeKey, ownerKey, model, reasoningEffort, generation, now, now);
    return {
      id,
      role,
      scope_key: scopeKey,
      owner_key: ownerKey,
      model,
      reasoning_effort: reasoningEffort,
      generation,
      thread_id: null,
      turn_count: 0,
    };
  }
}

export function createCodexProviderRegistry(
  db: Database.Database,
  options: { maxTurnsPerThread?: number; workingDirectory?: string } = {},
): ScopedProviderRegistry {
  return new ScopedProviderRegistry(db, {
    maxTurnsPerThread: options.maxTurnsPerThread,
    providerFactory: config => process.env.TABATLAS_FAKE_CODEX_PROVIDER === 'workspace_ux'
      ? new WorkspaceUxFakeProvider(config)
      : new CodexSdkProvider({
        reasoningEffort: config.reasoningEffort,
        reuseThread: config.reuseThread,
        workingDirectory: options.workingDirectory,
      }),
  });
}

function providerThreadIdFor(provider: LlmProvider): string | null {
  const candidate = provider as { threadId?: unknown };
  return typeof candidate.threadId === 'string' ? candidate.threadId : null;
}

type PromptResource = {
  resourceId: string;
  host?: string;
  title?: string;
  urlKind?: string;
  browserGroupTitles?: string[];
  userAnnotations?: Array<{ id?: string; tags?: string[]; description?: string; decision?: string }>;
  atomicItems?: Array<{ itemId: string; itemKind?: string; name?: string; summary?: string; evidenceRefs?: string[]; confidence?: number }>;
  evidence?: Array<{ id: string; kind?: string; text?: string; provenance?: string; confidence?: number }>;
};

type ChunkDecision = {
  targetKind: 'resource' | 'atomic_item';
  targetId: string;
  state: 'strong_include' | 'weak_include' | 'conflict' | 'exclude' | 'needs_review';
  confidence: number;
  reason: string;
  evidenceRefs: string[];
};

class WorkspaceUxFakeProvider implements LlmProvider {
  readonly threadId: string;

  constructor(private readonly config: ProviderFactoryConfig) {
    this.threadId = `fake_thread_${config.role}_${config.generation}`;
  }

  async complete(prompt: string): Promise<LlmResult> {
    const text = JSON.stringify(this.responseFor(prompt));
    return {
      text,
      usage: {
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(text.length / 4),
        quotaTurns: 0,
      },
    };
  }

  private responseFor(prompt: string): unknown {
    if (this.config.role === 'conversation_planner' || prompt.includes('AgentTurnPlan')) {
      return this.conversationPlan(prompt);
    }
    if (prompt.includes('Return only SemanticChunkResult JSON')) {
      return this.chunkResult(prompt);
    }
    return this.semanticPlan(prompt);
  }

  private conversationPlan(prompt: string): unknown {
    const latest = latestConversationUserText(prompt);
    const lower = latest.toLowerCase();
    if (lower.includes('review')) {
      return {
        reply: 'I will open a focused review queue for the uncertain items.',
        actions: [{
          id: 'start_review',
          kind: 'start_review',
          approval: 'automatic',
          queue: lower.includes('conflict') ? 'conflict' : lower.includes('weak') || lower.includes('uncertain') ? 'weak' : 'unmarked',
          rationale: 'Focused review is the fastest way to process uncertain local resources.',
        }],
        questions: [],
        assumptions: [],
      };
    }
    const commandText = latest || 'Build a local visual workspace from the current tab library.';
    return {
      reply: 'I will preview that workspace using the local tab library.',
      actions: [{
        id: 'plan_view',
        kind: 'plan_view',
        approval: 'preview',
        commandText,
        candidateLimit: 40,
        rationale: 'A preview lets you inspect and correct the proposed workspace before accepting it.',
      }],
      questions: [],
      assumptions: ['Using local titles, tab groups, user annotations, extracted summaries, and atomic items only.'],
    };
  }

  private chunkResult(prompt: string): unknown {
    const commandText = commandTextFromPrompt(prompt);
    const chunkId = textAfterLabel(prompt, 'Chunk ID:') || 'semantic_chunk_workspace_ux';
    const resources = resourcesFromPrompt(prompt);
    const decisions = decisionsFor(commandText, resources).slice(0, 80);
    const decided = new Set(decisions.map(decision => decision.targetId));
    return {
      commandText,
      chunkId,
      decisions,
      unresolvedTargets: targetIdsFromResources(resources).filter(targetId => !decided.has(targetId)),
      notes: ['Deterministic workspace UX fake provider chunk result.'],
    };
  }

  private semanticPlan(prompt: string): unknown {
    const commandText = commandTextFromPrompt(prompt);
    const resources = resourcesFromPrompt(prompt);
    const decisions = decisionsFor(commandText, resources);
    const lower = commandText.toLowerCase();
    const sections = lower.includes('project') || lower.includes('tab-manager')
      ? ['Architecture', 'Extraction', 'UX', 'Safety', 'Packaging']
      : ['Game inspiration', 'Visual references', 'Personal inspiration', 'Cross-domain references'];
    return {
      commandText,
      views: [{
        name: lower.includes('project') || lower.includes('tab-manager')
          ? 'Tab manager project workspace'
          : 'Loose inspiration board',
        description: 'Deterministic workspace UX role-play view from local resources.',
        goal: commandText,
        inclusionRules: [
          'Prioritize resources that match the requested purpose.',
          'Keep user annotations ahead of generated evidence.',
          'Surface ambiguous matches for review instead of hiding them.',
        ],
        exclusionRules: ['Exclude clearly unrelated archive or database references from the main board.'],
        sections,
        sortPolicy: 'Group by purpose, then confidence and user evidence.',
        confidence: 0.86,
        memberships: decisions,
      }],
      reviewQueues: [{
        queueName: 'uncertain',
        reason: 'Weak, conflicting, and needs-review memberships should be checked by the user.',
        targetIds: decisions
          .filter(decision => decision.targetKind === 'resource' && ['weak_include', 'conflict', 'needs_review'].includes(decision.state))
          .slice(0, 40)
          .map(decision => decision.targetId),
      }],
      explanation: 'Deterministic fake Codex response for the workspace UX role-play gate.',
    };
  }
}

function latestConversationUserText(prompt: string): string {
  const history = jsonBetweenLabels(prompt, 'Conversation history:', 'Retrieved local context:');
  if (Array.isArray(history)) {
    const latest = [...history].reverse().find((message): message is { role: string; content: string } => {
      return isRecord(message) && message.role === 'user' && typeof message.content === 'string';
    });
    if (latest) return latest.content;
  }
  const contentMatches = [...prompt.matchAll(/"role"\s*:\s*"user"[\s\S]*?"content"\s*:\s*"((?:\\.|[^"])*)"/g)];
  const last = contentMatches.at(-1)?.[1];
  return last ? unescapeJsonString(last) : '';
}

function commandTextFromPrompt(prompt: string): string {
  const fromLine = textAfterLabel(prompt, 'Command:');
  if (fromLine) return fromLine;
  const mergeInput = jsonFromLastObject(prompt);
  if (isRecord(mergeInput) && typeof mergeInput.commandText === 'string') return mergeInput.commandText;
  return 'Build a local TabAtlas workspace.';
}

function resourcesFromPrompt(prompt: string): PromptResource[] {
  for (const value of jsonObjectsFromText(prompt)) {
    if (isRecord(value) && Array.isArray(value.resources)) {
      return value.resources.filter(isPromptResource);
    }
    if (isRecord(value) && Array.isArray(value.chunkResults)) {
      return resourcesFromChunkResults(value.chunkResults);
    }
  }
  return [];
}

function resourcesFromChunkResults(chunkResults: unknown[]): PromptResource[] {
  const resources = new Map<string, PromptResource>();
  for (const chunk of chunkResults) {
    if (!isRecord(chunk) || !Array.isArray(chunk.decisions)) continue;
    for (const decision of chunk.decisions) {
      if (!isRecord(decision) || typeof decision.targetId !== 'string') continue;
      if (decision.targetKind === 'resource') {
        resources.set(decision.targetId, {
          resourceId: decision.targetId,
          title: decision.targetId,
          evidence: [{ id: `planner:${decision.targetId}` }],
        });
      }
    }
  }
  return [...resources.values()];
}

function decisionsFor(commandText: string, resources: PromptResource[]): ChunkDecision[] {
  const lowerCommand = commandText.toLowerCase();
  const includeProject = lowerCommand.includes('project') || lowerCommand.includes('tab-manager');
  const decisions: ChunkDecision[] = [];
  for (const [index, resource] of resources.entries()) {
    const haystack = [
      resource.title,
      resource.host,
      resource.urlKind,
      ...(resource.browserGroupTitles ?? []),
      ...(resource.userAnnotations ?? []).flatMap(annotation => [
        annotation.decision,
        annotation.description,
        ...(annotation.tags ?? []),
      ]),
    ].filter(Boolean).join(' ').toLowerCase();
    const hasUserSignal = (resource.userAnnotations ?? []).length > 0;
    const state = haystack.includes('conflict') || haystack.includes('questionable')
      ? 'conflict'
      : haystack.includes('archive database') || haystack.includes('unrelated')
        ? 'exclude'
        : index % 11 === 0
          ? 'needs_review'
          : index % 7 === 0
            ? 'weak_include'
            : 'strong_include';
    const section = includeProject ? projectSectionFor(haystack, index) : inspirationSectionFor(haystack, hasUserSignal);
    decisions.push({
      targetKind: 'resource',
      targetId: resource.resourceId,
      section,
      state,
      confidence: state === 'strong_include' ? 0.88 : state === 'weak_include' ? 0.57 : state === 'conflict' ? 0.62 : state === 'needs_review' ? 0.46 : 0.79,
      reason: reasonFor(resource, section, state, hasUserSignal),
      evidenceRefs: state === 'exclude' ? [] : evidenceRefsFor(resource),
    } as ChunkDecision);
    if (includeProject && resource.atomicItems?.length) {
      for (const item of resource.atomicItems.slice(0, 2)) {
        decisions.push({
          targetKind: 'atomic_item',
          targetId: item.itemId,
          section: projectSectionFor(`${item.name ?? ''} ${item.summary ?? ''} ${haystack}`.toLowerCase(), index + decisions.length),
          state: index % 5 === 0 ? 'weak_include' : 'strong_include',
          confidence: item.confidence ?? 0.72,
          reason: `Atomic item "${item.name ?? item.itemId}" is independently useful for this project workspace.`,
          evidenceRefs: item.evidenceRefs?.length ? item.evidenceRefs : [`atomic:${item.itemId}`],
        } as ChunkDecision);
      }
    }
  }
  return decisions;
}

function projectSectionFor(text: string, index: number): string {
  const fallback = ['Architecture', 'Extraction', 'UX', 'Safety', 'Packaging'][index % 5] ?? 'Architecture';
  if (index % 3 === 0) return fallback;
  if (text.includes('extract') || text.includes('transcript') || text.includes('capture')) return 'Extraction';
  if (text.includes('privacy') || text.includes('safe') || text.includes('token') || text.includes('extension')) return 'Safety';
  if (text.includes('package') || text.includes('install') || text.includes('release')) return 'Packaging';
  if (text.includes('ux') || text.includes('interface') || text.includes('visual') || text.includes('review')) return 'UX';
  return fallback;
}

function inspirationSectionFor(text: string, hasUserSignal: boolean): string {
  if (hasUserSignal || text.includes('inspiration')) return 'Personal inspiration';
  if (text.includes('visual') || text.includes('gallery') || text.includes('mood')) return 'Visual references';
  if (text.includes('game') || text.includes('forest')) return 'Game inspiration';
  return 'Cross-domain references';
}

function reasonFor(resource: PromptResource, section: string, state: string, hasUserSignal: boolean): string {
  if (state === 'exclude') return 'This looks unrelated to the requested workspace and is hidden by default.';
  if (hasUserSignal) return `User annotation is primary evidence, and the resource fits ${section}.`;
  const title = resource.title ? `"${resource.title}"` : resource.resourceId;
  return `${title} matches ${section} through local title, group, or extracted evidence.`;
}

function evidenceRefsFor(resource: PromptResource): string[] {
  const annotation = resource.userAnnotations?.find(item => item.id);
  if (annotation?.id) return [`user_annotation:${annotation.id}`];
  const evidence = resource.evidence?.find(item => item.id);
  if (evidence?.id) return [evidence.id];
  return [`title:${resource.resourceId}`];
}

function targetIdsFromResources(resources: PromptResource[]): string[] {
  return resources.flatMap(resource => [
    resource.resourceId,
    ...(resource.atomicItems ?? []).map(item => item.itemId),
  ]);
}

function jsonBetweenLabels(prompt: string, startLabel: string, endLabel: string): unknown {
  const start = prompt.indexOf(startLabel);
  const end = prompt.indexOf(endLabel, start + startLabel.length);
  if (start === -1 || end === -1) return null;
  const text = prompt.slice(start + startLabel.length, end).trim();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonFromLastObject(text: string): unknown {
  const starts = [...text.matchAll(/\{/g)].map(match => match.index).filter((index): index is number => typeof index === 'number');
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(text.slice(start));
    } catch {
      // Try the previous object boundary.
    }
  }
  return null;
}

function jsonObjectsFromText(text: string): unknown[] {
  const objects: unknown[] = [];
  const starts = [...text.matchAll(/\{/g)].map(match => match.index).filter((index): index is number => typeof index === 'number');
  for (const start of starts.reverse()) {
    try {
      objects.push(JSON.parse(text.slice(start)));
    } catch {
      // Prompt text before the JSON is expected.
    }
  }
  return objects;
}

function textAfterLabel(prompt: string, label: string): string {
  const index = prompt.indexOf(label);
  if (index === -1) return '';
  const rest = prompt.slice(index + label.length);
  return rest.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function isPromptResource(value: unknown): value is PromptResource {
  return isRecord(value) && typeof value.resourceId === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}
