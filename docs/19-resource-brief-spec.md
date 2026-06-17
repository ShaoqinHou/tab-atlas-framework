# Resource Brief Spec

## Purpose

Codex should not inspect every page. The app creates compact resource briefs from deterministic extraction and user annotations. Codex receives these briefs and produces plans.

A brief is the unit of agent reasoning.

## Brief shape

```json
{
  "resourceId": "res_123",
  "canonicalUrl": "https://www.youtube.com/watch?v=...",
  "redactedUrl": "https://www.youtube.com/watch?v=...",
  "urlKind": "youtube_video",
  "host": "youtube.com",
  "title": "...",
  "browserGroupTitles": ["Ideas"],
  "userAnnotations": [
    {
      "tags": ["game", "inspiration", "ui"],
      "description": "Inventory UI idea; use for project X.",
      "decision": "important",
      "createdAt": "2026-06-17T00:00:00Z"
    }
  ],
  "systemTags": ["youtube", "video", "long_form"],
  "summary": "...",
  "atomicItems": [],
  "evidence": [
    {
      "id": "ev_1",
      "kind": "youtube_metadata",
      "text": "description excerpt...",
      "provenance": "official_api",
      "confidence": 0.8
    }
  ],
  "extractionStatus": "partial"
}
```

## Required ordering

Put high-priority clues first:

1. user annotations;
2. pinned accepted/rejected memberships;
3. browser group context;
4. strong extracted evidence;
5. weak metadata/title/URL signals.

This prevents Codex from ignoring the user’s short note in a long metadata block.

## YouTube streamlined brief

YouTube should be the most optimized path because many links will be videos.

### Cheap deterministic extraction

- Parse video ID / playlist ID / channel ID.
- Normalize watch URLs and remove tracking params.
- Use existing browser title immediately.
- Use oEmbed or YouTube Data API metadata if configured.
- Store channel, duration, description, tags/categories if available.
- Parse chapters/timestamps from description.
- Detect list/survey videos from title/description patterns.

### Transcript policy

Official YouTube captions download is not a public arbitrary transcript API. Therefore the framework must represent transcript status clearly:

- `available_official_owned_or_authorized`
- `available_optional_adapter`
- `unavailable`
- `blocked_permission`
- `blocked_policy`
- `not_attempted`
- `manual_needed`

Codex can split a video into detailed atomic items only if enough evidence exists: transcript, rich description, chapter list, or manually added notes. Otherwise it should create broad tentative topics and ask for review.

### YouTube atomic items

For list videos, Codex may create atomic items like:

- paper;
- tool;
- game mechanic;
- art reference;
- tutorial step;
- project idea;
- quote/insight;
- watch task.

Each atomic item needs evidence refs.

## Generic webpage brief

For arbitrary non-standard links:

1. Fetch without cookies.
2. Respect timeout, content-size, and per-host rate limits.
3. Extract:
   - HTTP status and content type;
   - canonical URL;
   - `<title>`;
   - meta description;
   - Open Graph/Twitter card data;
   - headings;
   - readable main-text excerpt;
   - outbound links summary if cheap;
   - noindex/login/auth hints.
4. Do not execute arbitrary JS in v1.
5. Do not send raw HTML to Codex; send compact text only.

If fetch fails, the brief still uses tab title, URL, host, browser group, and user notes.

## Special resource kinds

### GitHub

Use URL parsing first. For public repos/issues/files, extract repo owner/name, path type, README excerpt or issue title if public fetch works.

### PDFs

Fetch only if size is within limit. Extract title/authors/abstract/first pages. Store hash and excerpt.

### Search/login/dashboard pages

Treat as shallow records by default. They are often not useful after session expiry and may contain private query data. Redact sensitive parameters and classify as `needs_review` or `safe_archive_review` when appropriate.

## Brief size limits

Suggested v1 limits:

- title: 180 chars;
- user annotations: all, but cap each note at 1,000 chars;
- description excerpt: 2,000 chars;
- transcript excerpts: top chunks, max 4,000 chars unless command asks for deeper analysis;
- main text excerpt: 2,000 chars;
- total brief: target under 6,000 chars.

## MVP acceptance criteria

- Every resource can produce a brief, even with only title/URL.
- User notes and tags are included before AI/extracted text.
- YouTube videos have standardized metadata fields and transcript status.
- Generic pages use a common extractor with clear failure states.
- Codex prompts never include raw cookies, local storage, or full browser session data.
