import { describe, expect, it } from 'vitest';
import { PublicFetchClient, PublicFetchError } from '../src/extract/publicFetchClient.js';

function okResponse(body = '<html><title>OK</title></html>', headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...headers,
    },
  });
}

describe('PublicFetchClient', () => {
  it('blocks loopback, private IPv4, private IPv6, and metadata-service URLs before fetch', async () => {
    const client = new PublicFetchClient({
      fetchImpl: async () => okResponse(),
      resolver: async () => ['93.184.216.34'],
    });

    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://[fd00::1]/',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      await expect(client.fetchText(url), url).rejects.toMatchObject({
        name: 'PublicFetchError',
        status: 'blocked_policy',
      });
    }
  });

  it('blocks DNS results that resolve to private addresses', async () => {
    const client = new PublicFetchClient({
      fetchImpl: async () => okResponse(),
      resolver: async () => ['192.168.1.44'],
    });

    await expect(client.fetchText('https://example.test/page')).rejects.toMatchObject({
      status: 'blocked_policy',
      reason: 'dns_resolved_non_public_ip',
    });
  });

  it('revalidates redirects and blocks public-to-private redirects', async () => {
    const client = new PublicFetchClient({
      resolver: async host => host === 'example.test' ? ['93.184.216.34'] : ['127.0.0.1'],
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      }),
    });

    await expect(client.fetchText('https://example.test/start')).rejects.toMatchObject({
      status: 'blocked_policy',
    });
  });

  it('does not send cookie or authorization headers', async () => {
    const seenHeaders: string[] = [];
    const client = new PublicFetchClient({
      resolver: async () => ['93.184.216.34'],
      fetchImpl: async (_url, init) => {
        seenHeaders.push(...Object.keys(init?.headers as Record<string, string>).map(key => key.toLowerCase()));
        return okResponse();
      },
    });

    await client.fetchText('https://example.test/article');

    expect(seenHeaders).not.toContain('cookie');
    expect(seenHeaders).not.toContain('authorization');
  });

  it('stops oversized responses safely', async () => {
    const client = new PublicFetchClient({
      resolver: async () => ['93.184.216.34'],
      maxResponseBytes: 8,
      fetchImpl: async () => okResponse('this response is too large'),
    });

    await expect(client.fetchText('https://example.test/large')).rejects.toMatchObject({
      status: 'blocked_size_limit',
      reason: 'response_exceeds_limit',
    });
  });

  it('turns unsupported content types into explicit statuses', async () => {
    const client = new PublicFetchClient({
      resolver: async () => ['93.184.216.34'],
      fetchImpl: async () => okResponse('%PDF-1.7', { 'content-type': 'application/pdf' }),
    });

    await expect(client.fetchText('https://example.test/file.pdf')).rejects.toMatchObject({
      status: 'not_available',
      reason: 'unsupported_content_type',
    });
  });

  it('returns bounded text metadata for allowed public responses', async () => {
    const client = new PublicFetchClient({
      resolver: async () => ['93.184.216.34'],
      fetchImpl: async () => okResponse('hello world', { 'content-length': '11' }),
    });

    const result = await client.fetchText('https://example.test/article#fragment');

    expect(result.finalUrl).toBe('https://example.test/article');
    expect(result.bytesRead).toBe(11);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses PublicFetchError for typed failures', async () => {
    const client = new PublicFetchClient({
      resolver: async () => ['93.184.216.34'],
      fetchImpl: async () => { throw new Error('network down'); },
    });

    await expect(client.fetchText('https://example.test/article')).rejects.toBeInstanceOf(PublicFetchError);
  });
});
