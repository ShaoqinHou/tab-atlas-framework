import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { safeExtractionHeaders, validatePublicHttpUrl, validateResolvedAddresses } from './networkPolicy.js';
import type { ExtractionArtifactStatus } from './adapterContracts.js';

export type PublicFetchStatus =
  | 'blocked_policy'
  | 'blocked_size_limit'
  | 'blocked_auth_required'
  | 'failed_network'
  | 'not_available';

export interface PublicFetchResult {
  finalUrl: string;
  statusCode: number;
  contentType: string;
  contentLength?: number;
  bytesRead: number;
  text: string;
  contentHash: string;
}

export interface PublicFetchClientOptions {
  fetchImpl?: typeof fetch;
  resolver?: (hostname: string) => Promise<string[]>;
  limiter?: PerHostLimiter;
  maxRedirects?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  allowedContentTypes?: string[];
  userAgent?: string;
}

export class PublicFetchError extends Error {
  readonly status: ExtractionArtifactStatus;
  readonly reason: string;
  readonly url?: string;
  readonly statusCode?: number;
  readonly contentType?: string;
  readonly bytesRead?: number;

  constructor(input: {
    status: ExtractionArtifactStatus;
    reason: string;
    message?: string;
    url?: string;
    statusCode?: number;
    contentType?: string;
    bytesRead?: number;
  }) {
    super(input.message ?? input.reason);
    this.name = 'PublicFetchError';
    this.status = input.status;
    this.reason = input.reason;
    this.url = input.url;
    this.statusCode = input.statusCode;
    this.contentType = input.contentType;
    this.bytesRead = input.bytesRead;
  }
}

export class PerHostLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Array<() => void>>();

  constructor(readonly maxPerHost = 2) {}

  async run<T>(host: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(host);
    try {
      return await task();
    } finally {
      this.release(host);
    }
  }

  private async acquire(host: string): Promise<void> {
    const active = this.active.get(host) ?? 0;
    if (active < this.maxPerHost) {
      this.active.set(host, active + 1);
      return;
    }
    await new Promise<void>(resolve => {
      const queue = this.queues.get(host) ?? [];
      queue.push(resolve);
      this.queues.set(host, queue);
    });
    this.active.set(host, (this.active.get(host) ?? 0) + 1);
  }

  private release(host: string): void {
    const active = Math.max(0, (this.active.get(host) ?? 1) - 1);
    if (active === 0) this.active.delete(host);
    else this.active.set(host, active);
    const queue = this.queues.get(host);
    const next = queue?.shift();
    if (!queue?.length) this.queues.delete(host);
    next?.();
  }
}

export class PublicFetchClient {
  private readonly fetchImpl: typeof fetch;
  private readonly resolver: (hostname: string) => Promise<string[]>;
  private readonly limiter: PerHostLimiter;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;
  private readonly allowedContentTypes: string[];
  private readonly userAgent: string;

  constructor(options: PublicFetchClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolver = options.resolver ?? defaultResolver;
    this.limiter = options.limiter ?? new PerHostLimiter(2);
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.allowedContentTypes = options.allowedContentTypes ?? [
      'text/html',
      'application/xhtml+xml',
      'text/plain',
      'application/json',
      'application/ld+json',
    ];
    this.userAgent = options.userAgent ?? 'TabAtlas/0.1 local evidence extractor';
  }

  async fetchText(rawUrl: string, options: { signal?: AbortSignal } = {}): Promise<PublicFetchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      return await this.fetchTextWithRedirects(rawUrl, controller.signal);
    } catch (error) {
      if (error instanceof PublicFetchError) throw error;
      if (controller.signal.aborted) {
        throw new PublicFetchError({ status: 'failed_network', reason: 'timeout_or_cancelled', url: rawUrl });
      }
      throw new PublicFetchError({
        status: 'failed_network',
        reason: 'fetch_failed',
        message: error instanceof Error ? error.message : 'fetch failed',
        url: rawUrl,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  private async fetchTextWithRedirects(rawUrl: string, signal: AbortSignal): Promise<PublicFetchResult> {
    let current = await this.validateUrlAndDns(rawUrl);
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const url = new URL(current);
      const response = await this.limiter.run(url.hostname, async () => this.fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: safeExtractionHeaders(this.userAgent),
      }));

      if (isRedirect(response.status)) {
        if (redirectCount >= this.maxRedirects) {
          throw new PublicFetchError({ status: 'blocked_policy', reason: 'too_many_redirects', url: current, statusCode: response.status });
        }
        const location = response.headers.get('location');
        if (!location) {
          throw new PublicFetchError({ status: 'failed_network', reason: 'redirect_without_location', url: current, statusCode: response.status });
        }
        current = await this.validateUrlAndDns(new URL(location, current).toString());
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      const contentLength = parseContentLength(response.headers.get('content-length'));
      if (response.status === 401 || response.status === 403) {
        throw new PublicFetchError({
          status: 'blocked_auth_required',
          reason: 'auth_required',
          url: current,
          statusCode: response.status,
          contentType,
        });
      }
      if (!isAllowedContentType(contentType, this.allowedContentTypes)) {
        throw new PublicFetchError({
          status: 'not_available',
          reason: 'unsupported_content_type',
          url: current,
          statusCode: response.status,
          contentType,
        });
      }
      if (contentLength !== undefined && contentLength > this.maxResponseBytes) {
        throw new PublicFetchError({
          status: 'blocked_size_limit',
          reason: 'content_length_exceeds_limit',
          url: current,
          statusCode: response.status,
          contentType,
          bytesRead: 0,
        });
      }

      const body = await readBoundedResponse(response, this.maxResponseBytes);
      return {
        finalUrl: current,
        statusCode: response.status,
        contentType,
        contentLength,
        bytesRead: body.bytesRead,
        text: body.text,
        contentHash: crypto.createHash('sha256').update(body.bytes).digest('hex'),
      };
    }

    throw new PublicFetchError({ status: 'blocked_policy', reason: 'too_many_redirects', url: current });
  }

  private async validateUrlAndDns(rawUrl: string): Promise<string> {
    const decision = validatePublicHttpUrl(rawUrl);
    if (!decision.allowed || !decision.normalizedUrl) {
      throw new PublicFetchError({ status: 'blocked_policy', reason: decision.reason ?? 'blocked_url', url: rawUrl });
    }

    const url = new URL(decision.normalizedUrl);
    const ipLiteral = stripIpv6Brackets(url.hostname);
    const addresses = net.isIP(ipLiteral) ? [ipLiteral] : await this.resolver(url.hostname);
    const dnsDecision = validateResolvedAddresses(addresses);
    if (!dnsDecision.allowed) {
      throw new PublicFetchError({
        status: 'blocked_policy',
        reason: dnsDecision.reason ?? 'blocked_resolved_address',
        url: decision.normalizedUrl,
      });
    }

    return decision.normalizedUrl;
  }
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map(row => row.address);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAllowedContentType(contentType: string, allowed: string[]): boolean {
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  if (!normalized) return true;
  return allowed.includes(normalized) || normalized.endsWith('+json');
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<{ bytes: Buffer; text: string; bytesRead: number }> {
  if (!response.body) return { bytes: Buffer.alloc(0), text: '', bytesRead: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new PublicFetchError({
        status: 'blocked_size_limit',
        reason: 'response_exceeds_limit',
        url: response.url,
        statusCode: response.status,
        contentType: response.headers.get('content-type') ?? undefined,
        bytesRead,
      });
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  return { bytes, text: bytes.toString('utf8'), bytesRead };
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}
