import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  type ExtractionAdapter,
  type ExtractionAdapterResult,
  type ExtractionArtifactDraft,
  type ExtractionArtifactStatus,
  type ExtractionRequest,
  validateAdapterResult,
} from './adapterContracts.js';
import { refreshResourceSearchText } from '../resources/searchIndex.js';
import {
  beginNextJobItem,
  createJob,
  finishJobItem,
  isJobCancelRequested,
  requeueJobItem,
  skipJobItem,
  touchJobItemLease,
} from '../jobs/service.js';
import type { ClaimedJobItem, JobSnapshot } from '../jobs/contracts.js';
import type { UrlKind } from '../shared/schemas.js';

export const EXTRACTION_JOB_KIND = 'metadata_fetch';

export const EXTRACTION_RECIPES = {
  youtubeStandard: 'youtube_standard_evidence.v1',
  genericWebpage: 'generic_webpage_evidence.v1',
} as const;

export type ExtractionRecipeId = typeof EXTRACTION_RECIPES[keyof typeof EXTRACTION_RECIPES] | string;

type ResourceRow = {
  id: string;
  canonical_url: string;
  redacted_url: string;
  url_kind: UrlKind;
  host: string;
  title_best: string | null;
};

type ExtractionJobItemInput = {
  resourceId: string;
  recipeId: string;
  dependencyHash: string;
};

export interface CreateExtractionJobOptions {
  resourceIds?: string[];
  recipeIds?: string[];
  requestedBy?: string;
  force?: boolean;
  limit?: number;
}

export interface ResumeExtractionJobOptions {
  maxItems?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  scratchDirectory?: string;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export interface ExtractionRunSummary {
  jobId: string;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export class ExtractionAdapterRegistry {
  private readonly adapters = new Map<string, ExtractionAdapter>();
  private readonly disabled = new Set<string>();

  register(adapter: ExtractionAdapter, options: { enabled?: boolean } = {}): this {
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate extraction adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    if (options.enabled === false) this.disabled.add(adapter.id);
    return this;
  }

  setEnabled(adapterId: string, enabled: boolean): void {
    if (enabled) this.disabled.delete(adapterId);
    else this.disabled.add(adapterId);
  }

  get(adapterId: string): ExtractionAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  select(request: ExtractionRequest): ExtractionAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (this.disabled.has(adapter.id)) continue;
      if (!adapter.recipeIds.includes(request.recipeId)) continue;
      if (adapter.supports(request)) return adapter;
    }
    return undefined;
  }

  hasEnabledAdapterForRecipe(recipeId: string): boolean {
    return [...this.adapters.values()].some(adapter => (
      !this.disabled.has(adapter.id) && adapter.recipeIds.includes(recipeId)
    ));
  }
}

export class ExtractionArtifactPersistence {
  constructor(private readonly db: Database.Database) {}

  persistResult(input: {
    request: ExtractionRequest;
    adapterId: string;
    adapterVersion: string;
    result: ExtractionAdapterResult;
    attempts: number;
    error?: string;
  }): string | undefined {
    const now = new Date().toISOString();
    const artifactIds: string[] = [];
    const tx = this.db.transaction(() => {
      for (const artifact of input.result.artifacts) {
        const artifactId = this.upsertArtifact(input.request, artifact, input.result.warnings, now);
        artifactIds.push(artifactId);
      }
      this.upsertState({
        request: input.request,
        adapterId: input.adapterId,
        status: input.result.status,
        attempts: input.attempts,
        artifactId: artifactIds[0],
        retryAfter: input.result.retryAfter,
        error: input.error ?? (isFailureStatus(input.result.status) ? input.result.warnings.join('; ') : undefined),
        now,
      });
      refreshResourceSearchText(this.db, input.request.resourceId);
    });
    tx();
    return artifactIds[0];
  }

  persistStatus(input: {
    request: ExtractionRequest;
    adapterId: string;
    status: ExtractionArtifactStatus;
    attempts: number;
    error?: string;
    retryAfter?: string;
  }): void {
    const tx = this.db.transaction(() => {
      this.upsertState({
        request: input.request,
        adapterId: input.adapterId,
        status: input.status,
        attempts: input.attempts,
        error: input.error,
        retryAfter: input.retryAfter,
        now: new Date().toISOString(),
      });
      refreshResourceSearchText(this.db, input.request.resourceId);
    });
    tx();
  }

