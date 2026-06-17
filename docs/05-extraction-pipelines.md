# Extraction Pipelines

## Principle

Extraction is a deterministic pipeline. Codex should reason over extraction results, not browse arbitrary pages.

```text
URL → normalize → choose recipe → fetch/extract → store evidence → build compact brief → Codex categorizes
```

## Pipeline stages

### 1. Normalize

- Canonicalize URL.
- Strip tracking parameters (`utm_*`, common click IDs) unless content depends on them.
- Identify content kind.
- Compute stable hash.
- Detect duplicate tabs and duplicate resources.

### 2. Fast metadata

Use safe, low-cost signals:

- original tab title;
- browser group title/color;
- URL host/path;
- Open Graph/Twitter card metadata where fetchable without cookies;
- page `<title>` and `<meta name="description">`;
- content type and size.

### 3. Domain-specific extraction

Use recipes from `knowledge/recipes/`.

Initial recipe priorities:

1. YouTube videos/playlists/channels.
2. Generic web pages.
3. GitHub repositories/issues/files.
4. PDFs.
5. Search result pages and dashboards as low-depth records.

### 4. Text compaction

Before sending to Codex, compress artifacts into resource briefs:

- max title length;
- max description length;
- transcript chunks/chapters when available;
- extracted entities/topics;
- evidence IDs;
- source quality flags.

### 5. AI batch categorization

Send 20–80 compact resources per batch depending on text size.

Ask Codex for:

- resource summaries;
- atomic items;
- tags;
- groups/views;
- duplicate/near-duplicate relationships;
- low-confidence cases.

### 6. Merge and reconcile

Do not blindly overwrite old categories. Reconcile:

- current AI proposal;
- user-pinned views;
- accepted historical tags;
- browser group evidence;
- confidence thresholds.

## YouTube pipeline

Detailed in `docs/05a-youtube-pipeline.md`.

High-level:

- parse video/playlist/channel IDs;
- get public metadata via oEmbed or YouTube Data API if configured;
- attempt transcript only through explicit configured adapters;
- store transcript provenance and failure reason;
- let Codex split videos into atomic topics/items only when enough text exists.

## Generic webpage pipeline

1. Fetch URL without cookies.
2. Respect a per-host rate limit.
3. Store content type/status.
4. Extract title, description, canonical link, headings, main text excerpt.
5. Avoid logged-in/session pages by detecting login/dashboard/account keywords and noindex signals.
6. Do not execute arbitrary JavaScript in v1.

## PDF pipeline

1. Fetch only if URL points to PDF and size is within limit.
2. Extract first pages and metadata using a local PDF parser.
3. Store sha256 of file bytes, not necessarily the full file unless user opts in.
4. For arXiv/PDF papers, extract title/authors/abstract where possible.

## GitHub/docs pipeline

1. Parse repo/issue/pull/file paths.
2. For public GitHub pages, use public HTTP or GitHub API if configured.
3. Extract repo metadata, README excerpts, language, stars if available.
4. For docs pages, extract breadcrumbs/headings.

## Extraction status model

Every resource should have an explicit status:

- `not_started`
- `metadata_only`
- `partial`
- `complete`
- `blocked_auth_required`
- `blocked_size_limit`
- `blocked_robots_or_terms`
- `failed_network`
- `failed_parse`
- `manual_needed`

This prevents the UI from pretending it knows more than it does.

## V2 clarification: extract for briefs, not final truth

Extraction should create useful evidence briefs. It should not decide the final user-facing grouping by itself.

The final grouping is a semantic view plan created from:

1. user annotations;
2. accepted/rejected prior memberships;
3. browser group context;
4. deterministic extraction artifacts;
5. title/URL fallback.

For every resource, even unknown links, the app should produce a minimal brief from title, URL, host, browser group, and user notes. Generic extraction should improve the brief when safe, but failure must not block user annotation or grouping.

Focused review can run before extraction is complete. A user's short note often gives better grouping evidence than a slow fetch.
