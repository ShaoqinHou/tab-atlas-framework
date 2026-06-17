# Project lead handoff — agentic MVP next stride

Date: 2026-06-17 / 2026-06-18 NZT

This document is the next implementation handoff after commit `d10a8c70a100742d9ce2820d6df9dafe9d45042e`.

The first pass successfully made the scaffold compile, imported tab snapshots, created SQLite storage, added user annotations, added focused review services/endpoints, added a Codex SDK provider, and added deterministic semantic-view tests. The next pass should turn that foundation into the first real **agent-first product loop**.

## Product north star

TabAtlas is not a folder/tag manager with an AI button.

The user should mostly interact with a built-in local agent:

```text
User: Make a loose inspiration board, mainly game ideas, but include anything I personally marked as inspiration.
Agent: I found 31 game-centered matches, 14 cross-domain inspiration matches, 7 weak matches, and 5 links needing review. Preview?
```

The agent must use safe app tools over local data. It must not browse every page, drive Chrome/Edge, inspect cookies/session state, or mutate browser tabs.

## What is already good

Keep these decisions:

- SQLite schema has resources, observations, extraction artifacts, atomic items, user annotations, views, memberships, review queue items, and agent runs.
- Importer handles flattened snapshots and per-browser latest-all objects.
- Focused review has current + preloaded next briefs.
- User annotations are first-class objects and appear before extracted evidence in `ResourceBrief` JSON.
- Search scoring gives user annotation text higher weight than title/URL.
- Deterministic semantic heuristic encodes the strict-vs-loose inspiration examples.
- Codex SDK provider uses read-only sandbox, approval never, web search disabled.
- Codex smoke test is manual and should not run in CI.

## Main gap after d10a8c7

The repo has the ingredients, but not yet the complete app loop:

```text
agent chat command
  -> retrieve candidates
  -> build briefs
  -> plan semantic view
  -> persist proposed view + memberships
  -> preview sections/conflicts/weak matches
  -> user applies/pins/refines
  -> explain why each resource belongs
```

The next coding agent should implement that loop with deterministic/stub planning first. Codex can be wired after the loop works end-to-end.

## Next implementation scope

Complete **Phase 3 extraction foundation**, **Phase 4 persisted semantic views**, and the smallest useful piece of **Phase 6 UI**.

Do not spend Codex turns unless explicitly approved after all no-spend tests pass.

### 1. Add deterministic extraction pipeline

Create a local extraction service that writes `extraction_artifacts` without calling cloud services.

Minimum recipes:

#### `title_url_snapshot.v1`

Input: resource row + latest tab observations.

Output artifact:

```json
{
  "recipeId": "title_url_snapshot.v1",
  "artifactKind": "snapshot_metadata",
  "textExcerpt": "Title, host, browser group names, URL kind.",
  "provenance": "extension_snapshot",
  "confidence": 0.45,
  "status": "complete"
}
```

#### `youtube_url_metadata_stub.v1`

Input: normalized YouTube URL.

Output artifact with explicit transcript status:

```json
{
  "recipeId": "youtube_url_metadata_stub.v1",
  "artifactKind": "youtube_metadata_stub",
  "jsonPayload": {
    "videoId": "...",
    "playlistId": "...",
    "transcriptStatus": "not_attempted",
    "transcriptReason": "Official arbitrary public transcript download is not assumed available."
  },
  "provenance": "url_parser",
  "confidence": 0.5,
  "status": "metadata_only"
}
```

Do not scrape unofficial transcripts in this pass.

#### `generic_page_metadata_stub.v1`

For non-YouTube links, store what is safely available locally: title, host, URL kind, browser group titles, redacted URL. Optional HTTP metadata fetching can come later and must have a timeout, denylist for localhost/private IPs, and artifact provenance.

Acceptance tests:

- extraction run is idempotent per resource + recipe;
- YouTube artifact has `transcriptStatus`, never pretends transcript evidence exists;
- generic artifact exists for web pages;
- FTS `extracted_text` refreshes after artifacts are written.

Suggested commit:

```bash
git add .
git commit -m "Add deterministic extraction pipeline"
```

### 2. Persist semantic view plans

Currently `planSemanticView` can return a schema-valid plan, and the heuristic can classify resources. The app now needs persistence and preview APIs.

Implement:

- `createUserCommand(text)` -> row in `user_commands`.
- `persistSemanticViewPlan(commandId, plan, origin)` -> rows in `views`, `semantic_view_specs`, and `memberships`.
- `previewView(viewId)` -> counts by state and section, plus representative resource cards.
- `applyViewPlan(viewId, mode)` where v1 mode is only:
  - `proposed`: keep as preview;
  - `accepted`: mark memberships accepted by user;
  - no browser mutation.
- `refineView(viewId, naturalLanguageEdit)` can be a placeholder that creates a new command linked to the old view.

Membership persistence rules:

- Store all membership states: `strong_include`, `weak_include`, `conflict`, `exclude`, `needs_review`.
- Store evidence refs exactly from the plan.
- For include/conflict/needs_review, evidence refs must be non-empty unless the state is explicitly a no-evidence review candidate.
- User annotation evidence refs should look like `user_annotation:ann_...`.
- Never overwrite accepted/pinned membership silently; create a new proposed membership or a conflict.

