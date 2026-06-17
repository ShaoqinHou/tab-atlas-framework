# Data Model

## Important distinction

A browser tab is an observation. A resource is the thing behind one or more tab observations. An atomic item is a meaningful sub-object extracted from a resource.

```text
snapshot ── has many ── tab observations ── reference ── resources ── contain ── atomic items
```

## Main entities

### Snapshot

One capture event.

Fields:

- `id`
- `capturedAt`
- `source`: `extension`, `headless_script`, `manual_import`
- `browserCounts`
- `rawFilePath`

### TabObservation

A tab seen in a snapshot.

Fields:

- `snapshotId`
- `browser`: `chrome` or `edge`
- `windowId`
- `tabId`
- `index`
- `active`
- `pinned`
- `audible`
- `discarded`
- `groupId`
- `groupTitle`
- `groupColor`
- `title`
- `url`
- `resourceId`

### Resource

Canonical URL-level object.

Fields:

- `id`
- `canonicalUrl`
- `urlHash`
- `urlKind`: `youtube_video`, `youtube_playlist`, `web_page`, `pdf`, `github`, `docs`, `search`, `login`, `unknown`
- `host`
- `titleBest`
- `firstSeenAt`
- `lastSeenAt`
- `openObservationCount`
- `status`: `active`, `archived`, `ignored`, `deleted_from_browser`

### ExtractionArtifact

Deterministic evidence from a resource.

Fields:

- `id`
- `resourceId`
- `recipeId`
- `artifactKind`: `metadata`, `description`, `transcript`, `html_text`, `pdf_text`, `github_metadata`, `oembed`, `error`
- `textExcerpt`
- `jsonPayload`
- `sourceUrl`
- `provenance`: `official_api`, `public_http`, `local_file`, `extension_snapshot`, `manual`, `optional_plugin`
- `extractedAt`
- `expiresAt`
- `confidence`
- `errorCode`

### AtomicItem

A meaningful object inside a resource.

Examples:

- paper mentioned in a video;
- tool listed in an article;
- GitHub repository referenced by a docs page;
- tutorial section;
- shopping item;
- task-like page.

Fields:

- `id`
- `resourceId`
- `itemKind`: `paper`, `tool`, `person`, `company`, `tutorial_step`, `project`, `topic`, `product`, `task`, `unknown`
- `name`
- `summary`
- `evidenceRefs`
- `confidence`
- `createdBy`: `extractor`, `codex`, `user`

### Tag

A small reusable semantic label. Tags can be AI-proposed or user-pinned.

Fields:

- `id`
- `name`
- `description`
- `scope`: `resource`, `atomic_item`, `view`
- `origin`: `ai`, `user`, `system`
- `status`: `proposed`, `accepted`, `pinned`, `retired`

### View

A dynamic grouping/lens. Views are first-class UI objects.

Fields:

- `id`
- `name`
- `description`
- `queryJson`
- `origin`: `ai`, `user`, `system`
- `status`: `proposed`, `accepted`, `pinned`, `archived`
- `createdFromCommandId`
- `evidenceSummary`
- `sortPolicy`

### Membership

Links resources/atomic items to tags/views.

Fields:

- `targetKind`: `resource` or `atomic_item`
- `targetId`
- `containerKind`: `tag` or `view`
- `containerId`
- `confidence`
- `reason`
- `evidenceRefs`
- `acceptedByUser`

### UserCommand

A natural language request and its interpreted plan.

Fields:

- `id`
- `text`
- `createdAt`
- `parsedIntentJson`
- `planJson`
- `status`: `proposed`, `applied`, `rejected`, `failed`

### AgentRun

Auditable model invocation.

Fields:

- `id`
- `provider`: `codex_sdk`, `codex_exec`, `stub`
- `purpose`: `categorize_batch`, `extract_atomic_items`, `plan_view_mutation`, `summarize_resource`
- `inputArtifactIds`
- `outputJson`
- `schemaId`
- `validationStatus`
- `startedAt`
- `finishedAt`
- `usageJson`
- `error`

## Why evidence references matter

The app should never silently say "AI says this tab belongs here." It should say why.

Every AI-produced membership should be backed by at least one of:

- URL/host signal;
- title signal;
- browser group signal;
- extracted metadata;
- transcript/description excerpt;
- user preference;
- prior accepted categorization.

## SQLite design note

Use plain relational tables first plus FTS5 over extracted text and summaries. Vector embeddings can be added later, but they are not required for a useful v1.

## V2 additions: user annotations and semantic views

### UserAnnotation

User-created evidence attached to a resource or atomic item.

Fields:

- `id`
- `targetKind`: `resource` or `atomic_item`
- `targetId`
- `tagsJson`
- `description`
- `decision`: `important`, `watch_later`, `project_reference`, `inspiration`, `archive_later`, `ignore`, `needs_deeper_read`, `none`
- `source`: `focused_review`, `resource_detail`, `agent_chat`, `bulk_edit`, `import`
- `createdAt`
- `updatedAt`

These annotations must be included first in resource briefs and should outrank title-only AI guesses.

### ReviewQueueItem

A resource waiting for fast human marking.

Fields:

- `id`
- `resourceId`
- `queueName`: `unmarked`, `low_confidence`, `conflicts`, `safe_archive_review`, etc.
- `status`: `pending`, `skipped`, `completed`, `dismissed`
- `reason`
- `priority`
- `position`
- `lastPresentedAt`
- `skippedCount`
- `completedAt`

### SemanticViewSpec

The structured logic behind a dynamic view.

Fields:

- `id`
- `viewId`
- `commandId`
- `goal`
- `inclusionRulesJson`
- `exclusionRulesJson`
- `sectionRulesJson`
- `sortPolicy`
- `createdByAgentRunId`

Views are lenses, not folders. A resource may belong to many views with different membership states.

### Membership state

Extend memberships with:

- `state`: `strong_include`, `weak_include`, `conflict`, `exclude`, `needs_review`
- `section`
- `conflictNote`

This supports fuzzy requests like "mostly game inspiration but welcome all other inspiration."
