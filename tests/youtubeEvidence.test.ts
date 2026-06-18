import { describe, expect, it } from 'vitest';
import { resumeCodexScanJob, createCodexScanJob } from '../src/agent/scanService.js';
import { computeResourceKnowledgeDependencyHash } from '../src/knowledge/dependencyHash.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';
import { buildResourceBrief } from '../src/resources/briefs.js';
import type { LlmProvider } from '../src/llm/types.js';
import {
  buildYtDlpMetadataArgs,
  createYouTubeOfficialMetadataAdapter,
  fetchYouTubeVideoMetadataBatch,
  importManualYouTubeTranscript,
  isDetailedAtomicItemSupportedByEvidence,
  mapYouTubeDataApiItem,
  selectYtDlpTranscript,
} from '../src/extract/youtube.js';

function youtubeFixture() {
  const db = openDatabase(':memory:');
  importSnapshot(db, {
    capturedAt: '2026-06-18T00:00:00.000Z',
    tabs: [{
      browser: 'chrome',
      title: 'Dense AI papers video',
      url: 'https://www.youtube.com/watch?v=abc123def45',
      groupTitle: 'Watch',
    }],
  }, 'test');
  const row = db.prepare('SELECT id FROM resources').get() as { id: string };
  return { db, resourceId: row.id };
}

