# Project lead handoff — Codex scanning and reusable tab knowledge

Date: 2026-06-18 NZT

This handoff follows commit `19d3aea519e9de9dab7a78c8b919ab2f2e9341b8`.

The app now has the important agent-first path:

- `/api/agent/command` accepts `mode: "codex"`;
- server reuses `CodexSdkProvider` instances by reasoning effort;
- UI defaults to `Codex agent`;
- Codex planning turns are logged in `agent_runs`;
- fake-provider tests cover Codex mode and invalid JSON reask;
- one real Codex smoke command succeeded.

The next stride is **not** more folder/tag UI. The next stride is turning open tabs into reusable local knowledge so future Codex grouping commands are fast, flexible, and evidence-backed.

## Product goal

TabAtlas should maintain a local knowledge layer over resources:

```text
resource URL/title/browser group/user notes/extraction artifacts
  -> Codex scan batches
  -> codex_resource_analysis.v1 artifacts
  -> atomic_items for multi-topic resources
  -> stronger future semantic views
  -> focused review only where evidence is weak
```

This matters because a tab may be useful for different reasons depending on user intent:

- game inspiration;
- art inspiration;
- project reference;
- watch later;
- safe archive;
- tab-manager app research;
- UI idea;
- Codex/SQLite/local-app architecture.

The scan should not force one permanent category. It should create reusable evidence.

## Immediate priorities

### 1. Add Codex resource scanning artifacts

Add a script:

```bash
npm run scan:codex -- --limit 100 --batch-size 20
```

Add an endpoint:

```text
POST /api/agent/scan
```

Inputs:

```json
{
  "limit": 100,
  "batchSize": 20,
  "resourceIds": [],
  "reasoningEffort": "medium",
  "force": false
}
```

Behavior:

1. Select resources needing scan:
   - no `codex_resource_analysis.v1` artifact yet;
   - user annotation changed after last scan;
   - extraction artifact changed after last scan;
   - `force: true`.
2. Build `ResourceBrief`s with user annotations first.
3. Send batches to Codex.
4. Validate structured output.
5. Store one artifact per resource.
6. Store `atomic_items` where justified.
7. Log each Codex batch in `agent_runs`.
8. Refresh FTS extracted text.

Artifact recipe:

```text
codex_resource_analysis.v1
```

Suggested JSON payload:

```json
{
  "summary": "What this resource seems useful for.",
  "contentKind": "youtube_video | youtube_playlist | article | docs | repo | pdf | search | login | unknown",
  "userPurposeGuess": "watch_later | inspiration | reference | project_reference | ignore_candidate | archive_candidate | needs_review",
  "topics": ["game design", "inventory UI", "browser extension"],
  "suggestedTags": ["game", "ui", "inspiration"],
  "confidence": 0.85,
  "evidenceRefs": ["user_annotation:ann_...", "ev_title_...", "art_..."],
  "missingEvidence": ["transcript", "description"],
  "reviewReason": "Need human mark because title is vague and no transcript exists."
}
```

Rules:

- User tags/notes override Codex guesses.
- Every non-trivial claim needs evidence refs.
- Never claim transcript evidence unless a transcript artifact exists.
- Use `needs_review` when evidence is weak.
- Do not mutate browser tabs.
- Do not scrape pages through Codex.

Suggested commit:

```bash
git add .
git commit -m "Add Codex resource scanning artifacts"
```

### 2. Create atomic items for dense resources

Atomic items are crucial. Many YouTube videos and collection links are not one topic.

Examples:

- a video listing ten AI papers;
- a playlist with multiple tutorials;
- a GitHub repo with extension, receiver, UI, and Codex concepts;
- an article with several tools;
- a project planning page with many features.

For each atomic item, store:

```json
{
  "itemKind": "paper | tool | idea | tutorial | project_part | topic | unknown",
  "name": "Inventory UI pattern",
  "summary": "Why this item matters.",
  "evidenceRefs": ["art_...", "user_annotation:..."],
  "confidence": 0.75,
  "createdBy": "codex"
}
```

Rules:

