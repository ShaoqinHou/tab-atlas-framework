# TabAtlas Framework

TabAtlas is a local-first, Codex-powered web app concept and implementation scaffold for turning hundreds or thousands of open Chrome and Edge tabs into an AI-navigable personal knowledge map.

The app starts from your existing **Headless Tab Exporter** idea: a passive Manifest V3 extension sends tab/window/tab-group snapshots to a localhost receiver only when the receiver is running. TabAtlas then enriches those URLs with fast deterministic extractors, stores stable evidence in SQLite, and gives the built-in local agent a safe tool layer for grouping, reviewing, tagging, and explaining the tab pile.

## Core product stance

TabAtlas is **not** primarily a folder tree, bookmark manager, or static tag list. It is an **agent-first link workspace**:

- the user talks to the built-in agent;
- Codex interprets fuzzy grouping ideas;
- the app uses stored metadata, extracted text, user tags, and user notes as evidence;
- the UI changes by creating, refining, pinning, or hiding dynamic views;
- every grouping is a reversible lens over the same resources.

The user should be able to say:

> "Make a game inspiration board, but include videos that are mostly art/design if I marked them as useful for game ideas. Do not include pure art references unless they help game design."

or:

> "Create a loose inspiration view: mostly games, but allow any video/article I described as inspiration. Keep tools/docs separate unless I said they are references for a project."

TabAtlas should use the existing scan output and user annotations to answer quickly; it should not re-open every page through Codex.

## What is inside this zip

- Product and technical specs in `docs/`.
- A Codex-agent handoff prompt in `HANDOFF_PROMPT_FOR_CODEX_AGENT.md`.
- Repo-local agent instructions in `AGENTS.md` and `.agents/skills/`.
- Typed knowledge-system seed files in `knowledge/`.
- TypeScript implementation scaffolding in `src/`, `extension/`, and `scripts/`.
- Database schema in `src/db/schema.sql`.
- UI interaction wireframes in `web-ui/wireframe.md`.

## Updated must-read docs

Read these before implementation:

1. `docs/15-agent-first-ux-contract.md`
2. `docs/16-focused-review-tagging.md`
3. `docs/17-semantic-view-planning.md`
4. `docs/18-agent-tool-protocol.md`
5. `docs/19-resource-brief-spec.md`
6. `docs/20-v2-product-audit.md`

These files define the real product shape: the built-in Codex agent controls grouping through safe app tools, user notes outrank AI guesses, and the focused review screen lets the user rapidly mark unreviewed links one by one.

## Recommended implementation stance

Build this as a **Windows local app served on 127.0.0.1**, not as a cloud service:

1. Browser extensions export snapshots.
2. Local receiver imports snapshots.
3. Extractor workers enrich resources with non-cookie, programmatic metadata.
4. Users optionally add quick tags/descriptions in a focused review queue.
5. Codex runs local structured reasoning over resource briefs and user annotations.
6. UI shows agent-created dynamic views, membership reasons, and approval queues.

## Non-negotiables

- Do not parse raw browser profile/session/cookie/password files.
- Do not upload tab data to cloud services.
- Do not let Codex freely open every URL.
- Do not close, bookmark, move, or group browser tabs without explicit user approval.
- Treat user tags and user descriptions as high-priority evidence.
- Treat official transcript access limits honestly. For arbitrary YouTube videos, official captions download is not a universal public-transcript API; use an adapter model with clear provenance and fallback behavior.

## Start points for the local coding agent

1. Read `HANDOFF_PROMPT_FOR_CODEX_AGENT.md`.
2. Read `docs/15-agent-first-ux-contract.md` and `docs/16-focused-review-tagging.md`.
3. Implement Phase 0, Phase 1, and the focused review skeleton first.
4. Commit all changes, then report using `docs/13-agent-report-template.md`.