  private upsertArtifact(
    request: ExtractionRequest,
    artifact: ExtractionArtifactDraft,
    warnings: string[],
    now: string,
  ): string {
    const parsed = {
      ...artifact.provenance,
      warnings,
    };
    const artifactId = stableArtifactId(request.resourceId, artifact.recipeId, artifact.artifactKind);
    this.db.prepare(`
      INSERT INTO extraction_artifacts
        (id, resource_id, recipe_id, artifact_kind, text_excerpt, json_payload, source_url, provenance, confidence, status, error_code, extracted_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_id, recipe_id) DO UPDATE SET
        artifact_kind = excluded.artifact_kind,
        text_excerpt = excluded.text_excerpt,
        json_payload = excluded.json_payload,
        source_url = excluded.source_url,
        provenance = excluded.provenance,
        confidence = excluded.confidence,
        status = excluded.status,
        error_code = excluded.error_code,
        extracted_at = excluded.extracted_at
    `).run(
      artifactId,
      artifact.resourceId,
      artifact.recipeId,
      artifact.artifactKind,
      artifact.textExcerpt ?? null,
      JSON.stringify(artifact.jsonPayload ?? {}),
      artifact.provenance.sourceUrl ?? request.canonicalUrl,
      JSON.stringify(parsed),
      artifact.confidence,
      artifact.status,
      isFailureStatus(artifact.status) ? artifact.status : null,
      now,
    );
    return artifactId;
  }

  private upsertState(input: {
    request: ExtractionRequest;
    adapterId: string;
    status: ExtractionArtifactStatus;
    attempts: number;
    artifactId?: string;
    error?: string;
    retryAfter?: string;
    now: string;
  }): void {
    this.db.prepare(`
      INSERT INTO resource_extraction_state
        (resource_id, recipe_id, adapter_id, dependency_hash, artifact_id, status, attempts, last_error, retry_after, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_id, recipe_id, adapter_id) DO UPDATE SET
        dependency_hash = excluded.dependency_hash,
        artifact_id = excluded.artifact_id,
        status = excluded.status,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        retry_after = excluded.retry_after,
        updated_at = excluded.updated_at
    `).run(
      input.request.resourceId,
      input.request.recipeId,
      input.adapterId,
      input.request.dependencyHash,
      input.artifactId ?? null,
      input.status,
      input.attempts,
      input.error ?? null,
      input.retryAfter ?? null,
      input.now,
    );
  }
}

export function createExtractionJob(
  db: Database.Database,
  options: CreateExtractionJobOptions = {},
): JobSnapshot {
  const resources = selectResources(db, options);
  const items = resources.flatMap(resource => {
    const recipeIds = options.recipeIds?.length ? options.recipeIds : determineExtractionRecipes(resource);
    return recipeIds.flatMap(recipeId => {
      const dependencyHash = computeExtractionDependencyHash(resource, recipeId);
      if (!options.force && hasFreshExtractionState(db, resource.id, recipeId, dependencyHash)) return [];
      return [{
        key: `${resource.id}:${recipeId}`,
        resourceId: resource.id,
        input: { resourceId: resource.id, recipeId, dependencyHash } satisfies ExtractionJobItemInput,
      }];
    });
  });

  return createJob(db, {
    kind: EXTRACTION_JOB_KIND,
    requestedBy: options.requestedBy ?? 'user',
    input: {
      recipeIds: options.recipeIds ?? [],
      resourceIds: options.resourceIds ?? [],
      force: Boolean(options.force),
    },
    items,
  });
}

export async function resumeExtractionJob(
  db: Database.Database,
  registry: ExtractionAdapterRegistry,
  jobId: string,
  options: ResumeExtractionJobOptions = {},
): Promise<ExtractionRunSummary> {
  const maxItems = options.maxItems ?? 1;
  const maxRetries = options.maxRetries ?? 3;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const persistence = new ExtractionArtifactPersistence(db);

  for (let index = 0; index < maxItems; index += 1) {
    if (options.signal?.aborted || isJobCancelRequested(db, jobId)) break;
    const item = beginNextJobItem(db, jobId, { maxAttempts: maxRetries });
    if (!item) break;
    processed += 1;
    const outcome = await runExtractionJobItem(db, registry, persistence, item, options);
    if (outcome === 'succeeded') succeeded += 1;
    else if (outcome === 'failed') failed += 1;
    else skipped += 1;
  }

  return { jobId, processed, succeeded, failed, skipped };
}

