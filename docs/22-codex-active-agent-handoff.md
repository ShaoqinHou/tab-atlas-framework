# Project lead handoff — Codex-active agent loop

Date: 2026-06-18 NZT

This handoff follows latest pushed commit `ed360f845b07ad9ca55b42853339248e4d302cb4`.

The previous handoff deliberately asked for a no-spend agentic MVP. The user has now clarified that Codex subscription turns should be treated as available for development. Cost/quota avoidance is no longer a product blocker. Keep caching and batching for speed, reproducibility, and not repeating work, but do not leave Codex unused merely to avoid turns.

## Audit summary

The latest implementation completed a strong local loop:

- deterministic extraction artifacts exist;
- semantic view plans are persisted;
- agent commands create proposed views in heuristic mode;
- local UI can import, extract, plan, accept views, and focused-review resources;
- tests cover extraction, view persistence, command service, focused review, and the strict/loose inspiration examples.

The main remaining problem is not storage or UI scaffolding. The main remaining problem is **agent intelligence is still mostly heuristic by default**. Codex support exists as a provider seam, but the app route and UI still drive heuristic planning. The next stride should make Codex the real built-in agent while preserving heuristic as a fallback.

## Product direction update

TabAtlas should now behave like this:

```text
User: Make a loose board mainly for game inspiration, but include anything I personally marked as inspiration.
TabAtlas agent:
  1. searches local briefs/annotations/extracted summaries;
  2. calls Codex to interpret the grouping logic;
  3. uses existing user tags, notes, AI analysis, atomic items, and extraction artifacts;
  4. proposes a semantic view with sections, weak/conflict/needs-review buckets;
  5. explains membership using evidence;
  6. asks for focused review only when evidence is actually missing.
```

The user does not want rigid folders. They want a flexible agent that understands fuzzy grouping logic and can quickly reshape views based on natural language.

## Important correction to old wording

Earlier docs say "no cloud upload" as a privacy shorthand. Keep that true for arbitrary background syncing and third-party services, but Codex mode necessarily sends **resource briefs/prompts** to the local Codex CLI / Codex service. That is allowed for this product. The boundary is:

Allowed:

- send compact, redacted `ResourceBrief` data to Codex when the user asks the agent to reason;
- send user notes/tags that are necessary for grouping;
- send extracted description/transcript artifacts only if those artifacts exist and are relevant.

Still not allowed:

- cookies, passwords, local storage, raw browser session files;
- hidden browser mutation;
- arbitrary full-page scraping by Codex;
- silent background upload of every raw URL without an explicit agent task;
- claiming transcript evidence unless a transcript artifact exists.

## Next implementation scope

### 1. Wire Codex into the app, not just the smoke test

Implement Codex as a real selectable/default planner in the server and UI.

Server requirements:

- `POST /api/agent/command` must accept:

```json
{
  "text": "Make a loose game inspiration board...",
  "mode": "codex",
  "candidateLimit": 200,
  "dryRun": false,
  "reasoningEffort": "medium"
}
```

- If `mode === "codex"`, instantiate or reuse `CodexSdkProvider` and pass it to `runAgentCommand`.
- Keep one warm provider/thread for the server process when possible.
- Keep heuristic mode available as fallback and for tests.
- Return `codexTurnSpent`, provider label, and, if available, thread ID.
- Insert one `agent_runs` row for every Codex planning turn, including purpose, input summary, output summary, schema ID, validation status, usage, and error if any.

UI requirements:

- Add a planner mode control: `Codex agent` / `Fast heuristic preview`.
- Default should be `Codex agent` now.
- Show a small badge on results:
  - `Codex used: yes/no`;
  - `Mode: codex/heuristic`;
  - validation status;
  - no browser tabs changed.
- Keep a user-visible fallback button: `Retry with heuristic` if Codex fails.

Testing requirements:

- Unit test `runAgentCommand(... mode: 'codex')` with a fake provider that returns valid `SemanticViewPlan` JSON and assert the provider is called.
- Unit test invalid Codex JSON triggers structured reask or fails clearly.
- Integration smoke script for one real Codex command over a tiny fixture. The user has approved spending turns, so run it deliberately and report output.

Suggested commit:

```bash
git add .
git commit -m "Wire Codex into agent command planning"
```

### 2. Add a Codex scanning / knowledge-building run

The current app can group by command, but it does not yet do the important pre-scan that turns links into reusable knowledge. Add an explicit local command:

```bash
npm run scan:codex -- --limit 100 --batch-size 20
```

And a server endpoint:

```text
POST /api/agent/scan
```

Purpose: Codex reads batches of `ResourceBrief`s and creates durable knowledge artifacts that future grouping commands can reuse quickly.

For each resource, store a `codex_resource_analysis.v1` extraction artifact:

```json
{
  "summary": "What this link seems useful for",
  "contentKind": "youtube_video | article | docs | repo | search | unknown",
  "userPurposeGuess": "watch_later | inspiration | reference | ignore_candidate | needs_review",
  "topics": ["game design", "inventory UI", "level moodboard"],
  "suggestedTags": ["game", "ui", "inspiration"],
  "confidence": 0.0,
  "evidenceRefs": ["user_annotation:...", "ev_title_...", "art_..."],
  "missingEvidence": ["transcript", "description"]
}
```

Also store `atomic_items` when a resource contains multiple meaningful things:

- one video that lists several papers;
- one article that links many tools;
- one GitHub repo with separate ideas: extension, receiver, SQLite, UI;
- one YouTube playlist / collection.

