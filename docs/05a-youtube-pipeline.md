# YouTube Pipeline

## Why YouTube gets special treatment

Your tab pile likely contains many YouTube videos. A YouTube tab title alone is weak evidence. A video can contain many topics, papers, tools, or links. Therefore YouTube needs a standardized adapter so the LLM does not improvise differently for every video.

## Inputs

Supported URL patterns:

- `https://www.youtube.com/watch?v=<videoId>`
- `https://youtu.be/<videoId>`
- `https://www.youtube.com/shorts/<videoId>`
- playlist URLs with `list=<playlistId>`
- channel/user/handle pages, later

## Output artifacts

The YouTube extractor should produce:

```json
{
  "resourceKind": "youtube_video",
  "videoId": "...",
  "canonicalUrl": "https://www.youtube.com/watch?v=...",
  "title": "...",
  "channelTitle": "...",
  "durationSeconds": 1234,
  "descriptionText": "...",
  "chapters": [],
  "transcript": {
    "status": "available | unavailable | blocked_permission | blocked_adapter_missing | failed | not_attempted",
    "language": "en",
    "provenance": "official_owner_api | optional_local_adapter | manual | none",
    "segments": []
  },
  "linksMentioned": [],
  "extractionQuality": "metadata_only | description | transcript_partial | transcript_full"
}
```

## Metadata strategy

Use layers:

1. **Snapshot title** from the browser extension.
2. **Public oEmbed-style metadata** for title/author/thumbnail where available.
3. **YouTube Data API** if the user supplies an API key. `videos.list` can return `snippet`, `contentDetails`, `statistics`, and other parts. The app must keep this optional because the user asked to avoid paid LLM/API use; a YouTube API key is a separate user choice.
4. **Page metadata fetch** as a fallback.

## Transcript strategy

Important: official YouTube caption download is not a universal public transcript API for arbitrary videos. It requires authorization and the user must have permission to edit the video. So the app should not pretend official captions will solve all public videos.

Recommended adapter model:

- `official_owner_captions`: OAuth, only for videos the user can manage. Stable/compliant.
- `optional_local_transcript_adapter`: disabled by default; the user may install a local transcript tool/plugin after reviewing its legal/TOS implications.
- `manual_paste`: user can paste transcript text or export it from the browser manually.
- `no_transcript`: use title, description, chapters, linked URLs, and channel metadata only.

Each transcript artifact must store provenance and status.

## Atomic item extraction

Codex should split a YouTube video into atomic items only if enough source text exists:

- transcript full or partial;
- rich description with chapters/links;
- video title strongly indicates a list/collection;
- extracted URLs from description.

Examples of atomic items:

- paper names;
- AI tools;
- libraries;
- concepts;
- tutorials;
- products;
- tasks.

## Prompt rule for Codex

Codex receives the YouTube evidence brief and must output JSON only.

It must distinguish:

- the video as a resource;
- each important subtopic/item inside the video;
- the confidence level based on available text;
- whether transcript was missing.

If transcript is unavailable, Codex must not hallucinate detailed paper/tool lists from the title alone.

## UI display

A YouTube resource card should show:

- title and channel;
- duration;
- transcript status;
- extracted topics/items count;
- "why categorized here" evidence;
- watch-later priority;
- whether the video appears to be a collection/survey.

## Edge cases

- Deleted/private videos: preserve snapshot title and URL, mark unavailable.
- Shorts: likely metadata-only unless transcript available.
- Playlists: store playlist as resource, videos as child resources if API/adapter can enumerate.
- Livestreams: transcript may be unavailable; duration may be long; category should reflect live/recording.
- Non-English videos: store language; summarize only if transcript or description is available.

## V2 requirement: fast enough for large tab piles

The first YouTube pass should be cheap and uniform:

1. Parse ID and canonicalize URL.
2. Store snapshot title immediately.
3. Fetch/attach metadata if configured and cheap.
4. Parse description/chapter/list signals if available.
5. Set transcript status honestly.
6. Build a brief with user annotations first.
7. Let Codex reason over batches of these briefs.

Do not make Codex open each YouTube page or invent a per-video workflow.

## User annotation examples

A YouTube video may be grouped by purpose rather than literal subject:

- Title: `Elden Ring boss design breakdown`
  - User tag: `inspiration`
  - User note: `combat pacing idea`
  - Strong include for `game inspiration`.

- Title: `Watercolor forest environments`
  - User tag: `game`, `inspiration`
  - User note: `forest level moodboard`
  - Strong include for `game inspiration`; also include for `art inspiration` if requested.

- Title: `Top 10 cozy game soundtracks`
  - User tag: `inspiration`
  - User note: `atmosphere reference for game jam`
  - Include in `loose inspiration`; weak/conflict for strict `game design` unless the command includes mood/audio.
