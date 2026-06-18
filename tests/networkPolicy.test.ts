import { describe, expect, it } from 'vitest';
import { safeExtractionHeaders, validatePublicHttpUrl, validateResolvedAddresses } from '../src/extract/networkPolicy.js';

describe('public extraction network policy', () => {
  it('allows ordinary public HTTP and HTTPS URLs', () => {
    expect(validatePublicHttpUrl('https://example.com/article#section')).toMatchObject({
      allowed: true,
      normalizedUrl: 'https://example.com/article',
    });
    expect(validatePublicHttpUrl('https://8.8.8.8/')).toMatchObject({ allowed: true });
  });

  it('blocks local, private, credentialed, and non-HTTP targets', () => {
    for (const url of [
      'http://localhost:9787/health',
      'http://127.0.0.1/',
      'http://10.0.0.2/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'file:///C:/Users/example/secret.txt',
      'https://user:password@example.com/',
    ]) {
      expect(validatePublicHttpUrl(url).allowed, url).toBe(false);
    }
  });

  it('rejects DNS results when any address is non-public', () => {
    expect(validateResolvedAddresses(['93.184.216.34']).allowed).toBe(true);
    expect(validateResolvedAddresses(['93.184.216.34', '127.0.0.1']).allowed).toBe(false);
    expect(validateResolvedAddresses([]).allowed).toBe(false);
  });

  it('does not add cookies or authorization headers', () => {
    const headers = safeExtractionHeaders();
    expect(Object.keys(headers)).not.toContain('cookie');
    expect(Object.keys(headers)).not.toContain('authorization');
  });
});
