import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { buildResourceBriefs } from '../resources/briefs.js';
import { refreshResourceSearchText } from '../resources/searchIndex.js';
import { runStructured, StructuredOutputError } from '../llm/runStructured.js';
import type { LlmProvider } from '../llm/types.js';
import type { ResourceBrief } from '../shared/schemas.js';
import { computeResourceKnowledgeDependencyHash } from '../knowledge/dependencyHash.js';
import { isDetailedAtomicItemSupportedByEvidence } from '../extract/youtube.js';
import {
  beginNextJobItem,
  createJob,
  finishJobItem,
  getJobSnapshot,
  isJobCancelRequested,
  prepareJobResume,
  requeueJobItem,
  skipJobItem,
  touchJobItemLease,
} from '../jobs/service.js';
import type { JobSnapshot as JobSnapshotValue } from '../jobs/contracts.js';
import { logAgentRun } from './runLog.js';

export const CODEX_RESOURCE_ANALYSIS_RECIPE = 'codex_resource_analysis.v1';

const ReasoningEffort = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);

export const RunCodexResourceScanInput = z.object({
  limit: z.number().int().positive().max(1000).default(100),
  batchSize: z.number().int().positive().max(50).default(20),
  maxBatchBytes: z.number().int().positive().max(1_000_000).default(80_000),
  resourceIds: z.array(z.string()).default([]),
  reasoningEffort: ReasoningEffort.default('medium'),
  force: z.boolean().default(false),
});

export type RunCodexResourceScanInput = z.input<typeof RunCodexResourceScanInput>;

const ContentKind = z.enum([
  'youtube_video',
  'youtube_playlist',
  'article',
  'docs',
  'repo',
  'pdf',
  'search',
  'login',
  'unknown',
]);

const UserPurposeGuess = z.enum([
  'watch_later',
  'inspiration',
  'reference',
  'project_reference',
  'ignore_candidate',
  'archive_candidate',
  'needs_review',
]);

