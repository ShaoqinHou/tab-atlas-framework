import type Database from 'better-sqlite3';
import { normalizeUrl } from '../normalize/url.js';
import { refreshResourceSearchText } from '../resources/searchIndex.js';

export const EXTRACTION_RECIPES = {
  snapshot: 'title_url_snapshot.v1',
  youtube: 'youtube_url_metadata_stub.v1',
  generic: 'generic_page_metadata_stub.v1',
} as const;

type ResourceRow = {
  id: string;
  canonical_url: string;
  redacted_url: string;
  url_kind: string;
  host: string;
  title_best: string | null;
};

type GroupRow = {
  group_title: string;
};

export interface ExtractionRunResult {
  resourcesProcessed: number;
  artifactsWritten: number;
}

export function runDeterministicExtraction(db: Database.Database, resourceIds?: string[]): ExtractionRunResult {
  const resources = selectResources(db, resourceIds);
  let artifactsWritten = 0;
  const tx = db.transaction(() => {
    for (const resource of resources) {
      artifactsWritten += extractResource(db, resource);
      refreshResourceSearchText(db, resource.id);
    }
  });
  tx();
  return { resourcesProcessed: resources.length, artifactsWritten };
}

function extractResource(db: Database.Database, resource: ResourceRow): number {
  const groupTitles = getGroupTitles(db, resource.id);
  const snapshotText = [
    resource.title_best,
    resource.host,
    resource.url_kind,
    groupTitles.length ? `groups: ${groupTitles.join(', ')}` : '',
    resource.redacted_url,
  ].filter(Boolean).join(' | ');

  upsertArtifact(db, {
    resourceId: resource.id,
    recipeId: EXTRACTION_RECIPES.snapshot,
    artifactKind: 'snapshot_metadata',
    textExcerpt: snapshotText,
    jsonPayload: {
      title: resource.title_best,
      host: resource.host,
      urlKind: resource.url_kind,
      browserGroupTitles: groupTitles,
      redactedUrl: resource.redacted_url,
    },
    sourceUrl: resource.redacted_url,
    provenance: 'extension_snapshot',
    confidence: 0.45,
    status: 'complete',
  });

  if (resource.url_kind.startsWith('youtube_')) {
    const parsed = normalizeUrl(resource.canonical_url);
    upsertArtifact(db, {
      resourceId: resource.id,
      recipeId: EXTRACTION_RECIPES.youtube,
      artifactKind: 'youtube_metadata_stub',
      textExcerpt: [
        resource.title_best,
        parsed.ids.videoId ? `video ${parsed.ids.videoId}` : '',
        parsed.ids.playlistId ? `playlist ${parsed.ids.playlistId}` : '',
        'transcript not attempted',
      ].filter(Boolean).join(' | '),
      jsonPayload: {
        videoId: parsed.ids.videoId,
        playlistId: parsed.ids.playlistId,
        transcriptStatus: 'not_attempted',
        transcriptReason: 'Official arbitrary public transcript download is not assumed available.',
      },
      sourceUrl: resource.redacted_url,
      provenance: 'url_parser',
      confidence: 0.5,
      status: 'metadata_only',
    });
    return 2;
  }

  upsertArtifact(db, {
    resourceId: resource.id,
    recipeId: EXTRACTION_RECIPES.generic,
    artifactKind: 'generic_page_metadata_stub',
    textExcerpt: snapshotText,
    jsonPayload: {
      title: resource.title_best,
      host: resource.host,
      urlKind: resource.url_kind,
      browserGroupTitles: groupTitles,
      redactedUrl: resource.redacted_url,
      fetchStatus: 'not_attempted',
    },
    sourceUrl: resource.redacted_url,
    provenance: 'local_snapshot',
    confidence: 0.45,
    status: 'metadata_only',
  });
  return 2;
}

function selectResources(db: Database.Database, resourceIds?: string[]): ResourceRow[] {
  if (resourceIds?.length) {
    return db.prepare(`
      SELECT id, canonical_url, redacted_url, url_kind, host, title_best
      FROM resources
      WHERE id IN (${resourceIds.map(() => '?').join(', ')})
      ORDER BY last_seen_at DESC
    `).all(...resourceIds) as ResourceRow[];
  }
  return db.prepare(`
    SELECT id, canonical_url, redacted_url, url_kind, host, title_best
    FROM resources
    ORDER BY last_seen_at DESC
  `).all() as ResourceRow[];
}

function getGroupTitles(db: Database.Database, resourceId: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT group_title
    FROM tab_observations
    WHERE resource_id = ? AND group_title IS NOT NULL AND group_title <> ''
    ORDER BY group_title
  `).all(resourceId) as GroupRow[];
  return rows.map(row => row.group_title);
}

function upsertArtifact(db: Database.Database, input: {
  resourceId: string;
  recipeId: string;
  artifactKind: string;
  textExcerpt: string;
  jsonPayload: unknown;
  sourceUrl: string;
  provenance: string;
  confidence: number;
  status: string;
}): void {
  const id = `art_${input.resourceId}_${input.recipeId.replace(/[^a-z0-9]+/gi, '_')}`;
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
    input.resourceId,
    input.recipeId,
    input.artifactKind,
    input.textExcerpt,
    JSON.stringify(input.jsonPayload),
    input.sourceUrl,
    input.provenance,
    input.confidence,
    input.status,
    new Date().toISOString(),
  );
}
