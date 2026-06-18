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
    providerFactory: config => new CodexSdkProvider({
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