- Do not create atomic items from thin title-only evidence unless the title clearly lists items.
- Prefer fewer, higher-quality atomic items.
- Atomic items may be included in semantic views separately from the parent resource.
- Resource-level user annotations still influence item-level interpretation.

### 3. Make semantic view planning use scan artifacts

After scan artifacts exist, update candidate selection and briefs:

- `searchResources` should search `codex_resource_analysis.v1` summaries, topics, suggested tags, and missing-evidence text through FTS.
- `buildResourceBrief` should include the scan artifact as evidence.
- `planSemanticView` should receive scan summaries and atomic items.
- Agent command planning should include atomic items when command intent benefits from sub-resource grouping.

Acceptance tests:

- A resource with `codex_resource_analysis.v1` topic `inventory UI` is found by a `game UI inspiration` command even if title lacks UI words.
- A multi-paper video can produce atomic items, and a `AI papers to read` view includes the paper items rather than only the parent video.
- User note still beats a Codex suggested tag if they conflict.

Suggested commit:

```bash
git add .
git commit -m "Use Codex scan knowledge in view planning"
```

### 4. Add command history, refinement, and explanations

The user should feel like they are talking to the app, not operating a debug panel.

Add UI/server support for:

- list recent `user_commands`;
- click a previous command to reopen its result;
- refine a view with natural language:

```text
Refine this: exclude pure tutorials, keep only inspiration and examples I can steal design ideas from.
```

- `Why included?` button on every sample card;
- weak/conflict/needs-review filters;
- `Review ambiguous` button that opens the command-specific review queue.

Suggested commit:

```bash
git add .
git commit -m "Add command history and view refinement UI"
```

### 5. Small correctness fixes from audit

These are not blockers, but do them while touching the code:

- `providerThreadId` is read before the Codex provider starts a thread; update the result after planning so the first Codex call returns the real thread ID when available.
- If Codex planning throws, return/log the actual accumulated usage when possible rather than assuming `{ quotaTurns: 1 }`.
- In the UI, when previewing an old view, preserve or hide mode badges instead of showing `unknown`.
- Consider adding `agent_runs` count to `/api/status`.

Suggested commit:

```bash
git add .
git commit -m "Polish Codex agent reporting"
```

## Validation and real Codex use

Codex use is approved. Run real smoke tests deliberately.

Minimum validation:

```bash
npm run typecheck
npm test
npm run lint
npm run scan:codex -- --limit 10 --batch-size 5
```

Manual UI smoke:

1. Import latest capture.
2. Run deterministic extraction.
3. Run Codex scan for 10-20 resources.
4. Ask: `Make a project group for this tab-manager app.`
5. Ask: `Make a loose group mainly game inspiration but welcome all marked inspiration.`
6. Confirm scan artifacts influence results.
7. Use `Why included?` on one strong include and one weak/conflict item.
8. Confirm no browser tabs were mutated.

## Report required

Use `docs/13-agent-report-template.md` and include:

- latest commit SHA;
- commits created;
- validation output;
- Codex scan command run and result;
- Codex turns spent, if known;
- number of `codex_resource_analysis.v1` artifacts created;
- number of atomic items created;
- whether semantic view planning uses scan artifacts;
- manual UI smoke result;
- safety confirmation: no browser mutation, no cookie/password/session parsing, no default transcript scraping, no hidden full-page browsing by Codex.

## Copy-paste mini-prompt for implementation agent

```text
Continue TabAtlas from latest main. Read docs/23-codex-scan-knowledge-handoff.md first.

Codex use is approved. The next target is reusable Codex knowledge, not more heuristic grouping.

Implement:
1. npm run scan:codex -- --limit 100 --batch-size 20
2. POST /api/agent/scan
3. codex_resource_analysis.v1 artifacts per scanned resource
4. atomic_items for dense resources when evidence supports them
5. agent_runs logging for scan batches
6. FTS refresh after scan artifacts
7. semantic view planning/search using scan artifacts and atomic items
8. UI improvements: command history, refine view, Why included, weak/conflict/review filters

Also fix providerThreadId reporting after the first Codex call.

Run npm run typecheck, npm test, npm run lint, a real scan:codex smoke, and a local UI smoke. Commit all work and report using docs/13-agent-report-template.md.
```