Atomic item rules:

- Do not create atomic items from thin evidence.
- Every atomic item must have evidence refs.
- User annotations still outrank Codex guesses.
- If Codex is unsure, create `needs_review` rather than pretending.

Suggested commit:

```bash
git add .
git commit -m "Add Codex resource scanning artifacts"
```

### 3. Improve candidate selection for complex user commands

Current candidate retrieval derives keywords from the command and searches FTS. That is fine for MVP, but complex commands can miss resources that do not share obvious keywords.

Implement a broader candidate policy:

1. Always include all user-marked resources when the command references taste/purpose words like `inspiration`, `important`, `reference`, `later`, `project`, `ignore`, `archive`.
2. Include FTS matches from user text, extracted text, browser group titles, title, and URL.
3. Include existing Codex scan topics/suggested tags once scan artifacts exist.
4. Include recent resources up to a configurable cap.
5. For large libraries, chunk candidates and ask Codex to reduce/merge.

Large-library flow:

```text
1000 resources
  -> deterministic candidate broad pass
  -> chunks of 50-100 briefs
  -> Codex chunk planner returns includes/excludes/uncertain
  -> merge planner reconciles sections/conflicts
  -> persist final proposed view
```

Do not force all resources into the Codex context at once.

Suggested commit:

```bash
git add .
git commit -m "Broaden agent candidate selection"
```

### 4. Make the agent feel like the main interface

The UI is currently useful but still looks like a control panel. The next UI pass should make the agent interaction dominant.

Add:

- command history;
- view refinement box: `Refine this: exclude pure tutorials, keep only inspiration`;
- `Why included?` buttons on samples that call `explainMembership`;
- weak/conflict/needs-review filters;
- `Review ambiguous items` button opening the command-specific review queue;
- command examples based on current data counts.

The focused review panel should get:

- keyboard shortcuts from `docs/16-focused-review-tagging.md`;
- quick chip customization based on frequent user tags;
- visible next two preloaded items;
- optional thumbnail/embed metadata later, but metadata preview first.

Suggested commit:

```bash
git add .
git commit -m "Make agent command center primary UI"
```

### 5. YouTube and generic extraction next steps

The stub extraction is correct as a safe base. Now add optional adapters, each with provenance and failure states.

YouTube adapter policy:

- First parse URL and keep metadata stub.
- Add optional YouTube Data API metadata adapter only if configured.
- Add optional transcript adapter only behind explicit config and provenance.
- Never call transcript unavailable content a transcript.
- Store transcript status:
  - `not_attempted`;
  - `available_artifact`;
  - `blocked_auth_required`;
  - `not_available`;
  - `adapter_disabled`;
  - `adapter_failed`.

Generic page adapter policy:

- Add safe HTTP metadata fetch with strict timeout.
- Deny private/local addresses and file URLs.
- Do not send cookies.
- Save title/meta description/main excerpt if available.
- Save `blocked_auth_required`, `blocked_policy`, `failed_network`, or `failed_parse` honestly.

Suggested commit:

```bash
git add .
git commit -m "Add optional metadata adapters"
```

## Codex prompt behavior for the app agent

When planning a view, the system prompt should enforce:

- user notes/tags are primary evidence;
- extracted metadata and transcript artifacts are secondary;
- title/URL are weak evidence;
- the same resource may belong to many views;
- do not create rigid categories;
- output only schema-valid `SemanticViewPlan`;
- include weak/conflict/needs_review states instead of overclaiming;
- cite evidence refs for every include/conflict;
- no browser mutation.

For user commands like:

```text
Make a loose group mainly game inspiration but welcome all other inspiration.
```

Codex should be allowed to produce:

```text
Loose inspiration
  - Game-centered inspiration
  - Cross-domain inspiration
  - Needs review
```

For:

```text
Make an art inspiration group.
```

A game video should be included only if user notes or extracted evidence indicate visual/style/UI/art relevance.

For:

```text
Make a project group for this tab-manager app.
```

Codex should find browser extension, Codex CLI, SQLite, local receiver, YouTube transcript, UI design, privacy/safety, and installer resources even if they do not all share the same keywords.

## Report required from next agent

Use `docs/13-agent-report-template.md` and include:

- latest commit SHA;
- commits created;
- validation output summary;
- real Codex smoke command run and result;
- number of Codex turns spent, if known;
- whether `/api/agent/command` supports `mode: "codex"`;
- whether UI defaults to Codex agent mode;
- whether Codex scan artifacts are implemented;
- manual UI flow tested;
- any limitations with transcripts or generic page extraction;
- confirmation: no browser mutation, no cookie/password/session parsing, no hidden full-page browsing by Codex.

## Copy-paste mini-prompt for implementation agent

```text
Continue TabAtlas from latest main. Read docs/22-codex-active-agent-handoff.md first.

The user has approved using Codex subscription turns. Stop treating Codex spending as a blocker. Keep heuristic mode only as fallback/test mode.

Main target:
1. Wire Codex mode into /api/agent/command and the UI, defaulting to Codex agent mode.
2. Log Codex turns in agent_runs.
3. Add tests using a fake provider for codex mode.
4. Run one real Codex smoke command over a tiny fixture and report the result.
5. Add Codex resource scanning artifacts if time allows.

Do not add browser mutation, transcript scraping by default, cookies/session parsing, or cloud sync beyond explicit Codex prompt usage.

Run npm run typecheck, npm test, npm run lint, and a local UI smoke. Commit all work and report commit SHA.
```
