import { normalizeUrl } from '../normalize/url.js';
import { buildYouTubeMetadataOnlyArtifact } from './youtube.js';

export function buildInitialArtifact(url: string, title?: string): { kind: string; payload: unknown } {
  const n = normalizeUrl(url);
  if (n.kind.startsWith('youtube_')) {
    return { kind: 'youtube.metadata', payload: buildYouTubeMetadataOnlyArtifact(url, title) };
  }
  return {
    kind: 'snapshot.metadata',
    payload: {
      title,
      canonicalUrl: n.canonicalUrl,
      redactedUrl: n.redactedUrl,
      host: n.host,
      urlKind: n.kind,
      provenance: 'extension_snapshot',
    },
  };
}