async function runExtractionJobItem(
  db: Database.Database,
  registry: ExtractionAdapterRegistry,
  persistence: ExtractionArtifactPersistence,
  item: ClaimedJobItem,
  options: ResumeExtractionJobOptions,
): Promise<'succeeded' | 'failed' | 'skipped'> {
  const input = parseJobItemInput(item.input);
  if (!input || options.signal?.aborted || isJobCancelRequested(db, item.jobId)) {
    skipJobItem(db, item.id, { status: 'cancelled_before_start' });
    return 'skipped';
  }

  const resource = getResource(db, input.resourceId);
  if (!resource) {
    finishJobItem(db, item.id, { ok: false, error: `Resource not found: ${input.resourceId}` });
    return 'failed';
  }

  const request = buildExtractionRequest(resource, input.recipeId, input.dependencyHash);
  const adapter = registry.select(request);
  if (!adapter) {
    persistence.persistStatus({
      request,
      adapterId: 'none',
      status: 'adapter_disabled',
      attempts: item.attempts,
      error: registry.hasEnabledAdapterForRecipe(request.recipeId) ? 'no adapter supports resource' : 'no enabled adapter',
    });
    finishJobItem(db, item.id, { ok: true, result: { status: 'adapter_disabled', adapterId: 'none' } });
    return 'succeeded';
  }

  try {
    touchJobItemLease(db, item.id);
    const result = validateAdapterResult(request, await adapter.run(request, {
      signal: options.signal ?? new AbortController().signal,
      scratchDirectory: options.scratchDirectory ?? path.join(os.tmpdir(), 'tab-atlas-extract'),
      maxResponseBytes: options.maxResponseBytes ?? 1_000_000,
      timeoutMs: options.timeoutMs ?? 10_000,
    }));
    touchJobItemLease(db, item.id);
    if (options.signal?.aborted || isJobCancelRequested(db, item.jobId)) {
      requeueJobItem(db, item.id, 'cancelled before persistence');
      return 'skipped';
    }
    persistence.persistResult({
      request,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      result,
      attempts: item.attempts,
    });
    if (isRetryableFailure(result.status)) {
      finishJobItem(db, item.id, { ok: false, result, error: result.warnings.join('; ') || result.status });
      return 'failed';
    }
    finishJobItem(db, item.id, { ok: true, result });
    return 'succeeded';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    persistence.persistStatus({
      request,
      adapterId: adapter.id,
      status: 'failed_adapter',
      attempts: item.attempts,
      error: message,
    });
    finishJobItem(db, item.id, { ok: false, error: message });
    return 'failed';
  }
}

export function determineExtractionRecipes(resource: Pick<ResourceRow, 'url_kind'>): string[] {
  if (resource.url_kind.startsWith('youtube_')) return [EXTRACTION_RECIPES.youtubeStandard];
  if (resource.url_kind === 'web_page' || resource.url_kind === 'github_repo' || resource.url_kind === 'github_issue' || resource.url_kind === 'github_pull' || resource.url_kind === 'github_file') {
    return [EXTRACTION_RECIPES.genericWebpage];
  }
  return [];
}

export function computeExtractionDependencyHash(resource: ResourceRow, recipeId: string): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 'extraction-v1',
    recipeId,
    resourceId: resource.id,
    canonicalUrl: resource.canonical_url,
    redactedUrl: resource.redacted_url,
    urlKind: resource.url_kind,
    host: resource.host,
    title: resource.title_best ?? '',
  })).digest('hex');
}

function parseJobItemInput(value: unknown): ExtractionJobItemInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.resourceId !== 'string' || typeof input.recipeId !== 'string' || typeof input.dependencyHash !== 'string') {
    return null;
  }
  return {
    resourceId: input.resourceId,
    recipeId: input.recipeId,
    dependencyHash: input.dependencyHash,
  };
}

function buildExtractionRequest(resource: ResourceRow, recipeId: string, dependencyHash: string): ExtractionRequest {
  return {
    resourceId: resource.id,
    canonicalUrl: resource.canonical_url,
    redactedUrl: resource.redacted_url,
    urlKind: resource.url_kind,
    title: resource.title_best ?? undefined,
    recipeId,
    dependencyHash,
  };
}

function selectResources(db: Database.Database, options: CreateExtractionJobOptions): ResourceRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.resourceIds?.length) {
    clauses.push(`id IN (${options.resourceIds.map(() => '?').join(', ')})`);
    params.push(...options.resourceIds);
  }
  const limit = options.limit ?? 500;
  params.push(limit);
  return db.prepare(`
    SELECT id, canonical_url, redacted_url, url_kind, host, title_best
    FROM resources
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY last_seen_at DESC
    LIMIT ?
  `).all(...params) as ResourceRow[];
}

function getResource(db: Database.Database, resourceId: string): ResourceRow | undefined {
  return db.prepare(`
    SELECT id, canonical_url, redacted_url, url_kind, host, title_best
    FROM resources
    WHERE id = ?
  `).get(resourceId) as ResourceRow | undefined;
}

function hasFreshExtractionState(
  db: Database.Database,
  resourceId: string,
  recipeId: string,
  dependencyHash: string,
): boolean {
  const row = db.prepare(`
    SELECT status
    FROM resource_extraction_state
    WHERE resource_id = ? AND recipe_id = ? AND dependency_hash = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(resourceId, recipeId, dependencyHash) as { status: string } | undefined;
  return row ? ['metadata_only', 'partial', 'complete', 'blocked_auth_required', 'not_available'].includes(row.status) : false;
}

function stableArtifactId(resourceId: string, recipeId: string, artifactKind: string): string {
  const suffix = crypto.createHash('sha1').update(`${resourceId}\n${recipeId}\n${artifactKind}`).digest('hex').slice(0, 16);
  return `art_${suffix}`;
}

function isFailureStatus(status: ExtractionArtifactStatus): boolean {
  return status.startsWith('failed_');
}

function isRetryableFailure(status: ExtractionArtifactStatus): boolean {
  return status === 'failed_network' || status === 'failed_adapter';
}
