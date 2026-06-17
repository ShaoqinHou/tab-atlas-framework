import type Database from 'better-sqlite3';
import { getUserAnnotations } from '../annotations/service.js';
import { ResourceBrief, type AtomicItemBrief, type UrlKind } from '../shared/schemas.js';

type ResourceRow = {
  id: string;
  canonical_url: string;
  redacted_url: string;
  url_kind: UrlKind;
  host: string;
  title_best: string | null;
};

type ArtifactRow = {
  id: string;
  artifact_kind: string;
  text_excerpt: string | null;
  json_payload: string | null;
  provenance: string;
  confidence: number;
  status: string;
};

type AtomicItemRow = {
  id: string;
  item_kind: string;
  name: string;
  summary: string | null;
  evidence_refs: string;
  confidence: number;
};

export function buildResourceBrief(db: Database.Database, resourceId: string): ResourceBrief {
  const resource = db.prepare(`
    SELECT id, canonical_url, redacted_url, url_kind, host, title_best
    FROM resources
    WHERE id = ?
  `).get(resourceId) as ResourceRow | undefined;

  if (!resource) {
    throw new Error(`Resource not found: ${resourceId}`);
  }

  const browserGroupTitles = getBrowserGroupTitles(db, resourceId);
  const userAnnotations = getUserAnnotations(db, 'resource', resourceId);
  const artifacts = getArtifacts(db, resourceId);
  const atomicItems = getAtomicItems(db, resourceId);
  const systemTags = systemTagsFor(resource.url_kind, resource.host);
  const evidence = [
    ...browserGroupTitles.map((title, index) => ({
      id: `ev_group_${shortId(resource.id)}_${index}`,
      kind: 'browser_group',
      text: title,
      provenance: 'extension_snapshot',
      confidence: 0.6,
    })),
    ...(resource.title_best ? [{
      id: `ev_title_${shortId(resource.id)}`,
      kind: 'title',
      text: resource.title_best,
      provenance: 'extension_snapshot',
      confidence: 0.45,
    }] : []),
    {
      id: `ev_url_${shortId(resource.id)}`,
      kind: 'url',
      text: resource.redacted_url,
      provenance: 'extension_snapshot',
      confidence: 0.25,
    },
    ...artifacts.map(artifact => ({
      id: artifact.id,
      kind: artifact.artifact_kind,
      text: artifact.text_excerpt ?? summarizeJsonPayload(artifact.json_payload),
      provenance: artifact.provenance,
      confidence: artifact.confidence,
    })).filter(item => item.text.length > 0),
  ];

  return ResourceBrief.parse({
    resourceId: resource.id,
    canonicalUrl: resource.canonical_url,
    redactedUrl: resource.redacted_url,
    urlKind: resource.url_kind,
    host: resource.host,
    title: resource.title_best ?? undefined,
    browserGroupTitles,
    userAnnotations,
    systemTags,
    summary: artifacts.find(artifact => artifact.text_excerpt)?.text_excerpt ?? resource.title_best ?? undefined,
    atomicItems,
    extractionStatus: extractionStatusFor(resource.url_kind, artifacts),
    evidence,
  });
}

export function buildResourceBriefs(db: Database.Database, resourceIds: string[]): ResourceBrief[] {
  return resourceIds.map(resourceId => buildResourceBrief(db, resourceId));
}

function getBrowserGroupTitles(db: Database.Database, resourceId: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT group_title
    FROM tab_observations
    WHERE resource_id = ? AND group_title IS NOT NULL AND group_title <> ''
    ORDER BY group_title
  `).all(resourceId) as { group_title: string }[];
  return rows.map(row => row.group_title);
}

function getArtifacts(db: Database.Database, resourceId: string): ArtifactRow[] {
  return db.prepare(`
    SELECT id, artifact_kind, text_excerpt, json_payload, provenance, confidence, status
    FROM extraction_artifacts
    WHERE resource_id = ?
    ORDER BY extracted_at DESC
  `).all(resourceId) as ArtifactRow[];
}

function getAtomicItems(db: Database.Database, resourceId: string): AtomicItemBrief[] {
  const rows = db.prepare(`
    SELECT id, item_kind, name, summary, evidence_refs, confidence
    FROM atomic_items
    WHERE resource_id = ?
    ORDER BY created_at DESC
  `).all(resourceId) as AtomicItemRow[];

  return rows.map(row => ({
    itemId: row.id,
    itemKind: row.item_kind,
    name: row.name,
    summary: row.summary ?? undefined,
    evidenceRefs: parseStringArray(row.evidence_refs),
    confidence: row.confidence,
  }));
}

function systemTagsFor(kind: UrlKind, host: string): string[] {
  const tags = new Set<string>([kind]);
  if (host.includes('youtube.com')) {
    tags.add('youtube');
    tags.add('video');
  }
  if (host === 'github.com') tags.add('github');
  if (kind === 'pdf') tags.add('pdf');
  if (kind === 'login' || kind === 'search') tags.add('needs_review');
  return [...tags];
}

function extractionStatusFor(kind: UrlKind, artifacts: ArtifactRow[]): ResourceBrief['extractionStatus'] {
  if (artifacts.some(artifact => artifact.status === 'complete')) return 'complete';
  if (artifacts.length > 0) return 'partial';
  if (kind.startsWith('youtube_')) return 'metadata_only';
  return 'not_started';
}

function summarizeJsonPayload(payload: string | null): string {
  if (!payload) return '';
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed === 'object' && parsed !== null && 'title' in parsed && typeof parsed.title === 'string') {
      return parsed.title;
    }
  } catch {
    return '';
  }
  return '';
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}
