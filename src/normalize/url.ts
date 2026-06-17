import crypto from 'node:crypto';
import type { UrlKind } from '../shared/schemas.js';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src'
]);

export interface NormalizedUrl {
  canonicalUrl: string;
  redactedUrl: string;
  urlHash: string;
  host: string;
  kind: UrlKind;
  ids: Record<string, string>;
}

export function normalizeUrl(raw: string): NormalizedUrl {
  const u = new URL(raw);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }

  const ids: Record<string, string> = {};
  let kind: UrlKind = 'web_page';

  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const videoId = u.pathname.split('/').filter(Boolean)[0];
    if (videoId) {
      ids.videoId = videoId;
      kind = 'youtube_video';
      u.hostname = 'www.youtube.com';
      u.pathname = '/watch';
      u.search = '';
      u.searchParams.set('v', videoId);
    }
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch' && u.searchParams.get('v')) {
      ids.videoId = u.searchParams.get('v')!;
      kind = 'youtube_video';
      const keepList = u.searchParams.get('list');
      u.search = '';
      u.searchParams.set('v', ids.videoId);
      if (keepList) {
        ids.playlistId = keepList;
        u.searchParams.set('list', keepList);
      }
      u.hostname = 'www.youtube.com';
    } else if (u.pathname.startsWith('/shorts/')) {
      const videoId = u.pathname.split('/').filter(Boolean)[1];
      if (videoId) ids.videoId = videoId;
      kind = 'youtube_short';
      u.hostname = 'www.youtube.com';
    } else if (u.searchParams.get('list')) {
      ids.playlistId = u.searchParams.get('list')!;
      kind = 'youtube_playlist';
      u.hostname = 'www.youtube.com';
    }
  }

  if (host === 'github.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      ids.owner = parts[0];
      ids.repo = parts[1];
      kind = 'github_repo';
      if (parts[2] === 'issues') kind = 'github_issue';
      if (parts[2] === 'pull') kind = 'github_pull';
      if (parts[2] === 'blob' || parts[2] === 'tree') kind = 'github_file';
    }
  }

  if (u.pathname.toLowerCase().endsWith('.pdf')) kind = 'pdf';
  if (/\/login|\/signin|\/account|\/auth/i.test(u.pathname)) kind = 'login';
  if (/\/search/i.test(u.pathname) || u.searchParams.has('q')) kind = kind === 'web_page' ? 'search' : kind;

  const canonicalUrl = u.toString();
  const redactedUrl = redactUrl(canonicalUrl);
  const urlHash = crypto.createHash('sha256').update(canonicalUrl).digest('hex');
  return { canonicalUrl, redactedUrl, urlHash, host: u.hostname, kind, ids };
}

export function redactUrl(raw: string): string {
  const u = new URL(raw);
  for (const key of [...u.searchParams.keys()]) {
    if (/token|auth|code|session|key|password|email|sig|signature/i.test(key)) {
      u.searchParams.set(key, '[REDACTED]');
    }
  }
  return u.toString();
}
