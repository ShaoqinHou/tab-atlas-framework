import crypto from 'node:crypto';
import type { ResourceBrief } from '../shared/schemas.js';

export const RESOURCE_KNOWLEDGE_HASH_VERSION = 'resource-knowledge-v1';

/**
 * Stable dependency hash for Codex resource analysis.
 *
 * The hash deliberately excludes Codex-derived scan evidence and atomic items,
 * otherwise writing a scan result would immediately make that same scan stale.
 * It includes user annotations and deterministic/local evidence because those
 * are the inputs that should trigger a rescan when they actually change.
 */
export function computeResourceKnowledgeDependencyHash(brief: ResourceBrief): string {
  const payload = buildResourceKnowledgeDependencyPayload(brief);
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function buildResourceKnowledgeDependencyPayload(brief: ResourceBrief): unknown {
  return {
    version: RESOURCE_KNOWLEDGE_HASH_VERSION,
    resource: {
      resourceId: brief.resourceId,
      canonicalUrl: brief.canonicalUrl,
      urlKind: brief.urlKind,
      host: brief.host,
      title: brief.title ?? '',
      browserGroupTitles: [...brief.browserGroupTitles].map(normalizeText).filter(Boolean).sort(),
      systemTags: [...brief.systemTags].map(normalizeTag).filter(Boolean).sort(),
    },
    userAnnotations: [...brief.userAnnotations]
      .map(annotation => ({
        id: annotation.id ?? '',
        tags: [...annotation.tags].map(normalizeTag).filter(Boolean).sort(),
        description: normalizeText(annotation.description ?? ''),
        decision: annotation.decision,
        source: annotation.source,
        createdAt: annotation.createdAt,
        updatedAt: annotation.updatedAt ?? '',
      }))
      .sort((a, b) => `${a.id}\u0000${a.createdAt}`.localeCompare(`${b.id}\u0000${b.createdAt}`)),
    evidence: [...brief.evidence]
      .filter(evidence => !isCodexDerivedEvidence(evidence.kind, evidence.provenance))
      .map(evidence => ({
        id: evidence.id,
        kind: evidence.kind,
        text: normalizeText(evidence.text),
        provenance: evidence.provenance,
        confidence: evidence.confidence,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortForStableJson(nested)]),
  );
}

function isCodexDerivedEvidence(kind: string, provenance: string): boolean {
  return kind === 'codex_resource_analysis' || provenance.toLowerCase().startsWith('codex');
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
