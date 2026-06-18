import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type {
  ExtractionAdapter,
  ExtractionAdapterResult,
  ExtractionArtifactStatus,
  ExtractionRequest,
} from './adapterContracts.js';
import { PublicFetchClient, PublicFetchError, type PublicFetchResult } from './publicFetchClient.js';
import { EXTRACTION_RECIPES } from './runtime.js';

export interface WebPageEvidenceArtifact {
  httpStatus?: number;
  status: ExtractionArtifactStatus;
  finalUrl: string;
  contentType?: string;
  contentLength?: number;
  bytesRead?: number;
  title?: string;
  canonicalUrl?: string;
  description?: string;
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
  headings: string[];
  jsonLdSummary: string[];
  articleTextExcerpt?: string;
  language?: string;
  author?: string;
  publishedAt?: string;
  siteName?: string;
  failureReason?: string;
}

export function createGenericWebpageAdapter(
  fetchClient = new PublicFetchClient(),
  options: { maxExcerptChars?: number } = {},
): ExtractionAdapter {
  return {
    id: 'generic.public-webpage',
    version: '1.0.0',
    recipeIds: [EXTRACTION_RECIPES.genericWebpage],
    supports: request => supportsGenericWebpage(request),
    async run(request, context) {
      try {
        const fetched = await fetchClient.fetchText(request.canonicalUrl, { signal: context.signal });
        const metadata = extractWebPageEvidence(fetched, { maxExcerptChars: options.maxExcerptChars });
        return webpageResult(request, this.id, this.version, metadata, fetched.contentHash);
      } catch (error) {
        if (error instanceof PublicFetchError) {
          return webpageFailureResult(request, this.id, this.version, error);
        }
        const failure = new PublicFetchError({
          status: 'failed_parse',
          reason: error instanceof Error ? error.message : String(error),
          url: request.canonicalUrl,
        });
        return webpageFailureResult(request, this.id, this.version, failure);
      }
    },
  };
}

export async function fetchWebPageMetadata(url: string, timeoutMs = 10_000): Promise<WebPageEvidenceArtifact> {
  const fetched = await new PublicFetchClient({ timeoutMs }).fetchText(url);
  return extractWebPageEvidence(fetched);
}

export function extractWebPageEvidence(
  fetched: PublicFetchResult,
  options: { maxExcerptChars?: number } = {},
): WebPageEvidenceArtifact {
  const maxExcerptChars = options.maxExcerptChars ?? 4000;
  const dom = new JSDOM(fetched.text, {
    url: fetched.finalUrl,
    contentType: contentTypeForJsdom(fetched.contentType),
  });
  const document = dom.window.document;
  const title = cleanText(document.querySelector('title')?.textContent)
    ?? cleanText(document.querySelector('h1')?.textContent);
  const description = metaContent(document, 'name', 'description')
    ?? metaContent(document, 'property', 'og:description')
    ?? metaContent(document, 'name', 'twitter:description');
  const openGraph = collectMeta(document, 'property', /^og:/);
  const twitterCard = collectMeta(document, 'name', /^twitter:/);
  const headings = [...document.querySelectorAll('h1,h2,h3')]
    .map(node => cleanText(node.textContent))
    .filter((value): value is string => Boolean(value))
    .slice(0, 24);
  const jsonLdSummary = summarizeJsonLd(document);
  const readable = parseReadableArticle(document);
  const articleTextExcerpt = cleanText(readable?.textContent ?? sanitizedBodyText(document))?.slice(0, maxExcerptChars);
  const status: ExtractionArtifactStatus = detectsLoginPage(document) ? 'blocked_auth_required' : 'complete';

  return {
    httpStatus: fetched.statusCode,
    status,
    finalUrl: fetched.finalUrl,
    contentType: fetched.contentType,
    contentLength: fetched.contentLength,
    bytesRead: fetched.bytesRead,
    title: readable?.title ?? title,
    canonicalUrl: linkHref(document, 'canonical'),
    description,
    openGraph,
    twitterCard,
    headings,
    jsonLdSummary,
    articleTextExcerpt,
    language: document.documentElement.lang || undefined,
    author: metaContent(document, 'name', 'author') ?? readJsonLdField(document, 'author'),
    publishedAt: metaContent(document, 'property', 'article:published_time') ?? readJsonLdField(document, 'datePublished'),
    siteName: openGraph['og:site_name'] ?? readJsonLdField(document, 'publisher'),
    failureReason: status === 'blocked_auth_required' ? 'Page appears to require sign-in.' : undefined,
  };
}

function webpageResult(
  request: ExtractionRequest,
  adapterId: string,
  adapterVersion: string,
  metadata: WebPageEvidenceArtifact,
  contentHash: string,
): ExtractionAdapterResult {
  return {
    adapterId,
    status: metadata.status,
    warnings: metadata.failureReason ? [metadata.failureReason] : [],
    artifacts: [{
      resourceId: request.resourceId,
      recipeId: request.recipeId,
      artifactKind: 'generic_webpage_metadata',
      status: metadata.status,
      textExcerpt: webpageTextExcerpt(metadata),
      jsonPayload: metadata,
      confidence: metadata.status === 'complete' ? 0.78 : 0.35,
      provenance: {
        trust: 'page_derived',
        adapterId,
        adapterVersion,
        fetchedAt: new Date().toISOString(),
        sourceUrl: metadata.finalUrl,
        contentHash,
        notes: metadata.failureReason ? [metadata.failureReason] : [],
      },
    }],
  };
}