Acceptance tests:

- strict game inspiration command creates a view with expected include/exclude states;
- loose inspiration command creates sections including cross-domain inspiration;
- persisted membership can be explained by `explainMembership`;
- accepted memberships are not silently overwritten by a later plan.

Suggested commit:

```bash
git add .
git commit -m "Persist semantic view plans and memberships"
```

### 3. Add agent command service

Add a service that represents the actual product interaction:

```ts
runAgentCommand(db, providerOrMode, {
  text: string,
  mode: 'heuristic' | 'codex',
  candidateLimit?: number,
  dryRun?: boolean
})
```

For v1, default mode should be `heuristic` or `stub`, not Codex.

The service should:

1. Store the user command.
2. Derive candidate search terms from the command.
3. Call `searchResources`.
4. Build resource briefs.
5. Plan a semantic view.
6. Persist the proposed view.
7. Return a preview summary.

Return shape example:

```json
{
  "commandId": "cmd_...",
  "viewIds": ["view_..."],
  "summary": {
    "strongInclude": 31,
    "weakInclude": 7,
    "conflict": 3,
    "needsReview": 5,
    "exclude": 42
  },
  "message": "I created a proposed Game inspiration view. Review weak/conflict items before accepting."
}
```

Acceptance tests:

- a natural-language command creates a stored proposed view;
- user annotation evidence changes the returned summary as expected;
- dry-run returns a plan but does not persist;
- no Codex call is made in heuristic/stub mode.

Suggested commit:

```bash
git add .
git commit -m "Add agent command service"
```

### 4. Add minimal UI MVP

This UI can be simple. It must prove the user flow.

Required screens:

#### Home / status

Show:

- snapshot count;
- unique resources;
- unmarked count;
- YouTube count;
- existing proposed/accepted views.

Primary actions:

- ask agent;
- quick mark unreviewed links;
- import snapshot.

#### Agent command center

A text box and result cards:

```text
Ask TabAtlas:
[ Make a loose group mainly game inspiration but welcome all marked inspiration ]
[Plan]
```

After planning, show:

- view name;
- inclusion/exclusion rules;
- counts by membership state;
- sections;
- sample strong matches;
- weak/conflict/needs-review toggles;
- buttons: `Accept view`, `Refine logic`, `Review ambiguous`.

#### Focused review

Implement the already-designed review loop:

- current resource card/preview;
- title, host, redacted URL, browser groups, extraction status;
- quick chips: inspiration, game, art, ui, watch_later, project_reference, ignore;
- note box;
- save & next;
- skip;
- mark ignore;
- open externally;
- next two preloaded titles.

Do not rely only on iframe. Use metadata preview first; optional iframe can be a fallback with graceful failure.

Acceptance tests/manual checks:

- user can import fixture, quick-mark one resource, and see next item immediately;
- user can ask for a loose inspiration view and see a proposed view card;
- user can accept a view and then explain one membership;
- user annotations affect subsequent planning.

Suggested commit:

```bash
git add .
git commit -m "Add local TabAtlas UI MVP"
```

### 5. Codex integration after no-spend loop works

Only after all above passes, wire Codex into `runAgentCommand(... mode: 'codex')`.

Rules:

- keep read-only sandbox;
- approval never;
- web search disabled;
- structured output validation + reask;
- log one row in `agent_runs` per Codex turn;
- cache command+briefs hash to avoid repeated turns;
- show UI indicator: `Codex turn spent: yes/no`.

Run `npm run smoke:codex` only if explicitly approved.

Suggested commit:

```bash
git add .
git commit -m "Wire Codex into agent command planning"
```

## Important engineering warnings

### Do not make the heuristic the product brain

The heuristic exists for tests, offline preview, and safety fallback. The product brain is the agent command loop plus `SemanticViewPlan` schema. Keep heuristic narrow and transparent.

### Do not create permanent mutually exclusive categories

A resource can be in multiple views with different meanings. Avoid a single `category` field as the core model.

### Do not hide uncertainty

Weak/conflict/needs-review states are product features. The UI should expose them rather than forcing everything into include/exclude.

### Keep user annotations dominant

When there is conflict:

```text
user note > user tag/correction > pinned membership/exclusion > browser group > transcript/description/metadata > title/url > weak inference
```

### Avoid premature transcript scraping

For YouTube, preserve honest transcript states:

- `not_attempted`;
- `available_artifact`;
- `blocked_auth_required`;
- `not_available`;
- `adapter_disabled`;
- `adapter_failed`.

Do not write transcript-derived claims without transcript artifacts.

## Required report from next agent

Use `docs/13-agent-report-template.md` and include:

- latest commit SHA;
- commits created;
- validation output summary;
- whether Codex smoke test ran;
- subscription turns spent;
- which implementation sections above are complete;
- manual UI flow tested;
- known limitations;
- whether browser mutation, transcript scraping, or cloud upload was added. Expected answer: no.
