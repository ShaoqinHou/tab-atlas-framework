import { describe, expect, it } from 'vitest';
import { getGlobalDispatcher, type Dispatcher } from 'undici';
import {
  PublicFetchClient,
  PublicFetchError,
  type PinnedDispatcherFactory,
  type ValidatedPublicDestination,
} from '../src/extract/publicFetchClient.js';

function okResponse(body = '<html><title>OK</title></html>', headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...headers,
    },
  });
}

function recordingDispatcherFactory(seen: ValidatedPublicDestination[]): PinnedDispatcherFactory {
  return destination => {
    seen.push(destination);
    return {
      dispatcher: { dispatch: () => false } as unknown as Dispatcher,
      close: async () => undefined,
    };
  };
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

  it('blocks mixed public/private DNS answers before transport', async () => {
    let fetched = false;
    const client = new PublicFetchClient({
      fetchImpl: async () => {
        fetched = true;
        return okResponse();
      },
      resolver: async () => ['93.184.216.34', '127.0.0.1'],
    });

    await expect(client.fetchText('https://example.test/page')).rejects.toMatchObject({
      status: 'blocked_policy',
      reason: 'dns_resolved_non_public_ip',
    });
    expect(fetched).toBe(false);
  });

  it('pins fetch transport to the validated public address instead of resolving again', async () => {
    const seenDestinations: ValidatedPublicDestination[] = [];
    const seenFetchUrls: string[] = [];
    const client = new PublicFetchClient({
      resolver: async () => ['93.184.216.34'],
      dispatcherFactory: recordingDispatcherFactory(seenDestinations),
      fetchImpl: async (url, init) => {
        seenFetchUrls.push(url);
        expect(init?.dispatcher).toBeTruthy();
        return okResponse('public body');
      },
    });

    const result = await client.fetchText('https://example.test/article#fragment');

    expect(seenFetchUrls).toEqual(['https://example.test/article']);
    expect(seenDestinations).toHaveLength(1);
    expect(seenDestinations[0]).toMatchObject({
      originalHostname: 'example.test',
      selectedAddress: '93.184.216.34',
      addressFamily: 4,
    });
    expect(result.network).toMatchObject({
      originalHostname: 'example.test',
      connectedAddress: '93.184.216.34',
      addressFamily: 4,
      redirectCount: 0,
    });
  });

  it('records IPv6 pinned-address metadata', async () => {
    const seenDestinations: ValidatedPublicDestination[] = [];
    const client = new PublicFetchClient({
      resolver: async () => ['2606:2800:220:1:248:1893:25c8:1946'],
      dispatcherFactory: recordingDispatcherFactory(seenDestinations),
      fetchImpl: async () => okResponse('ipv6 body'),
    });

    const result = await client.fetchText('https://example.test/article');

    expect(seenDestinations[0]).toMatchObject({
      selectedAddress: '2606:2800:220:1:248:1893:25c8:1946',
      addressFamily: 6,
    });
    expect(result.network.connectedAddress).toBe('2606:2800:220:1:248:1893:25c8:1946');
    expect(result.network.addressFamily).toBe(6);
  });

  it('keeps HTTPS fetch URLs and TLS server names on the original hostname', async () => {
    const seenDestinations: ValidatedPublicDestination[] = [];
    let seenFetchUrl = '';
    const client = new PublicFetchClient({
      resolver: async () => ['93.184.216.34'],
      dispatcherFactory: recordingDispatcherFactory(seenDestinations),
      fetchImpl: async url => {
        seenFetchUrl = url;
        return okResponse('tls body');
      },
    });

    const result = await client.fetchText('https://example.test/secure');

    expect(seenFetchUrl).toBe('https://example.test/secure');
    expect(seenDestinations[0].tlsServername).toBe('example.test');
    expect(result.network.tlsServername).toBe('example.test');
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

  it('reports the final redirect hop address after revalidation', async () => {
    const seenDestinations: ValidatedPublicDestination[] = [];
    const client = new PublicFetchClient({
      dispatcherFactory: recordingDispatcherFactory(seenDestinations),
      resolver: async host => host === 'example.test'
        ? ['93.184.216.34']
        : ['142.250.190.14'],
      fetchImpl: async url => {
        if (url === 'https://example.test/start') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://redirect.test/final' },
          });
        }
        return okResponse('redirected');
      },
    });

    const result = await client.fetchText('https://example.test/start');

    expect(seenDestinations.map(destination => destination.selectedAddress)).toEqual(['93.184.216.34', '142.250.190.14']);
    expect(result.finalUrl).toBe('https://redirect.test/final');
    expect(result.network).toMatchObject({
      originalHostname: 'redirect.test',
      connectedAddress: '142.250.190.14',
      redirectCount: 1,
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
    expect(result.network.connectedAddress).toBe('93.184.216.34');
  });

  it('uses PublicFetchError for typed failures', async () => {
    const client = new PublicFetchClient({
      resolver: async () => ['93.184.216.34'],
      fetchImpl: async () => { throw new Error('network down'); },
    });

    await expect(client.fetchText('https://example.test/article')).rejects.toBeInstanceOf(PublicFetchError);
  });

  it('does not mutate the global Undici dispatcher', async () => {
    const before = getGlobalDispatcher();
    const client = new PublicFetchClient({
      resolver: async () => ['93.184.216.34'],
      fetchImpl: async () => okResponse('global dispatcher untouched'),
    });

    await client.fetchText('https://example.test/article');

    expect(getGlobalDispatcher()).toBe(before);
  });
});
