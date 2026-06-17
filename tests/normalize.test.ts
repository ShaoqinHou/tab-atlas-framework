import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/normalize/url.js';

it('normalizes YouTube URLs and strips tracking params', () => {
  const n = normalizeUrl('https://youtu.be/dQw4w9WgXcQ?utm_source=x');
  expect(n.kind).toBe('youtube_video');
  expect(n.canonicalUrl).toContain('youtube.com/watch?v=dQw4w9WgXcQ');
  expect(n.canonicalUrl).not.toContain('utm_source');
});

describe('redaction', () => {
  it('redacts sensitive query params', () => {
    const n = normalizeUrl('https://example.com/callback?code=secret&x=1');
    expect(n.redactedUrl).toContain('code=%5BREDACTED%5D');
  });
});
