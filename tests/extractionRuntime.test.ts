import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExtractionAdapter } from '../src/extract/adapterContracts.js';
import {
  createExtractionJob,
  ExtractionAdapterRegistry,
  resumeExtractionJob,
} from '../src/extract/runtime.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { getJobSnapshot, listJobItems } from '../src/jobs/service.js';

const TEST_RECIPE = 'test.extract.v1';

function seed(dbPath = ':memory:') {
  const db = openDatabase(dbPath);
  importSnapshot(db, {
    capturedAt: '2026-06-18T00:00:00.000Z',
    tabs: [
      {
        browser: 'chrome',
        title: 'Runtime article one',
        url: 'https://example.com/one',
        groupTitle: 'Evidence',
      },
      {
        browser: 'edge',
        title: 'Runtime article two',
        url: 'https://example.com/two',
        groupTitle: 'Evidence',
      },
    ],
  }, 'test');
  const ids = (db.prepare('SELECT id FROM resources ORDER BY canonical_url').all() as { id: string }[]).map(row => row.id);
  return { db, ids };
}

function fakeAdapter(calls: string[] = []): ExtractionAdapter {
  return {
    id: 'fake.extractor',
    version: '1.0.0',
    recipeIds: [TEST_RECIPE],
    supports: () => true,
    async run(request) {
      calls.push(request.resourceId);
      return {
        adapterId: 'fake.extractor',
        status: 'complete',
        warnings: ['fixture warning'],
        artifacts: [{
          resourceId: request.resourceId,
          recipeId: request.recipeId,
          artifactKind: 'fixture_page_evidence',
          status: 'complete',
          textExcerpt: `extracted evidence for ${request.title ?? request.resourceId}`,
          jsonPayload: { title: request.title, finalUrl: request.canonicalUrl },
          confidence: 0.92,
          provenance: {
            trust: 'page_derived',
            adapterId: 'fake.extractor',
            adapterVersion: '1.0.0',
            fetchedAt: '2026-06-18T00:00:00.000Z',
            sourceUrl: request.canonicalUrl,
            contentHash: 'abc123',
            notes: [],
          },
        }],
      };
    },
  };
}

describe('typed extraction runtime', () => {
  it('marks missing adapters as adapter_disabled without crashing the job', async () => {
    const { db, ids } = seed();
    const job = createExtractionJob(db, {
      resourceIds: [ids[0]],
      recipeIds: [TEST_RECIPE],
      force: true,
    });

    const summary = await resumeExtractionJob(db, new ExtractionAdapterRegistry(), job.id, { maxItems: 5 });

    expect(summary.succeeded).toBe(1);
    expect(getJobSnapshot(db, job.id).status).toBe('succeeded');
    expect(listJobItems(db, job.id)[0].status).toBe('succeeded');
    const state = db.prepare(`
      SELECT adapter_id, status, last_error
      FROM resource_extraction_state
      WHERE resource_id = ? AND recipe_id = ?
    `).get(ids[0], TEST_RECIPE) as { adapter_id: string; status: string; last_error: string };
    expect(state.adapter_id).toBe('none');
    expect(state.status).toBe('adapter_disabled');
    expect(state.last_error).toContain('no enabled adapter');
  });

  it('rejects adapter output for the wrong resource or recipe', async () => {
    const { db, ids } = seed();
    const badAdapter: ExtractionAdapter = {
      ...fakeAdapter(),
      async run(request) {
        return {
          adapterId: 'fake.extractor',
          status: 'complete',
          warnings: [],
          artifacts: [{
            resourceId: 'res_other',
            recipeId: request.recipeId,
            artifactKind: 'bad',
            status: 'complete',
            confidence: 0.5,
            provenance: {
              trust: 'page_derived',
              adapterId: 'fake.extractor',
              adapterVersion: '1.0.0',
              fetchedAt: '2026-06-18T00:00:00.000Z',
              notes: [],
            },
          }],
        };
      },
    };
    const registry = new ExtractionAdapterRegistry().register(badAdapter);
    const job = createExtractionJob(db, { resourceIds: [ids[0]], recipeIds: [TEST_RECIPE], force: true });

    const summary = await resumeExtractionJob(db, registry, job.id, { maxItems: 1 });

    expect(summary.failed).toBe(1);
    expect(getJobSnapshot(db, job.id).status).toBe('failed');
    const state = db.prepare(`
      SELECT status, last_error
      FROM resource_extraction_state
      WHERE resource_id = ? AND recipe_id = ? AND adapter_id = ?
    `).get(ids[0], TEST_RECIPE, 'fake.extractor') as { status: string; last_error: string };
    expect(state.status).toBe('failed_adapter');
    expect(state.last_error).toContain('another resource');
  });

  it('persists artifacts, state, provenance, and FTS text', async () => {
    const { db, ids } = seed();
    const registry = new ExtractionAdapterRegistry().register(fakeAdapter());
    const job = createExtractionJob(db, { resourceIds: [ids[0]], recipeIds: [TEST_RECIPE], force: true });

    await resumeExtractionJob(db, registry, job.id, { maxItems: 1 });

    const artifact = db.prepare(`
      SELECT artifact_kind, text_excerpt, provenance, confidence, status
      FROM extraction_artifacts
      WHERE resource_id = ? AND recipe_id = ?
    `).get(ids[0], TEST_RECIPE) as { artifact_kind: string; text_excerpt: string; provenance: string; confidence: number; status: string };
    const provenance = JSON.parse(artifact.provenance) as { adapterId: string; adapterVersion: string; trust: string; warnings: string[] };
    expect(artifact.artifact_kind).toBe('fixture_page_evidence');
    expect(artifact.text_excerpt).toContain('extracted evidence');
    expect(artifact.confidence).toBe(0.92);
    expect(artifact.status).toBe('complete');
    expect(provenance).toMatchObject({
      adapterId: 'fake.extractor',
      adapterVersion: '1.0.0',
      trust: 'page_derived',
    });
    expect(provenance.warnings).toContain('fixture warning');

    const fts = db.prepare(`
      SELECT resource_id
      FROM resource_fts
      WHERE resource_id = ? AND extracted_text MATCH 'extracted'
    `).all(ids[0]) as { resource_id: string }[];
    expect(fts).toHaveLength(1);
  });

  it('survives restart and does not repeat completed items', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-extract-test-'));
    const dbPath = path.join(dir, 'tabatlas.sqlite');
    const first = seed(dbPath);
    const firstCalls: string[] = [];
    const firstRegistry = new ExtractionAdapterRegistry().register(fakeAdapter(firstCalls));
    const job = createExtractionJob(first.db, {
      resourceIds: first.ids,
      recipeIds: [TEST_RECIPE],
      force: true,
    });

    await resumeExtractionJob(first.db, firstRegistry, job.id, { maxItems: 1 });
    expect(firstCalls).toHaveLength(1);
    first.db.close();

    const reopened = openDatabase(dbPath);
    const secondCalls: string[] = [];
    const secondRegistry = new ExtractionAdapterRegistry().register(fakeAdapter(secondCalls));
    await resumeExtractionJob(reopened, secondRegistry, job.id, { maxItems: 5 });

    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0]).not.toBe(firstCalls[0]);
    expect(getJobSnapshot(reopened, job.id).status).toBe('succeeded');
    expect(listJobItems(reopened, job.id).map(item => item.status)).toEqual(['succeeded', 'succeeded']);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
