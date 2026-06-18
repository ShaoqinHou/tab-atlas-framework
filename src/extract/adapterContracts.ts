import { z } from 'zod';
import { UrlKind } from '../shared/schemas.js';

export const ExtractionTrustLevel = z.enum([
  'user_authored',
  'official_api',
  'public_metadata',
  'local_adapter',
  'page_derived',
  'ai_derived',
]);
export type ExtractionTrustLevel = z.infer<typeof ExtractionTrustLevel>;

export const ExtractionArtifactStatus = z.enum([
  'metadata_only',
  'partial',
  'complete',
  'blocked_auth_required',
  'blocked_size_limit',
  'blocked_policy',
  'adapter_disabled',
  'not_available',
  'failed_network',
  'failed_parse',
  'failed_adapter',
]);
export type ExtractionArtifactStatus = z.infer<typeof ExtractionArtifactStatus>;

export const ExtractionRequest = z.object({
  resourceId: z.string(),
  canonicalUrl: z.string().url(),
  redactedUrl: z.string().url(),
  urlKind: UrlKind,
  title: z.string().optional(),
  recipeId: z.string(),
  dependencyHash: z.string(),
});
export type ExtractionRequest = z.infer<typeof ExtractionRequest>;

export const ExtractionProvenance = z.object({
  trust: ExtractionTrustLevel,
  adapterId: z.string(),
  adapterVersion: z.string(),
  fetchedAt: z.string(),
  sourceUrl: z.string().url().optional(),
  contentHash: z.string().optional(),
  notes: z.array(z.string()).default([]),
});
export type ExtractionProvenance = z.infer<typeof ExtractionProvenance>;

export const ExtractionArtifactDraft = z.object({
  resourceId: z.string(),
  recipeId: z.string(),
  artifactKind: z.string(),
  status: ExtractionArtifactStatus,
  textExcerpt: z.string().optional(),
  jsonPayload: z.unknown().optional(),
  confidence: z.number().min(0).max(1),
  provenance: ExtractionProvenance,
});
export type ExtractionArtifactDraft = z.infer<typeof ExtractionArtifactDraft>;

export const ExtractionAdapterResult = z.object({
  adapterId: z.string(),
  status: ExtractionArtifactStatus,
  artifacts: z.array(ExtractionArtifactDraft).default([]),
  warnings: z.array(z.string()).default([]),
  retryAfter: z.string().optional(),
});
export type ExtractionAdapterResult = z.infer<typeof ExtractionAdapterResult>;

export interface ExtractionAdapterContext {
  signal: AbortSignal;
  scratchDirectory: string;
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface ExtractionAdapter {
  readonly id: string;
  readonly version: string;
  readonly recipeIds: readonly string[];
  supports(request: ExtractionRequest): boolean;
  run(request: ExtractionRequest, context: ExtractionAdapterContext): Promise<ExtractionAdapterResult>;
}

export function validateAdapterResult(
  request: ExtractionRequest,
  raw: unknown,
): ExtractionAdapterResult {
  const result = ExtractionAdapterResult.parse(raw);
  for (const artifact of result.artifacts) {
    if (artifact.resourceId !== request.resourceId) {
      throw new Error(`Adapter ${result.adapterId} returned artifact for another resource: ${artifact.resourceId}`);
    }
    if (artifact.recipeId !== request.recipeId) {
      throw new Error(`Adapter ${result.adapterId} returned unexpected recipe ${artifact.recipeId}`);
    }
  }
  if (result.status === 'complete' && result.artifacts.length === 0) {
    throw new Error(`Adapter ${result.adapterId} reported complete without artifacts`);
  }
  return result;
}