const AtomicItemAnalysis = z.object({
  itemKind: z.string().min(1).default('unknown'),
  name: z.string().min(1),
  summary: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const CodexResourceScanBatchOutput = z.object({
  resources: z.array(z.object({
    resourceId: z.string(),
    summary: z.string().min(1),
    contentKind: ContentKind.default('unknown'),
    userPurposeGuess: UserPurposeGuess.default('needs_review'),
    topics: z.array(z.string()).default([]),
    suggestedTags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.5),
    evidenceRefs: z.array(z.string()).default([]),
    missingEvidence: z.array(z.string()).default([]),
    reviewReason: z.string().default(''),
    atomicItems: z.array(AtomicItemAnalysis).default([]),
  })),
});

export type CodexResourceScanBatchOutput = z.infer<typeof CodexResourceScanBatchOutput>;

export interface RunCodexResourceScanResult {
  resourcesConsidered: number;
  resourcesScanned: number;
  resourcesSkippedFresh: number;
  artifactsWritten: number;
  atomicItemsWritten: number;
  batches: number;
  codexTurns: number;
  agentRunIds: string[];
  skippedResourceIds: string[];
}

type ResourceIdRow = {
  id: string;
};

const ResourceScanCandidateInput = z.object({
  resourceId: z.string(),
  dependencyHash: z.string(),
  previousHash: z.string().optional(),
  artifactId: z.string().optional(),
  generation: z.number().int().positive(),
  status: z.string().optional(),
});

export interface ResourceScanCandidate {
  resourceId: string;
  dependencyHash: string;
  previousHash?: string;
  artifactId?: string;
  generation: number;
  status?: string;
}

export interface CodexScanJobCreateResult {
  job: JobSnapshotValue;
  resourcesConsidered: number;
  resourcesQueued: number;
  resourcesSkippedFresh: number;
}

export interface CodexScanJobResumeResult {
  job: JobSnapshotValue;
  processedItems: number;
  scannedResources: number;
  skippedItems: number;
  failedItems: number;
  codexTurns: number;
}

export async function runCodexResourceScan(
  db: Database.Database,
  provider: LlmProvider,
  input: RunCodexResourceScanInput,
): Promise<RunCodexResourceScanResult> {
  const parsed = RunCodexResourceScanInput.parse(input);
  const selection = selectResourcesForScan(db, parsed);
  const resourceIds = selection.candidates.map(candidate => candidate.resourceId);
  const candidateByResourceId = new Map(selection.candidates.map(candidate => [candidate.resourceId, candidate]));
  const batches = chunkByBriefPayload(db, resourceIds, parsed.batchSize, parsed.maxBatchBytes);
  const result: RunCodexResourceScanResult = {
    resourcesConsidered: selection.resourcesConsidered,
    resourcesScanned: 0,
    resourcesSkippedFresh: selection.resourcesSkippedFresh,
    artifactsWritten: 0,
    atomicItemsWritten: 0,
    batches: batches.length,
    codexTurns: 0,
    agentRunIds: [],
    skippedResourceIds: selection.skippedResourceIds,
  };

  for (const ids of batches) {
    const startedAt = new Date().toISOString();
    const briefs = buildResourceBriefs(db, ids).map(briefForScan);
    const inputSummary = {
      recipeId: CODEX_RESOURCE_ANALYSIS_RECIPE,
      resourceIds: ids,
      resourceCount: ids.length,
      reasoningEffort: parsed.reasoningEffort,
      force: parsed.force,
    };

    try {
      const scan = await scanBatch(provider, briefs);
      const written = persistScanBatch(db, briefs, scan.value, candidateByResourceId);
      result.resourcesScanned += scan.value.resources.length;
      result.artifactsWritten += written.artifactsWritten;
      result.atomicItemsWritten += written.atomicItemsWritten;
      result.codexTurns += scan.usage.quotaTurns ?? 0;
      const runId = logAgentRun(db, {
        provider: providerLabelFor(provider),
        purpose: 'codex_resource_scan',
        input: inputSummary,
        output: {
          resourceCount: scan.value.resources.length,
          artifactCount: written.artifactsWritten,
          atomicItemCount: written.atomicItemsWritten,
        },
        schemaId: 'CodexResourceScanBatchOutput',
        validationStatus: 'passed',
        usage: scan.usage,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      result.agentRunIds.push(runId);
    } catch (error) {
      const usage = error instanceof StructuredOutputError ? error.usage : undefined;
      if (usage?.quotaTurns) result.codexTurns += usage.quotaTurns;
      const runId = logAgentRun(db, {
        provider: providerLabelFor(provider),
        purpose: 'codex_resource_scan',
        input: inputSummary,
        schemaId: 'CodexResourceScanBatchOutput',
        validationStatus: 'error',
        usage,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      result.agentRunIds.push(runId);
      throw error;
    }
  }

  return result;
}

export function createCodexScanJob(
  db: Database.Database,
  input: RunCodexResourceScanInput,
  options: { jobId?: string } = {},
): CodexScanJobCreateResult {
  const parsed = RunCodexResourceScanInput.parse(input);
  const selection = selectResourcesForScan(db, parsed);
  const job = createJob(db, {
    id: options.jobId,
    kind: 'codex_scan',
    requestedBy: 'user',
    input: {
      ...parsed,
      recipeId: CODEX_RESOURCE_ANALYSIS_RECIPE,
    },
    items: selection.candidates.map(candidate => ({
      key: `${CODEX_RESOURCE_ANALYSIS_RECIPE}:${candidate.resourceId}:${candidate.dependencyHash}`,
      resourceId: candidate.resourceId,
      input: candidate,
    })),
  });
  return {
    job,
    resourcesConsidered: selection.resourcesConsidered,
    resourcesQueued: selection.candidates.length,
    resourcesSkippedFresh: selection.resourcesSkippedFresh,
  };
}

export async function resumeCodexScanJob(
  db: Database.Database,
  provider: LlmProvider,
  jobId: string,
  options: { maxItems?: number; maxRetries?: number; signal?: AbortSignal } = {},
): Promise<CodexScanJobResumeResult> {
  const maxItems = options.maxItems ?? 20;
  const maxRetries = options.maxRetries ?? 3;
  prepareJobResume(db, jobId);
  let processedItems = 0;
  let scannedResources = 0;
  let skippedItems = 0;
  let failedItems = 0;
  let codexTurns = 0;

  while (processedItems < maxItems) {
    if (options.signal?.aborted || isJobCancelRequested(db, jobId)) break;
    const item = beginNextJobItem(db, jobId);
    if (!item) break;
    const candidate = ResourceScanCandidateInput.parse(item.input);
    if (!shouldScanCandidate(db, candidate, false)) {
      skipJobItem(db, item.id, { reason: 'fresh', resourceId: candidate.resourceId });
      processedItems += 1;
      skippedItems += 1;
      continue;
    }

    const brief = briefForScan(buildResourceBriefs(db, [candidate.resourceId])[0]);
    try {
      if (options.signal?.aborted || isJobCancelRequested(db, jobId)) {
        break;
      }
      touchJobItemLease(db, item.id);
      const scan = await scanBatch(provider, [brief]);
      touchJobItemLease(db, item.id);
      if (options.signal?.aborted || isJobCancelRequested(db, jobId)) {
        break;
      }
      codexTurns += scan.usage.quotaTurns ?? 0;
      persistScanBatch(db, [brief], scan.value, new Map([[candidate.resourceId, candidate]]), item.id);
      processedItems += 1;
      scannedResources += scan.value.resources.length;
    } catch (error) {
      const usage = error instanceof StructuredOutputError ? error.usage : undefined;
      codexTurns += usage?.quotaTurns ?? 0;
      if (item.attempts < maxRetries) {
        requeueJobItem(db, item.id, error instanceof Error ? error.message : String(error));
      } else {
        finishJobItem(db, item.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
        processedItems += 1;
        failedItems += 1;
      }
    }
  }

  return {
    job: getJobSnapshot(db, jobId),
    processedItems,
    scannedResources,
    skippedItems,
    failedItems,
    codexTurns,
  };
}

function selectResourcesForScan(
  db: Database.Database,
  input: z.infer<typeof RunCodexResourceScanInput>,
): {
  candidates: ResourceScanCandidate[];
  resourcesConsidered: number;
  resourcesSkippedFresh: number;
  skippedResourceIds: string[];
} {
  const resourceIds = selectCandidateResourceIds(db, input.resourceIds);
  const candidates: ResourceScanCandidate[] = [];
  const skippedResourceIds: string[] = [];
  let resourcesSkippedFresh = 0;

  for (const resourceId of resourceIds) {
    const brief = buildResourceBriefs(db, [resourceId])[0];
    const dependencyHash = computeResourceKnowledgeDependencyHash(brief);
    const state = getKnowledgeState(db, resourceId);
    const candidate: ResourceScanCandidate = {
      resourceId,
      dependencyHash,
      previousHash: state?.dependency_hash,
      artifactId: state?.artifact_id ?? undefined,
      generation: (state?.generation ?? 0) + 1,
      status: state?.status,
    };
    if (shouldScanCandidate(db, candidate, input.force)) {
      candidates.push(candidate);
      if (candidates.length >= input.limit) break;
    } else {
      resourcesSkippedFresh += 1;
      skippedResourceIds.push(resourceId);
    }
  }

  return {
    candidates,
    resourcesConsidered: resourceIds.length,
    resourcesSkippedFresh,
    skippedResourceIds,
  };
}

function selectCandidateResourceIds(db: Database.Database, resourceIds: string[]): string[] {
  if (resourceIds.length) {
    const rows = db.prepare(`
      SELECT id
      FROM resources
      WHERE id IN (${resourceIds.map(() => '?').join(', ')})
      ORDER BY last_seen_at DESC
    `).all(...resourceIds) as ResourceIdRow[];
    return rows.map(row => row.id);
  }
  const rows = db.prepare(`
    SELECT id
    FROM resources
    ORDER BY last_seen_at DESC
  `).all() as ResourceIdRow[];
  return rows.map(row => row.id);
}

function shouldScanCandidate(db: Database.Database, candidate: ResourceScanCandidate, force: boolean): boolean {
  if (force) return true;
  const state = getKnowledgeState(db, candidate.resourceId);
  if (!state) return true;
  if (state.status !== 'fresh') return true;
  if (!state.artifact_id) return true;
  if (state.dependency_hash !== candidate.dependencyHash) return true;
  const artifact = db.prepare(`
    SELECT id
    FROM extraction_artifacts
    WHERE id = ? AND resource_id = ? AND recipe_id = ?
  `).get(state.artifact_id, candidate.resourceId, CODEX_RESOURCE_ANALYSIS_RECIPE) as { id: string } | undefined;
  return !artifact;
}

function getKnowledgeState(db: Database.Database, resourceId: string): {
  dependency_hash: string;
  artifact_id: string | null;
  status: string;
  generation: number;
} | undefined {
  return db.prepare(`
    SELECT dependency_hash, artifact_id, status, generation
    FROM resource_knowledge_state
    WHERE resource_id = ? AND recipe_id = ?
  `).get(resourceId, CODEX_RESOURCE_ANALYSIS_RECIPE) as {
    dependency_hash: string;
    artifact_id: string | null;
    status: string;
    generation: number;
  } | undefined;
}

async function scanBatch(provider: LlmProvider, briefs: ResourceBrief[]) {
  const prompt = [
    'Scan these TabAtlas resources into reusable local knowledge.',
    'Use only supplied resource briefs and evidence. Do not browse, fetch pages, inspect cookies, parse sessions, or mutate browser tabs.',
    'User annotations are primary evidence and override Codex guesses when they conflict.',
    'Every useful claim should cite evidenceRefs from each resource brief evidence id or user_annotation:<annotation id>.',
    'Use needs_review and missingEvidence when evidence is weak. Do not claim transcript evidence unless a transcript artifact is present.',
    'Create atomicItems only for dense resources where the supplied title, user note, URL metadata, or artifact evidence justifies sub-items.',
    '',
    'Return exactly one analysis for every resource in this batch.',
    '',
    JSON.stringify({ resources: briefs }, null, 2),
  ].join('\n');

  const expectedIds = new Set(briefs.map(brief => brief.resourceId));
  const knownEvidenceRefs = knownEvidenceRefsFor(briefs);
  return runStructured(provider, prompt, CodexResourceScanBatchOutput, {
    system: scanSystemPrompt(),
    maxRetries: 2,
    outputSchema: scanJsonSchema(),
    semanticValidate: value => validateScanOutput(value, expectedIds, knownEvidenceRefs),
  });
}

function briefForScan(brief: ResourceBrief): ResourceBrief {
  return {
    ...brief,
    atomicItems: [],
    evidence: brief.evidence.filter(evidence => !isCodexScanEvidence(evidence.kind, evidence.provenance)),
  };
}

function isCodexScanEvidence(kind: string, provenance: string): boolean {
  return kind === 'codex_resource_analysis' || provenance.toLowerCase().startsWith('codex');
}

function chunkByBriefPayload(
  db: Database.Database,
  resourceIds: string[],
  maxItems: number,
  maxBytes: number,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const resourceId of resourceIds) {
    const brief = briefForScan(buildResourceBriefs(db, [resourceId])[0]);
    const bytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
    if (current.length && (current.length >= maxItems || currentBytes + bytes > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(resourceId);
    currentBytes += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function persistScanBatch(
  db: Database.Database,
  briefs: ResourceBrief[],
  scan: CodexResourceScanBatchOutput,
  candidates: Map<string, ResourceScanCandidate>,
  jobItemId?: string,
): { artifactsWritten: number; atomicItemsWritten: number } {
  const briefById = new Map(briefs.map(brief => [brief.resourceId, brief]));
  let artifactsWritten = 0;
  let atomicItemsWritten = 0;

  for (const analysis of scan.resources) {
    const brief = briefById.get(analysis.resourceId);
    const candidate = candidates.get(analysis.resourceId);
    if (!brief || !candidate) continue;
    const tx = db.transaction(() => {
      const artifactId = upsertScanArtifact(db, brief, analysis);
      const supportedAtomicItems = analysis.atomicItems.filter(item => isDetailedAtomicItemSupportedByEvidence({
        urlKind: brief.urlKind,
        title: brief.title,
        evidenceRefs: item.evidenceRefs,
        evidence: brief.evidence,
      }));
      artifactsWritten += 1;
      deleteCodexAtomicItems(db, analysis.resourceId);
      for (const item of supportedAtomicItems) {
        upsertAtomicItem(db, analysis.resourceId, item);
        atomicItemsWritten += 1;
      }
      refreshResourceSearchText(db, analysis.resourceId);
      markKnowledgeFresh(db, candidate, artifactId);
      if (jobItemId) {
        finishJobItem(db, jobItemId, {
          ok: true,
          result: {
            resourceId: analysis.resourceId,
            artifactId,
            atomicItemCount: supportedAtomicItems.length,
          },
        });
      }
    });
    tx();
  }

  return { artifactsWritten, atomicItemsWritten };
}

function upsertScanArtifact(
  db: Database.Database,
  brief: ResourceBrief,
  analysis: CodexResourceScanBatchOutput['resources'][number],
): string {
  const id = scanArtifactId(analysis.resourceId);
  const textExcerpt = [
    analysis.summary,
    `content kind: ${analysis.contentKind}`,
    `purpose: ${analysis.userPurposeGuess}`,
    analysis.topics.length ? `topics: ${analysis.topics.join(', ')}` : '',
    analysis.suggestedTags.length ? `suggested tags: ${analysis.suggestedTags.join(', ')}` : '',
    analysis.missingEvidence.length ? `missing evidence: ${analysis.missingEvidence.join(', ')}` : '',
    analysis.reviewReason ? `review: ${analysis.reviewReason}` : '',
    ...analysis.atomicItems.map(item => `atomic ${item.itemKind}: ${item.name} - ${item.summary}`),
  ].filter(Boolean).join(' | ');
  const status = analysis.confidence >= 0.7 && analysis.missingEvidence.length === 0 ? 'complete' : 'partial';

  db.prepare(`
    INSERT INTO extraction_artifacts
      (id, resource_id, recipe_id, artifact_kind, text_excerpt, json_payload, source_url, provenance, confidence, status, extracted_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_id, recipe_id) DO UPDATE SET
      artifact_kind = excluded.artifact_kind,
      text_excerpt = excluded.text_excerpt,
      json_payload = excluded.json_payload,
      source_url = excluded.source_url,
      provenance = excluded.provenance,
      confidence = excluded.confidence,
      status = excluded.status,
      error_code = NULL,
      extracted_at = excluded.extracted_at
  `).run(
    id,
    analysis.resourceId,
    CODEX_RESOURCE_ANALYSIS_RECIPE,
    'codex_resource_analysis',
    textExcerpt,
    JSON.stringify(analysis),
    brief.redactedUrl ?? brief.canonicalUrl,
    'codex',
    analysis.confidence,
    status,
    new Date().toISOString(),
  );
  return id;
}

function deleteCodexAtomicItems(db: Database.Database, resourceId: string): void {
  db.prepare(`
    DELETE FROM atomic_items
    WHERE resource_id = ? AND created_by = 'codex_scan'
  `).run(resourceId);
}

function upsertAtomicItem(
  db: Database.Database,
  resourceId: string,
  item: z.infer<typeof AtomicItemAnalysis>,
): void {
  db.prepare(`
    INSERT INTO atomic_items
      (id, resource_id, item_kind, name, summary, evidence_refs, confidence, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'codex_scan', ?)
    ON CONFLICT(id) DO UPDATE SET
      item_kind = excluded.item_kind,
      name = excluded.name,
      summary = excluded.summary,
      evidence_refs = excluded.evidence_refs,
      confidence = excluded.confidence,
      created_by = excluded.created_by,
      created_at = excluded.created_at
  `).run(
    atomicItemId(resourceId, item.itemKind, item.name),
    resourceId,
    item.itemKind,
    item.name,
    item.summary,
    JSON.stringify(item.evidenceRefs),
    item.confidence,
    new Date().toISOString(),
  );
}

function markKnowledgeFresh(db: Database.Database, candidate: ResourceScanCandidate, artifactId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO resource_knowledge_state
      (resource_id, recipe_id, dependency_hash, artifact_id, status, generation, last_scanned_at, last_error, updated_at)
    VALUES (?, ?, ?, ?, 'fresh', ?, ?, NULL, ?)
    ON CONFLICT(resource_id, recipe_id) DO UPDATE SET
      dependency_hash = excluded.dependency_hash,
      artifact_id = excluded.artifact_id,
      status = 'fresh',
      generation = excluded.generation,
      last_scanned_at = excluded.last_scanned_at,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run(
    candidate.resourceId,
    CODEX_RESOURCE_ANALYSIS_RECIPE,
    candidate.dependencyHash,
    artifactId,
    candidate.generation,
    now,
    now,
  );
}

function validateScanOutput(
  value: CodexResourceScanBatchOutput,
  expectedIds: Set<string>,
  knownEvidenceRefs: Set<string>,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const resource of value.resources) {
    if (!expectedIds.has(resource.resourceId)) errors.push(`unknown resourceId ${resource.resourceId}`);
    if (seen.has(resource.resourceId)) errors.push(`duplicate resourceId ${resource.resourceId}`);
    seen.add(resource.resourceId);
    if (resource.confidence >= 0.6 && resource.evidenceRefs.length === 0) {
      errors.push(`resource ${resource.resourceId} has confidence >= 0.6 but no evidenceRefs`);
    }
    for (const ref of resource.evidenceRefs) {
      if (!knownEvidenceRefs.has(ref)) errors.push(`resource ${resource.resourceId} references unknown evidence ${ref}`);
    }
    for (const item of resource.atomicItems) {
      if (item.confidence >= 0.6 && item.evidenceRefs.length === 0) {
        errors.push(`atomic item ${item.name} has confidence >= 0.6 but no evidenceRefs`);
      }
      for (const ref of item.evidenceRefs) {
        if (!knownEvidenceRefs.has(ref)) errors.push(`atomic item ${item.name} references unknown evidence ${ref}`);
      }
    }
  }
  for (const id of expectedIds) {
    if (!seen.has(id)) errors.push(`missing resourceId ${id}`);
  }
  return errors;
}

function knownEvidenceRefsFor(briefs: ResourceBrief[]): Set<string> {
  const refs = new Set<string>();
  for (const brief of briefs) {
    refs.add(`resource:${brief.resourceId}`);
    for (const evidence of brief.evidence) refs.add(evidence.id);
    for (const annotation of brief.userAnnotations) {
      refs.add(`user_annotation:${brief.resourceId}`);
      if (annotation.id) refs.add(`user_annotation:${annotation.id}`);
    }
    for (const item of brief.atomicItems) {
      refs.add(item.itemId);
      for (const ref of item.evidenceRefs) refs.add(ref);
    }
  }
  return refs;
}

function scanArtifactId(resourceId: string): string {
  return `art_${resourceId}_${CODEX_RESOURCE_ANALYSIS_RECIPE.replace(/[^a-z0-9]+/gi, '_')}`;
}

function atomicItemId(resourceId: string, itemKind: string, name: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${resourceId}\u0000${itemKind.toLowerCase()}\u0000${name.toLowerCase()}`)
    .digest('hex')
    .slice(0, 18);
  return `item_${digest}`;
}

function providerLabelFor(provider: LlmProvider): string {
  return provider.constructor?.name ?? 'codex-provider';
}

function scanSystemPrompt(): string {
  return [
    'You are TabAtlas Resource Scanner.',
    'Create reusable local evidence for future semantic tab views.',
    'Respect user notes/tags first. Use supplied evidence only.',
    'Never browse, scrape, mutate browser tabs, inspect cookies, inspect sessions, or claim unavailable transcripts.',
    'Return JSON only matching the requested schema.',
  ].join('\n');
}

function scanJsonSchema(): unknown {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['resources'],
    properties: {
      resources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'resourceId',
            'summary',
            'contentKind',
            'userPurposeGuess',
            'topics',
            'suggestedTags',
            'confidence',
            'evidenceRefs',
            'missingEvidence',
            'reviewReason',
            'atomicItems',
          ],
          properties: {
            resourceId: { type: 'string' },
            summary: { type: 'string' },
            contentKind: { type: 'string', enum: ContentKind.options },
            userPurposeGuess: { type: 'string', enum: UserPurposeGuess.options },
            topics: { type: 'array', items: { type: 'string' } },
            suggestedTags: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidenceRefs: { type: 'array', items: { type: 'string' } },
            missingEvidence: { type: 'array', items: { type: 'string' } },
            reviewReason: { type: 'string' },
            atomicItems: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['itemKind', 'name', 'summary', 'evidenceRefs', 'confidence'],
                properties: {
                  itemKind: { type: 'string' },
                  name: { type: 'string' },
                  summary: { type: 'string' },
                  evidenceRefs: { type: 'array', items: { type: 'string' } },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                },
              },
            },
          },
        },
      },
    },
  };
}

export function countCodexScanArtifacts(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM extraction_artifacts
    WHERE recipe_id = ?
  `).get(CODEX_RESOURCE_ANALYSIS_RECIPE) as { count: number };
  return row.count;
}

export function countAtomicItems(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM atomic_items').get() as { count: number };
  return row.count;
}
