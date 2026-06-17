# TabAtlas implementation report

Repo path:
C:\Users\housh\Documents\Codex\2026-06-17\i-tend-to-have-many-tags\outputs\tab-atlas-framework\tab-atlas-framework

Branch:
main

Latest commit SHA:
See `git log -1 --format=%H` after this report commit is created.

Commit messages created:
- Add Codex resource scanning artifacts

Phases completed:
- Phase 0 scaffold compile: yes
- Phase 1 import/store foundation: yes
- Phase 2 focused review/user annotations: yes
- Phase 3 extraction pipeline: yes
- Phase 4 semantic view planning: yes
- Phase 5 Codex integration: yes
- Phase 6 UI MVP: yes
- Phase 7 reusable Codex scan knowledge: partial, initial scan artifact and atomic item layer implemented

What I implemented:
- Added `npm run scan:codex -- --limit 100 --batch-size 20`.
- Added `POST /api/agent/scan`.
- Added `codex_resource_analysis.v1` extraction artifacts with structured Codex scan output.
- Added Codex-created atomic item persistence for dense resources.
- Logged each scan batch in `agent_runs`.
- Refreshed resource FTS after scan artifacts so future search/planning can use scan summaries, topics, suggested tags, missing evidence, and atomic item text.
- Made semantic planning prompts explicitly allow atomic-item membership when it better fits the command.
- Added command history, refine view, Why included, state filters, scan button, and scan/agent/atomic counters to the UI.
- Fixed first-call `providerThreadId` reporting and stopped assuming one quota turn on structured-output validation failure.
- Hid unknown mode badges for stored view previews.
- Added `agent_runs`, scan artifact, and atomic item counts to `/api/status`.

Agent-first UX status:
- Command bar implemented: yes
- Semantic view preview implemented: yes
- Agent tool services implemented: yes
- Membership explanation implemented: yes
- Command history implemented: yes
- View refinement implemented: partial, creates a new refined proposed view seeded by the prior view resources
- Weak/conflict/review filters implemented: yes

Focused review status:
- Unmarked queue implemented: yes
- Next-item preload implemented: yes
- Save tag/description implemented: yes
- Skip behavior implemented: yes
- User annotations included first in ResourceBrief: yes

Semantic grouping behavior tests:
- User note outranks misleading title: pass
- Strict game inspiration excludes unrelated art unless user-marked: pass
- Loose inspiration includes cross-domain marked inspiration: pass
- Skipped focused-review items are not lost: pass
- Scan artifact topic found by search when title lacks the words: pass
- Atomic item included in planner brief and usable as a membership target: pass
- User annotation outranks conflicting Codex suggested tag: pass

Validation commands run:
- npm install: not run, no dependency changes
- npm run typecheck: pass
- npm test: pass, 11 files and 29 tests
- npm run lint: pass
- npm run scan:codex -- --limit 10 --batch-size 5: pass, 10 resources scanned, 10 artifacts written, 12 atomic items written, 2 batches, 2 Codex turns

Browser/capture testing:
- Imported sample fixture: yes, through tests
- Imported real latest-all.json: yes, through local API smoke
- Chrome/Edge extension tested: not changed in this slice

Codex integration:
- SDK route status: pass for scan and one small project-planning command
- exec fallback status: not used
- Number of paid/subscription Codex turns used: 5 known successful turns in this slice; 2 for scan smoke and 3 for one project command. One earlier schema-validation request failed before usage was reported.
- Scan artifacts created in local DB during smoke: 10
- Atomic items created in local DB during smoke: 12
- Semantic view planning uses scan artifacts: yes, through ResourceBrief evidence and FTS candidate selection; tests cover prompt inclusion and search behavior

Manual UI smoke:
- Imported latest capture: pass
- Ran deterministic extraction: pass
- Ran Codex scan for 10 resources: pass
- Asked `Make a project group for this tab-manager app.`: pass with Codex, providerThreadId returned on first successful call
- Asked `Make a loose group mainly game inspiration but welcome all marked inspiration.`: pass with heuristic fallback for timely UI smoke
- Confirmed scan artifacts influence results: pass; search for `monthly game projects indie production` ranked a scanned artifact first with extracted-evidence reasons
- Used Why included on strong item: pass
- Used Why included on weak item: pass
- Confirmed no browser tabs were mutated: pass

Security/privacy checks:
- Server bind address: 127.0.0.1
- Any cloud/API calls added: no new always-on calls; approved Codex SDK calls occur only when scan or Codex planning is invoked
- Any browser profile/session/cookie parsing added: no
- Transcript adapter status: not attempted by default
- Any browser mutation implemented: no
- Hidden full-page browsing by Codex: no, scan prompt and Codex SDK use supplied local briefs only

Known issues:
- Scan staleness uses existing artifact and annotation timestamps; it does not yet persist a separate dependency hash.
- Refinement creates a new proposed view rather than editing an existing view in place.
- Real Codex command planning can still be slow for large candidate sets; the smoke used a 10-resource cap for the Codex project command.

Files changed summary:
- `src/agent/scanService.ts`: Codex scan selection, validation, persistence, FTS refresh, counters.
- `scripts/scan-codex.ts`: headless CLI scan entry point.
- `src/server/index.ts`: scan/refine/commands endpoints and status counters.
- `web-ui/index.html`: scan/history/refine/why/filter UI.
- `src/agent/commandService.ts`: seed resources for refine, first-call thread ID, better failure usage.
- `src/llm/runStructured.ts`: structured-output error now carries accumulated usage.
- `src/db/schema.sql`: atomic item resource index.
- `knowledge/prompts/semantic-view-planner.system.md`: atomic item planner guidance.
- `tests/codexScan.test.ts`: scan artifact, atomic item, and user-priority coverage.

Questions for project lead:
- Should refined views update the prior view in place, or should they continue creating versioned proposed views?
- Should scan staleness move from timestamp comparison to a content/dependency hash before larger scans?
