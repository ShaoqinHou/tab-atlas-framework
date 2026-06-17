# Agent Tool Protocol

## Purpose

The built-in Codex agent needs to control TabAtlas through safe app tools, not by directly editing SQLite or driving the browser. This document defines the tool layer the coding agent should implement and the runtime agent should use.

The protocol can be exposed as internal TypeScript functions first, then optional HTTP endpoints, then optional MCP tools if useful.

## Authority model

Codex may:

- search resource briefs;
- read extraction artifacts and user annotations;
- propose views/tags/memberships;
- create review queues;
- write AI proposals;
- explain why something is grouped;
- ask for user approval.

Codex may not:

- close/move/bookmark/group browser tabs directly;
- fetch arbitrary pages itself;
- read cookies/passwords/local storage/raw browser files;
- silently override user-pinned tags/views;
- claim transcript evidence without an artifact.

## Core tools

### `searchResources`

Input:

```json
{
  "query": "game inspiration UI",
  "filters": {
    "urlKinds": ["youtube_video", "web_page"],
    "annotationStatus": "any",
    "limit": 80
  }
}
```

Output: resource IDs with match reasons from FTS/tags/notes/summaries.

### `getResourceBriefs`

Input:

```json
{
  "resourceIds": ["res_1", "res_2"],
  "include": ["userAnnotations", "extractionArtifacts", "atomicItems", "existingMemberships"]
}
```

Output: compact `ResourceBrief[]`, with user annotations first.

### `planSemanticView`

Input:

```json
{
  "commandText": "Make a loose game inspiration board but welcome all marked inspiration.",
  "candidateResourceIds": ["res_1", "res_2"],
  "options": {
    "maxViews": 4,
    "allowWeakMatches": true,
    "askReviewForAmbiguous": true
  }
}
```

Output: `SemanticViewPlan` JSON.

### `previewViewPlan`

Input: `SemanticViewPlan` ID or object.

Output: counts, sections, conflicts, weak matches, representative cards.

### `applyViewPlan`

Input:

```json
{
  "planId": "plan_123",
  "applyMode": "proposed",
  "pin": false
}
```

`applyMode=proposed` stores the view as a preview; `accepted` requires user action.

### `addUserAnnotation`

Input:

```json
{
  "targetKind": "resource",
  "targetId": "res_123",
  "tags": ["inspiration", "game", "ui"],
  "description": "Inventory UI idea; not about the actual game.",
  "decision": "important",
  "source": "focused_review"
}
```

Output: annotation ID and updated brief.

### `getReviewNext`

Input:

```json
{
  "queue": "unmarked",
  "preload": 2,
  "filters": { "urlKinds": ["youtube_video", "web_page"] }
}
```

Output: current preview + preloaded next resources.

### `submitReviewDecision`

Input:

```json
{
  "resourceId": "res_123",
  "action": "save_and_next",
  "tags": ["game", "inspiration"],
  "description": "Mechanic idea for combat pacing."
}
```

Output: next review item.

### `explainMembership`

Input:

```json
{
  "resourceId": "res_123",
  "viewId": "view_game_inspiration"
}
```

Output: explanation with evidence priority.

## Tool selection logic for the agent

When a user asks for grouping:

1. Parse command and identify candidate search terms and intent axes.
2. Call `searchResources` using title, tags, descriptions, summaries, and FTS.
3. Call `getResourceBriefs` on candidates.
4. Call `planSemanticView` with the command and briefs.
5. If too many ambiguous items, call/create `getReviewNext` queue instead of pretending.
6. Preview result.
7. Apply only after user accepts.

When a user asks "why is this here?":

1. Call `explainMembership`.
2. Show user note/tag first if it drove the decision.
3. Show weak or conflicting evidence honestly.

When a user edits a tag/note:

1. Call `addUserAnnotation`.
2. Re-score affected views.
3. Tell user what changed.

## MVP implementation path

Phase 1 can implement these tools as ordinary TypeScript service functions. Phase 2 can expose them under `/api/agent/tools/*`. Phase 3 can wrap the same functions as MCP tools for Codex if it is useful.

Do not let MCP/tool support become a blocker. The product needs a safe tool contract first.

## Validation requirements

Every agent-written proposal must be validated:

- JSON schema validation;
- referenced resource IDs exist;
- evidence refs exist;
- user-pinned exclusions are not violated unless explicitly surfaced as conflicts;
- no destructive browser action is applied;
- transcript-derived claims reference transcript artifacts.
