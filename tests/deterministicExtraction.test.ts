import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { runDeterministicExtraction } from '../src/extract/deterministic.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';

function seedExtractionFixture() {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-17T00:00:00.000Z',
    tabs: [
      {
        browser: 'chrome',
        title: 'Procedural level design talk',
        url: 'https://www.youtube.com/watch?v=abc123def45&list=PL1',
        groupTitle: 'Game Ideas',
      },
      {
        browser: 'edge',
        title: 'SQLite FTS5 docs',
        url: 'https://sqlite.org/fts5.html?utm_source=test',
        groupTitle: 'Local app',
      },
    ],
  }, 'test');
  return db;
}

describe('deterministic extraction', () => {
  it('writes idempotent local artifacts and refreshes extracted FTS text', () => {
    const db = seedExtractionFixture();
    const first = runDeterministicExtraction(db);
    const second = runDeterministicExtraction(db);

    expect(first.resourcesProcessed).toBe(2);
    expect(first.artifactsWritten).toBe(4);
    expect(second.artifactsWritten).toBe(4);

    const artifactCount = db.prepare('SELECT COUNT(*) AS count FROM extraction_artifacts').get() as { count: number };
    expect(artifactCount.count).toBe(4);

    const ftsRows = db.prepare(`
      SELECT resource_id
      FROM resource_fts
      WHERE extracted_text MATCH 'transcript'
    `).all() as { resource_id: string }[];
    expect(ftsRows.length).toBe(1);
  });

  it('keeps YouTube transcript status explicit and never claims transcript content', () => {
    const db = seedExtractionFixture();
    runDeterministicExtraction(db);

    const row = db.prepare(`
      SELECT json_payload, text_excerpt, status
      FROM extraction_artifacts
      WHERE recipe_id = 'youtube_url_metadata_stub.v1'
    `).get() as { json_payload: string; text_excerpt: string; status: string };
    const payload = JSON.parse(row.json_payload) as { videoId: string; playlistId: string; transcriptStatus: string; transcriptReason: string };

    expect(row.status).toBe('metadata_only');
    expect(payload.videoId).toBe('abc123def45');
    expect(payload.playlistId).toBe('PL1');
    expect(payload.transcriptStatus).toBe('not_attempted');
    expect(payload.transcriptReason).toContain('not assumed available');
    expect(row.text_excerpt).not.toContain('transcript excerpt');
  });

  it('writes generic local metadata stubs for non-YouTube pages', () => {
    const db = seedExtractionFixture();
    runDeterministicExtraction(db);

    const row = db.prepare(`
      SELECT json_payload
      FROM extraction_artifacts
      WHERE recipe_id = 'generic_page_metadata_stub.v1'
    `).get() as { json_payload: string };
    const payload = JSON.parse(row.json_payload) as { host: string; urlKind: string; browserGroupTitles: string[]; fetchStatus: string };

    expect(payload.host).toBe('sqlite.org');
    expect(payload.urlKind).toBe('web_page');
    expect(payload.browserGroupTitles).toContain('Local app');
    expect(payload.fetchStatus).toBe('not_attempted');
  });
});
