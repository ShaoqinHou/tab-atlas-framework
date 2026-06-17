import { normalizeUrl } from '../normalize/url.js';

export interface YouTubeMetadataArtifact {
  resourceKind: 'youtube_video' | 'youtube_short' | 'youtube_playlist';
  videoId?: string;
  playlistId?: string;
  canonicalUrl: string;
  title?: string;
  channelTitle?: string;
  durationSeconds?: number;
  descriptionText?: string;
  transcript: {
    status: 'available' | 'unavailable' | 'blocked_permission' | 'blocked_adapter_missing' | 'failed' | 'not_attempted';
    language?: string;
    provenance: 'official_owner_api' | 'optional_local_adapter' | 'manual' | 'none';
    segments: Array<{ startSeconds: number; endSeconds?: number; text: string }>;
  };
  extractionQuality: 'metadata_only' | 'description' | 'transcript_partial' | 'transcript_full';
}

export function parseYouTubeUrl(rawUrl: string): { videoId?: string; playlistId?: string; kind: YouTubeMetadataArtifact['resourceKind']; canonicalUrl: string } | null {
  const n = normalizeUrl(rawUrl);
  if (!n.kind.startsWith('youtube_')) return null;
  const kind = n.kind === 'youtube_playlist' ? 'youtube_playlist' : n.kind === 'youtube_short' ? 'youtube_short' : 'youtube_video';
  return { videoId: n.ids.videoId, playlistId: n.ids.playlistId, kind, canonicalUrl: n.canonicalUrl };
}

export function buildYouTubeMetadataOnlyArtifact(rawUrl: string, title?: string): YouTubeMetadataArtifact | null {
  const parsed = parseYouTubeUrl(rawUrl);
  if (!parsed) return null;
  return {
    resourceKind: parsed.kind,
    videoId: parsed.videoId,
    playlistId: parsed.playlistId,
    canonicalUrl: parsed.canonicalUrl,
    title,
    transcript: {
      status: 'blocked_adapter_missing',
      provenance: 'none',
      segments: [],
    },
    extractionQuality: 'metadata_only',
  };
}

// Future adapter notes:
// - Add public metadata fetch/oEmbed or YouTube Data API videos.list if configured.
// - Add official owner-caption OAuth only for videos the user controls.
// - Do not add unofficial transcript scraping without explicit opt-in and provenance.