function webpageFailureResult(
  request: ExtractionRequest,
  adapterId: string,
  adapterVersion: string,
  error: PublicFetchError,
): ExtractionAdapterResult {
  const metadata: WebPageEvidenceArtifact = {
    status: error.status,
    finalUrl: error.url ?? request.canonicalUrl,
    contentType: error.contentType,
    bytesRead: error.bytesRead,
    httpStatus: error.statusCode,
    openGraph: {},
    twitterCard: {},
    headings: [],
    jsonLdSummary: [],
    failureReason: error.reason,
  };
  return {
    adapterId,
    status: error.status,
    warnings: [error.reason],
    artifacts: [{
      resourceId: request.resourceId,
      recipeId: request.recipeId,
      artifactKind: 'generic_webpage_metadata',
      status: error.status,
      textExcerpt: error.reason,
      jsonPayload: metadata,
      confidence: 0,
      provenance: {
        trust: 'page_derived',
        adapterId,
        adapterVersion,
        fetchedAt: new Date().toISOString(),
        sourceUrl: error.url ?? request.redactedUrl,
        notes: [error.reason],
      },
    }],
  };
}

function supportsGenericWebpage(request: ExtractionRequest): boolean {
  return ['web_page', 'github_repo', 'github_issue', 'github_pull', 'github_file', 'docs'].includes(request.urlKind);
}

function webpageTextExcerpt(metadata: WebPageEvidenceArtifact): string {
  return [
    metadata.title,
    metadata.siteName ? `site: ${metadata.siteName}` : '',
    metadata.description ? `description: ${metadata.description}` : '',
    metadata.author ? `author: ${metadata.author}` : '',
    metadata.publishedAt ? `published: ${metadata.publishedAt}` : '',
    metadata.headings.length ? `headings: ${metadata.headings.join(' | ')}` : '',
    metadata.jsonLdSummary.length ? `structured data: ${metadata.jsonLdSummary.join(' | ')}` : '',
    metadata.articleTextExcerpt,
    metadata.failureReason ? `failure: ${metadata.failureReason}` : '',
  ].filter(Boolean).join(' | ').slice(0, 6000);
}

function contentTypeForJsdom(contentType: string): 'text/html' | 'application/xhtml+xml' {
  return contentType.toLowerCase().includes('xhtml') ? 'application/xhtml+xml' : 'text/html';
}

function parseReadableArticle(document: Document): { title: string; textContent: string } | null {
  try {
    const parsed = new Readability(document.cloneNode(true) as Document).parse();
    if (!parsed?.textContent) return null;
    return {
      title: parsed.title ?? '',
      textContent: parsed.textContent,
    };
  } catch {
    return null;
  }
}

function collectMeta(document: Document, attr: 'name' | 'property', pattern: RegExp): Record<string, string> {
  const values: Record<string, string> = {};
  for (const element of [...document.querySelectorAll(`meta[${attr}]`)]) {
    const key = element.getAttribute(attr);
    const value = element.getAttribute('content');
    if (key && value && pattern.test(key)) values[key] = value.trim();
  }
  return values;
}

function metaContent(document: Document, attr: 'name' | 'property', value: string): string | undefined {
  const direct = document.querySelector(`meta[${attr}="${cssEscape(value)}"]`)?.getAttribute('content');
  return cleanText(direct);
}

function linkHref(document: Document, rel: string): string | undefined {
  const href = document.querySelector(`link[rel="${cssEscape(rel)}"]`)?.getAttribute('href');
  if (!href) return undefined;
  try {
    return new URL(href, document.URL).toString();
  } catch {
    return undefined;
  }
}

function summarizeJsonLd(document: Document): string[] {
  return [...document.querySelectorAll('script[type="application/ld+json"]')]
    .flatMap(script => parseJsonLd(script.textContent ?? ''))
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => summarizeStructuredData(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, 10);
}

function readJsonLdField(document: Document, field: string): string | undefined {
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')]) {
    for (const value of parseJsonLd(script.textContent ?? '').flatMap(item => Array.isArray(item) ? item : [item])) {
      const found = readStructuredField(value, field);
      if (found) return found;
    }
  }
  return undefined;
}

function parseJsonLd(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function summarizeStructuredData(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const type = readStructuredField(record, '@type');
  const name = readStructuredField(record, 'headline') ?? readStructuredField(record, 'name');
  const description = readStructuredField(record, 'description');
  return [type, name, description].filter(Boolean).join(': ').slice(0, 500) || undefined;
}

function readStructuredField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const raw = record[field];
  if (typeof raw === 'string') return cleanText(raw);
  if (typeof raw === 'object' && raw !== null) {
    const nested = raw as Record<string, unknown>;
    return readStringField(nested.name) ?? readStringField(nested.url);
  }
  return undefined;
}

function readStringField(value: unknown): string | undefined {
  return typeof value === 'string' ? cleanText(value) : undefined;
}

function detectsLoginPage(document: Document): boolean {
  if (document.querySelector('input[type="password"]')) return true;
  const text = `${document.title} ${document.body?.textContent ?? ''}`.toLowerCase();
  return /\b(sign in|log in|login required|authentication required)\b/.test(text);
}

function sanitizedBodyText(document: Document): string {
  const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
  if (!clone) return '';
  clone.querySelectorAll('script,style,noscript,template').forEach(node => node.remove());
  return clone.textContent ?? '';
}

function cleanText(value: string | null | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
