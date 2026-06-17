# Architecture

## Recommended stack

- **Local server**: Node.js 20+, TypeScript, Fastify or Express.
- **UI**: React/Vite or Next.js served locally.
- **Storage**: SQLite with FTS5. Add vector search later only if needed.
- **AI provider**: local Codex via `@openai/codex-sdk` first; `codex exec --json --output-schema` fallback.
- **Capture**: existing Manifest V3 extension + localhost receiver.
- **Workers**: background queue for extraction and AI categorization.
- **OS target**: Windows-first, but keep the core Node app portable.

## High-level architecture

```text
┌────────────────────────────┐
│ Chrome Extension            │
│ Edge Extension              │
│ - tabs/windows/tabGroups    │
│ - passive localhost export  │
└──────────────┬─────────────┘
               │ POST /snapshot
               ▼
┌────────────────────────────┐
│ Local TabAtlas Server       │
│ 127.0.0.1 only              │
│ - receiver endpoints        │
│ - import/export             │
│ - API for UI                │
└──────┬─────────────┬───────┘
       │             │
       ▼             ▼
┌──────────────┐  ┌─────────────────────┐
│ SQLite Store │  │ Worker Queue         │
│ - resources  │  │ - extraction jobs    │
│ - snapshots  │  │ - batch AI jobs      │
│ - evidence   │  │ - view builds        │
│ - views      │  └──────────┬──────────┘
└──────┬───────┘             │
       │                     ▼
       │         ┌─────────────────────┐
       │         │ Extraction Adapters  │
       │         │ - YouTube            │
       │         │ - Web page metadata  │
       │         │ - PDF                │
       │         │ - GitHub/docs        │
       │         └──────────┬──────────┘
       │                    │ compact evidence briefs
       ▼                    ▼
┌──────────────────────────────────────┐
│ Codex Reasoning Layer                │
│ - read-only sandbox for reasoning    │
│ - structured output schema           │
│ - zod/semantic validation            │
│ - no autonomous browser/page opening │
└──────────────────┬───────────────────┘
                   │ view plans, tags, clusters, atomic items
                   ▼
┌──────────────────────────────────────┐
│ Local Web UI                         │
│ - command bar                        │
│ - dynamic views                      │
│ - graph/cluster map                  │
│ - evidence inspector                 │
│ - approval queue for browser actions │
└──────────────────────────────────────┘
```

## Key modules

### 1. Capture adapter

Accepts snapshots from your current exporter and normalizes them into:

- `snapshots`
- `snapshot_tabs`
- `resources`
- `resource_observations`

### 2. Normalizer

Converts URL variants into stable resource keys:

- strip common tracking params;
- normalize host casing;
- preserve parameters that affect content;
- detect YouTube video IDs, playlist IDs, shorts, channels;
- detect GitHub repo/issues/files;
- detect PDFs;
- detect docs/search/login pages.

### 3. Extractor registry

Routes resources to deterministic adapters:

```text
youtube.com/watch?v=...  -> YouTubeRecipe
youtu.be/...             -> YouTubeRecipe
*.pdf                    -> PdfRecipe
github.com/org/repo/...  -> GitHubRecipe
generic https page       -> WebPageRecipe
```

Extractors produce `ExtractionArtifact` records. They do not directly decide final categories.

### 4. AI reasoning layer

Codex receives compact briefs such as:

```json
{
  "resourceId": "res_abc",
  "title": "10 AI Agent Papers...",
  "urlKind": "youtube_video",
  "sourceSignals": {
    "browserGroupTitle": "AI",
    "durationSeconds": 2541,
    "channelTitle": "...",
    "descriptionExcerpt": "...",
    "transcriptExcerpt": "..."
  },
  "knownAtomicItems": []
}
```

Codex returns structured objects:

- resource summaries;
- topic tags;
- proposed dynamic groups;
- extracted atomic items;
- duplicate relationships;
- confidence and evidence references;
- suggested UI views.

### 5. View engine

A "view" is not a folder. It is a queryable, explainable, optionally pinned lens over resources.

Examples:

- "AI papers from videos"
- "Could archive safely"
- "OpenAI/Codex ecosystem"
- "Need manual review"
- "Weekend watch-later"

Views can overlap. One resource can appear in several views.

### 6. Browser action bridge

Optional later feature. Converts approved user decisions into browser actions:

- create tab groups;
- rename groups;
- bookmark/archive links;
- close selected tabs;
- open a saved view in a new browser window.

Default state: read-only advisory UI.

## Why this shape

The key design is separating **capture**, **extraction**, **reasoning**, and **UI actions**. This prevents the LLM from becoming a slow, unsafe, unpredictable crawler. It also allows the app to improve incrementally: YouTube can be great first, generic pages acceptable second, PDFs/GitHub/docs later.

## V2 architecture: agent tool layer and focused review

The clarified product adds two core layers between storage and Codex reasoning:

```text
SQLite knowledge store
  ├─ resources / artifacts / atomic items
  ├─ user annotations
  ├─ review queues
  └─ semantic view specs
        ▲
        │ safe service functions
        ▼
Agent Tool Layer
  ├─ searchResources
  ├─ getResourceBriefs
  ├─ planSemanticView
  ├─ previewViewPlan
  ├─ addUserAnnotation
  ├─ getReviewNext
  ├─ submitReviewDecision
  └─ explainMembership
        ▲
        │ validated structured prompts
        ▼
Codex Provider Seam
```

Codex should use these tools rather than raw SQL or browser automation. This keeps the agent powerful while limiting privacy and safety risks.

Focused review is also part of the core architecture:

```text
unmarked/ambiguous resource
  -> preview brief built from URL/title/extraction
  -> user adds tag/description/decision
  -> user annotation stored
  -> resource brief rebuilt with user evidence first
  -> semantic views re-score quickly
```

This loop is what lets TabAtlas understand personal meanings such as "this art video is game inspiration" or "this game video is only useful for UI design."
