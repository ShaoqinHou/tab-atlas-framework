# Durable intelligence runtime implementation report

Date: 2026-06-18 NZT

Latest commit SHA:
See `git log -1 --format=%H` after this report commit is created.

Commits created:
- Integrate durable intelligence runtime

What changed:
- Replaced timestamp-only Codex scan freshness with `computeResourceKnowledgeDependencyHash` and `resource_knowledge_state`.
- Added durable Codex scan job creation, progress, cancellation, and resume APIs.
- Updated scan persistence so each resource writes scan artifact, current Codex atomic items, FTS text, knowledge state, and optional job item completion together.
- Replaced obsolete Codex-created atomic items on each new generation.
- Excluded prior Codex scan artifacts and generated atomic items from future scan prompts.
- Added prompt-size bounded scan batching.
- Added immutable view revision creation during view persistence.
- Added parent revision linkage for refinement.
- Added revision accept/reject/compare APIs.
- Added membership feedback API and UI controls for reject, pin include, and pin exclude.
- Injected membership feedback evidence into `ResourceBrief` before browser groups and Codex evidence.
- Updated heuristic grouping to respect pin include/exclude and prior rejection as high-priority evidence.
- Added durable job UI listing with queued/running/succeeded/failed/skipped/cancelled counts.

Validation:
- `npm run typecheck`: pass
- `npm test`: pass, 14 files and 42 tests
- `npm run lint`: pass

Real Codex scan:
- Command: `npm run scan:codex -- --limit 2 --batch-size 2 --reasoning-effort low`
- Result: 2 resources scanned, 2 artifacts written, 0 atomic items written, 1 batch, 1 Codex turn

Restart/resume smoke:
- Created a 20-item scan job on a temporary SQLite DB.
- Processed first 5 items.
- Reopened the DB to simulate restart.
- Resumed the remaining 15.
- Final job state: succeeded, 20 succeeded, no repeated completed items.

Freshness smoke:
- Re-ran deterministic extraction after scan: queued 0, skipped fresh 20.
- Changed one user note: queued 1, skipped fresh 19.
- Codex scan output did not stale resources because the dependency hash excludes Codex scan evidence and generated atomic items.

Atomic generation smoke:
- First scan wrote four atomic items.
- Forced rescan returned two atomic items.
- Active DB items after rescan: `Four`, `One`.

View revision smoke:
- Tests cover accepted parent revision plus rejected child revision.
- Rejecting the child leaves the parent revision and parent view accepted.

Membership feedback smoke:
- Tests cover pin-exclude feedback becoming first evidence in `ResourceBrief`.
- Later heuristic grouping surfaces the feedback as a conflict with feedback evidence refs.

Known limitations:
- Durable resume currently processes one claimed resource per Codex call for restart safety; batching and split-on-failure can be expanded from this foundation.
- View comparison currently returns both snapshots; it does not yet compute a rich semantic diff.
- Feedback controls cover reject/pin include/pin exclude; freeform section correction can be recorded through the API but is not yet a polished UI control.
- Job execution is explicit through resume; there is no background worker loop yet.

Safety:
- No browser mutation added.
- No raw browser profile, cookie, password, local-storage, or session parsing added.
- No default transcript scraping added.
- No hidden full-page browsing by Codex added.
- Server remains local-only on `127.0.0.1`.