describe('standardized YouTube evidence', () => {
  it('maps official metadata fixture fields', () => {
    const metadata = mapYouTubeDataApiItem({
      id: 'abc123def45',
      snippet: {
        title: 'Inventory UI Design',
        channelId: 'chan_1',
        channelTitle: 'Design Channel',
        description: '0:00 Intro\n01:12 Inventory layout\nSee https://example.com/ref',
        publishedAt: '2026-01-02T03:04:05Z',
        thumbnails: { high: { url: 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg' } },
        tags: ['game ui', 'inventory'],
      },
      contentDetails: { duration: 'PT1H2M3S' },
    });

    expect(metadata).toMatchObject({
      videoId: 'abc123def45',
      title: 'Inventory UI Design',
      channelId: 'chan_1',
      channelTitle: 'Design Channel',
      durationSeconds: 3723,
      extractionQuality: 'description',
    });
    expect(metadata?.chapters[1]).toEqual({ startSeconds: 72, title: 'Inventory layout' });
    expect(metadata?.linksMentioned).toContain('https://example.com/ref');
    expect(metadata?.transcript.status).toBe('not_attempted');
  });

  it('batches multiple video IDs into one official API request', async () => {
    const seenUrls: string[] = [];
    const result = await fetchYouTubeVideoMetadataBatch(['videoA', 'videoB'], {
      apiKey: 'test-key',
      apiBaseUrl: 'https://youtube.test/videos',
      fetchImpl: async url => {
        seenUrls.push(url.toString());
        return new Response(JSON.stringify({
          items: [
            { id: 'videoA', snippet: { title: 'A' }, contentDetails: { duration: 'PT1M' } },
            { id: 'videoB', snippet: { title: 'B' }, contentDetails: { duration: 'PT2M' } },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    expect(seenUrls).toHaveLength(1);
    expect(new URL(seenUrls[0]).searchParams.get('id')).toBe('videoA,videoB');
    expect(result.status).toBe('complete');
    expect(result.videos.get('videoB')?.durationSeconds).toBe(120);
  });

  it('returns adapter_disabled when the official API key is unavailable', async () => {
    const previous = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    const adapter = createYouTubeOfficialMetadataAdapter({ officialDataApi: { enabled: true, apiKeyEnvironmentVariable: 'YOUTUBE_API_KEY' } });
    const result = await adapter.run({
      resourceId: 'res_1',
      canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
      redactedUrl: 'https://www.youtube.com/watch?v=abc123def45',
      urlKind: 'youtube_video',
      title: 'Test video',
      recipeId: 'youtube_standard_evidence.v1',
      dependencyHash: 'hash',
    }, {
      signal: new AbortController().signal,
      scratchDirectory: process.cwd(),
      maxResponseBytes: 1000,
      timeoutMs: 1000,
    });
    if (previous === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = previous;

    expect(result.status).toBe('adapter_disabled');
    expect(result.warnings[0]).toContain('missing YouTube API key');
  });

  it('builds yt-dlp metadata args that skip media downloads', () => {
    const args = buildYtDlpMetadataArgs('https://www.youtube.com/watch?v=abc123def45', {
      localYtDlp: {
        enabled: true,
        executable: 'yt-dlp',
        allowAutomaticCaptions: true,
        preferredLanguages: ['en', 'ja'],
      },
    });

    expect(args).toContain('--skip-download');
    expect(args).toContain('--write-auto-sub');
    expect(args).not.toContain('--extract-audio');
    expect(args).not.toContain('--format');
    expect(args).not.toContain('-f');
  });

  it('distinguishes manual subtitles from automatic subtitles', () => {
    const manual = selectYtDlpTranscript({
      subtitles: {
        en: [{ segments: [{ start: 0, duration: 1.5, text: 'Manual line' }] }],
      },
      automatic_captions: {
        en: [{ segments: [{ start: 0, duration: 1.5, text: 'Auto line' }] }],
      },
    }, { localYtDlp: { enabled: true, executable: 'yt-dlp', allowAutomaticCaptions: true, preferredLanguages: ['en'] } });
    const automatic = selectYtDlpTranscript({
      subtitles: {},
      automatic_captions: {
        en: [{ segments: [{ start: 0, duration: 1.5, text: 'Auto line' }] }],
      },
    }, { localYtDlp: { enabled: true, executable: 'yt-dlp', allowAutomaticCaptions: true, preferredLanguages: ['en'] } });

    expect(manual.status).toBe('available_artifact');
    expect(manual.isAutoGenerated).toBe(false);
    expect(automatic.status).toBe('available_artifact');
    expect(automatic.isAutoGenerated).toBe(true);
  });

  it('keeps transcript unavailable explicit', () => {
    const transcript = selectYtDlpTranscript({ subtitles: {}, automatic_captions: {} }, {
      localYtDlp: { enabled: true, executable: 'yt-dlp', allowAutomaticCaptions: true, preferredLanguages: ['en'] },
    });

    expect(transcript.status).toBe('not_available');
    expect(transcript.failureReason).toContain('No matching subtitle');
  });

  it('stores manual transcript import with user provenance', () => {
    const { db, resourceId } = youtubeFixture();
    const result = importManualYouTubeTranscript(db, {
      resourceId,
      language: 'en',
      plainText: 'This transcript mentions forest level moodboards and inventory UI.',
    });

    const row = db.prepare(`
      SELECT provenance, json_payload
      FROM extraction_artifacts
      WHERE id = ?
    `).get(result.artifactId) as { provenance: string; json_payload: string };
    const provenance = JSON.parse(row.provenance) as { trust: string; adapterId: string };
    const payload = JSON.parse(row.json_payload) as { transcript: { status: string; provenance: string; language: string; plainText: string } };

    expect(provenance.trust).toBe('user_authored');
    expect(provenance.adapterId).toBe('youtube.manual-transcript');
    expect(payload.transcript.status).toBe('available_artifact');
    expect(payload.transcript.provenance).toBe('manual_paste');
    expect(payload.transcript.language).toBe('en');
  });

  it('rejects detailed atomic items when YouTube evidence is title-only', () => {
    const supported = isDetailedAtomicItemSupportedByEvidence({
      urlKind: 'youtube_video',
      title: 'Interesting AI video',
      evidenceRefs: ['ev_title_1'],
      evidence: [{ id: 'ev_title_1', kind: 'title', text: 'Interesting AI video', provenance: 'extension_snapshot' }],
    });

    expect(supported).toBe(false);
  });

  it('manual transcript changes invalidate the Codex knowledge hash', () => {
    const { db, resourceId } = youtubeFixture();
    const before = computeResourceKnowledgeDependencyHash(buildResourceBrief(db, resourceId));
    importManualYouTubeTranscript(db, {
      resourceId,
      plainText: 'New transcript with detailed paper list and game UI notes.',
      language: 'en',
    });
    const after = computeResourceKnowledgeDependencyHash(buildResourceBrief(db, resourceId));

    expect(after).not.toBe(before);
  });

  it('does not persist title-only YouTube atomic items during Codex scan', async () => {
    const { db, resourceId } = youtubeFixture();
    const brief = buildResourceBrief(db, resourceId);
    const titleEvidenceId = brief.evidence.find(item => item.kind === 'title')?.id;
    if (!titleEvidenceId) throw new Error('Missing title evidence');
    const provider: LlmProvider = {
      async complete() {
        return {
          text: JSON.stringify({
            resources: [{
              resourceId,
              summary: 'Looks dense from title only.',
              contentKind: 'youtube_video',
              userPurposeGuess: 'reference',
              topics: ['papers'],
              suggestedTags: ['reference'],
              confidence: 0.7,
              evidenceRefs: [titleEvidenceId],
              missingEvidence: [],
              reviewReason: '',
              atomicItems: [{
                itemKind: 'paper',
                name: 'Imagined Paper',
                summary: 'Should not be persisted from title-only evidence.',
                evidenceRefs: [titleEvidenceId],
                confidence: 0.75,
              }],
            }],
          }),
          usage: { quotaTurns: 1 },
        };
      },
    };
    const job = createCodexScanJob(db, { resourceIds: [resourceId], force: true, batchSize: 1 }).job;
    await resumeCodexScanJob(db, provider, job.id, { maxItems: 1 });

    const count = db.prepare('SELECT COUNT(*) AS count FROM atomic_items WHERE resource_id = ?').get(resourceId) as { count: number };
    expect(count.count).toBe(0);
  });
});
