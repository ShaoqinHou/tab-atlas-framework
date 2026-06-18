import { describe, expect, it } from 'vitest';
import {
  createExtractionJob,
  ExtractionAdapterRegistry,
  EXTRACTION_RECIPES,
  resumeExtractionJob,
} from '../src/extract/runtime.js';
import { createGenericWebpageAdapter } from '../src/extract/webpage.js';
import { PublicFetchClient } from '../src/extract/publicFetchClient.js';
import type { ExtractionRequest } from '../src/extract/adapterContracts.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';

function request(url = 'https://example.test/article'): ExtractionRequest {
  return {
    resourceId: 'res_1',
    canonicalUrl: url,
    redactedUrl: url,
    urlKind: 'web_page',
    title: 'Snapshot title',
    recipeId: EXTRACTION_RECIPES.genericWebpage,
    dependencyHash: 'hash',
  };
}

function context() {
  return {
    signal: new AbortController().signal,
    scratchDirectory: process.cwd(),
    maxResponseBytes: 1_000_000,
    timeoutMs: 1000,
  };
}

function response(body: string | null, init: ResponseInit = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

function adapterFor(routes: Record<string, Response>, options: { maxResponseBytes?: number } = {}) {
  const client = new PublicFetchClient({
    resolver: async () => ['93.184.216.34'],
    maxResponseBytes: options.maxResponseBytes,
    fetchImpl: async url => {
      const key = url.toString();
      const routed = routes[key];
      if (!routed) throw new Error(`No route for ${key}`);
      return routed;
    },
  });
  return createGenericWebpageAdapter(client);
}

describe('generic webpage extraction', () => {
  it('extracts normal article metadata and readable text', async () => {
    const adapter = adapterFor({
      'https://example.test/article': response(`
        <!doctype html>
        <html lang="en">
          <head>
            <title>Article Title</title>
            <link rel="canonical" href="/canonical-article">
            <meta name="description" content="A concise article description.">
            <meta name="author" content="Ada Writer">
          </head>
          <body>
            <article>
              <h1>Article Heading</h1>
              <h2>Section One</h2>
              <p>This is a useful public article about inventory UI and game inspiration.</p>
            </article>
          </body>
        </html>
      `),
    });

    const result = await adapter.run(request(), context());
    const payload = result.artifacts[0].jsonPayload as {
      title: string;
      canonicalUrl: string;
      description: string;
      headings: string[];
      articleTextExcerpt: string;
      language: string;
      author: string;
    };

    expect(result.status).toBe('complete');
    expect(payload.title).toBe('Article Title');
    expect(payload.canonicalUrl).toBe('https://example.test/canonical-article');
    expect(payload.description).toBe('A concise article description.');
    expect(payload.headings).toContain('Section One');
    expect(payload.articleTextExcerpt).toContain('inventory UI');
    expect(payload.language).toBe('en');
    expect(payload.author).toBe('Ada Writer');
  });

  it('extracts Open Graph and Twitter-card metadata', async () => {
    const adapter = adapterFor({
      'https://example.test/og': response(`
        <html><head>
          <meta property="og:title" content="OG Title">
          <meta property="og:site_name" content="Example Site">
          <meta property="og:description" content="Open graph description.">
          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:title" content="Twitter Title">
        </head><body><main>Body text</main></body></html>
      `),
    });

    const result = await adapter.run(request('https://example.test/og'), context());
    const payload = result.artifacts[0].jsonPayload as {
      openGraph: Record<string, string>;
      twitterCard: Record<string, string>;
      siteName: string;
      description: string;
    };

    expect(payload.openGraph['og:title']).toBe('OG Title');
    expect(payload.twitterCard['twitter:card']).toBe('summary_large_image');
    expect(payload.siteName).toBe('Example Site');
    expect(payload.description).toBe('Open graph description.');
  });

  it('summarizes JSON-LD article metadata', async () => {
    const adapter = adapterFor({
      'https://example.test/jsonld': response(`
        <html><head>
          <script type="application/ld+json">
            {
              "@type": "Article",
              "headline": "Structured Article",
              "description": "JSON-LD summary text",
              "author": { "name": "Structured Author" },
              "publisher": { "name": "Structured Publisher" },
              "datePublished": "2026-06-01"
            }
          </script>
        </head><body><article><h1>Structured Article</h1><p>Readable text.</p></article></body></html>
      `),
    });

    const result = await adapter.run(request('https://example.test/jsonld'), context());
    const payload = result.artifacts[0].jsonPayload as {
      jsonLdSummary: string[];
      author: string;
      publishedAt: string;
      siteName: string;
    };

    expect(payload.jsonLdSummary[0]).toContain('Article');
    expect(payload.jsonLdSummary[0]).toContain('Structured Article');
    expect(payload.author).toBe('Structured Author');
    expect(payload.publishedAt).toBe('2026-06-01');
    expect(payload.siteName).toBe('Structured Publisher');
  });

  it('marks login pages as blocked_auth_required', async () => {
    const adapter = adapterFor({
      'https://example.test/login': response(`
        <html><head><title>Sign in</title></head><body>
          <form><input type="password" name="password"></form>
        </body></html>
      `),
    });

    const result = await adapter.run(request('https://example.test/login'), context());

    expect(result.status).toBe('blocked_auth_required');
    expect(result.artifacts[0].status).toBe('blocked_auth_required');
    expect(result.warnings[0]).toContain('sign-in');
  });

  it('turns oversized pages into blocked_size_limit', async () => {
    const adapter = adapterFor({
      'https://example.test/large': response('x'.repeat(200)),
    }, { maxResponseBytes: 16 });

    const result = await adapter.run(request('https://example.test/large'), context());

    expect(result.status).toBe('blocked_size_limit');
    expect(result.artifacts[0].jsonPayload).toMatchObject({ failureReason: 'response_exceeds_limit' });
  });

  it('handles malformed HTML without executing scripts', async () => {
    const adapter = adapterFor({
      'https://example.test/broken': response('<html><head><title>Broken</title></head><body><h1>Still readable<script>window.evil=1</script>'),
    });

    const result = await adapter.run(request('https://example.test/broken'), context());
    const payload = result.artifacts[0].jsonPayload as { headings: string[]; articleTextExcerpt: string };

    expect(result.status).toBe('complete');
    expect(payload.articleTextExcerpt).toContain('Still readable');
    expect(payload.articleTextExcerpt).not.toContain('window.evil');
  });

  it('follows safe redirects and records the final URL', async () => {
    const adapter = adapterFor({
      'https://example.test/start': new Response(null, { status: 302, headers: { location: 'https://example.test/final' } }),
      'https://example.test/final': response('<html><head><title>Final</title></head><body><article>Redirect target</article></body></html>'),
    });

    const result = await adapter.run(request('https://example.test/start'), context());
    const payload = result.artifacts[0].jsonPayload as { finalUrl: string; title: string };

    expect(result.status).toBe('complete');
    expect(payload.finalUrl).toBe('https://example.test/final');
    expect(payload.title).toBe('Final');
  });

  it('turns unsupported binary content into not_available', async () => {
    const adapter = adapterFor({
      'https://example.test/file.bin': response('binary', { headers: { 'content-type': 'application/octet-stream' } }),
    });

    const result = await adapter.run(request('https://example.test/file.bin'), context());

    expect(result.status).toBe('not_available');
    expect(result.artifacts[0].jsonPayload).toMatchObject({ failureReason: 'unsupported_content_type' });
  });

  it('runs through the durable extraction runtime and persists webpage artifacts', async () => {
    const db = openDatabase(':memory:');
    importSnapshot(db, {
      capturedAt: '2026-06-18T00:00:00.000Z',
      tabs: [{
        browser: 'chrome',
        title: 'Article',
        url: 'https://example.test/runtime',
      }],
    }, 'test');
    const row = db.prepare('SELECT id FROM resources').get() as { id: string };
    const registry = new ExtractionAdapterRegistry().register(adapterFor({
      'https://example.test/runtime': response('<html><head><title>Runtime Page</title></head><body><article>Runtime extracted evidence.</article></body></html>'),
    }));
    const job = createExtractionJob(db, {
      resourceIds: [row.id],
      recipeIds: [EXTRACTION_RECIPES.genericWebpage],
      force: true,
    });

    await resumeExtractionJob(db, registry, job.id, { maxItems: 1 });

    const artifact = db.prepare(`
      SELECT artifact_kind, text_excerpt, status
      FROM extraction_artifacts
      WHERE resource_id = ? AND recipe_id = ?
    `).get(row.id, EXTRACTION_RECIPES.genericWebpage) as { artifact_kind: string; text_excerpt: string; status: string };
    expect(artifact.artifact_kind).toBe('generic_webpage_metadata');
    expect(artifact.text_excerpt).toContain('Runtime Page');
    expect(artifact.status).toBe('complete');
  });
});
