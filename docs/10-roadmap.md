# Roadmap

## Phase 0: Repo and skeleton

- Initialize Git repo.
- Add TypeScript project.
- Add database schema.
- Add AGENTS.md and knowledge seed files.
- Add smoke tests/stubs.

## Phase 1: Import and raw browsing map

- Import `latest-all.json` / TSV from Headless Tab Exporter.
- Normalize resources.
- Store snapshots/resources in SQLite.
- Show raw counts and raw tab table.
- Implement duplicate detection by canonical URL.

Success: user can import 235 tabs and see unique resources and browser group metadata.

## Phase 2: Deterministic extraction v1

- Generic metadata fetcher.
- YouTube URL parser and metadata adapter.
- Extraction artifacts table.
- Rate limits and failure statuses.
- Privacy redaction.

Success: resources have extracted briefs without Codex.

## Phase 3: Codex structured categorizer

- Implement Codex SDK provider.
- Implement `runStructured` validation/reask path.
- Add stub provider tests.
- Categorize a batch into tags/views/memberships.
- Store agent runs and evidence.

Success: user can run "Organize current tabs" and get proposed views.

## Phase 4: UI MVP

- Local web UI.
- Capture status.
- Dynamic view cards.
- Resource detail page.
- Evidence inspector.
- Command bar for view refinement.

Success: user navigates tabs by meaning instead of a giant list.

## Phase 5: Browser action approval queue

- Propose browser changes.
- User reviews actions.
- Extension performs approved tab-group/bookmark/close operations.
- Undo/export safety.

Success: user can safely close/archive tabs after reviewing.

## Phase 6: Advanced knowledge map

- Atomic item extraction from YouTube/video descriptions/transcripts.
- Graph view.
- Cross-resource relationships.
- Project memory/preferences.
- Better duplicate and stale-tab detection.

## Phase 7: Packaging

- Windows launcher.
- Installer or portable bundle.
- Optional tray app.
- Backup/export/restore.

## Future ideas

- Local embedding model for semantic search.
- Browser side panel.
- "Tab debt" score.
- Time-based triage: opened long ago, active recently, never revisited.
- Shared/exportable reading lists.
- Integration with bookmarks/read-it-later tools.
- Local OCR/screenshot only with explicit permission.
