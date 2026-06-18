import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LlmProvider, LlmResult, LlmTurnOptions } from '../llm/types.js';
import { PROMPT_REDACTION_VERSION } from './urlPrivacy.js';

export interface PromptManifestInput {
  purpose: string;
  prompt: string;
  provider?: LlmProvider;
  turnOptions?: LlmTurnOptions;
  metadata?: Record<string, unknown>;
}

export interface PromptManifestRecord {
  id: string;
  purpose: string;
  promptHash: string;
  redactionVersion: string;
}

export function recordPromptManifest(
  db: Database.Database,
  input: PromptManifestInput,
): PromptManifestRecord {
  const providerMetadata = providerManifestMetadata(input.provider);
  const metadata = {
    ...(input.metadata ?? {}),
    promptBytes: Buffer.byteLength(input.prompt, 'utf8'),
    hasSystemPrompt: Boolean(input.turnOptions?.system),
    hasOutputSchema: input.turnOptions?.outputSchema !== undefined,
    provider: providerMetadata.metadata,
  };
  const id = `prompt_manifest_${crypto.randomUUID()}`;
  const promptHash = hashPrompt(input.prompt, input.turnOptions?.system);
  db.prepare(`
    INSERT INTO codex_prompt_manifests
      (id, purpose, prompt_hash, provider_role, provider_scope_key, redaction_version, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.purpose,
    promptHash,
    providerMetadata.role,
    providerMetadata.scopeKey,
    PROMPT_REDACTION_VERSION,
    JSON.stringify(metadata),
    new Date().toISOString(),
  );
  return { id, purpose: input.purpose, promptHash, redactionVersion: PROMPT_REDACTION_VERSION };
}

export function withPromptManifestRecorder(
  db: Database.Database,
  provider: LlmProvider,
  purpose: string,
  metadata: Record<string, unknown> = {},
): LlmProvider {
  return {
    get threadId() {
      return providerThreadId(provider);
    },
    complete(prompt: string, opts?: LlmTurnOptions): Promise<LlmResult> {
      recordPromptManifest(db, { purpose, prompt, provider, turnOptions: opts, metadata });
      return provider.complete(prompt, opts);
    },
  } as LlmProvider;
}

function hashPrompt(prompt: string, systemPrompt?: string): string {
  return crypto
    .createHash('sha256')
    .update(systemPrompt ?? '')
    .update('\0')
    .update(prompt)
    .digest('hex');
}

function providerManifestMetadata(provider: LlmProvider | undefined): {
  role?: string;
  scopeKey?: string;
  metadata: Record<string, unknown>;
} {
  const candidate = provider as {
    role?: unknown;
    scopeKey?: unknown;
    ownerKey?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
    generation?: unknown;
    threadId?: unknown;
  } | undefined;
  if (!candidate) return { metadata: {} };
  return {
    role: typeof candidate.role === 'string' ? candidate.role : undefined,
    scopeKey: typeof candidate.scopeKey === 'string' ? candidate.scopeKey : undefined,
    metadata: {
      ownerKey: typeof candidate.ownerKey === 'string' ? candidate.ownerKey : undefined,
      model: typeof candidate.model === 'string' ? candidate.model : undefined,
      reasoningEffort: typeof candidate.reasoningEffort === 'string' ? candidate.reasoningEffort : undefined,
      generation: typeof candidate.generation === 'number' ? candidate.generation : undefined,
      threadId: typeof candidate.threadId === 'string' ? candidate.threadId : undefined,
    },
  };
}

function providerThreadId(provider: LlmProvider): string | null {
  const candidate = provider as { threadId?: unknown };
  return typeof candidate.threadId === 'string' ? candidate.threadId : null;
}
