# TabAtlas durable intelligence

Use this skill when changing Codex scanning, long-running extraction, semantic view refinement, or user feedback memory.

## Product invariants

- A semantic view is a purpose-specific lens, never the resource's one permanent category.
- User notes, tags, corrections, pinned inclusions, and pinned exclusions outrank Codex-derived evidence.
- Codex scan output is reusable evidence, not user truth.
- No browser mutation occurs without a separate explicit approval design.
- No transcript claim exists without a transcript artifact and provenance.
- Do not rescan unchanged resources merely because a timestamp changed.
- Long scans must be resumable, observable, and cancellable.

## Required architecture

1. Compute a dependency hash from user-authored evidence and deterministic extraction evidence.
2. Exclude the resource's own Codex scan artifact and Codex-created atomic items from that hash.
3. Create a durable job and one or more deterministic job items.
4. Persist per-item success/failure before moving to the next item.
5. Mark knowledge fresh only after artifact and atomic-item persistence succeeds.
6. Replace or supersede stale Codex-created atomic items; never accumulate contradictory generations silently.
7. Create a new view revision for refinements. Preserve the parent revision and accepted history.
8. Store explicit membership feedback and add it to future briefs as primary evidence.

## Implementation order

- Read `docs/25-durable-intelligence-runtime-handoff.md`.
- Use `src/knowledge/dependencyHash.ts` rather than timestamp-only staleness.
- Use `src/jobs/contracts.ts` and `src/jobs/service.ts` for durable work.
- Use `src/views/feedbackService.ts` for view lineage and correction evidence.
- Integrate the scaffold into `scanService`, server endpoints, and UI; do not create parallel competing systems.

## Validation

Run:

```bash
npm run typecheck
npm test
npm run lint
```

Then perform a restart-resume smoke:

1. Start a Codex scan job.
2. Complete at least one item.
3. restart the server/worker.
4. resume the same job without repeating successful items.
5. change one user note and confirm only that resource becomes stale.
6. refine an accepted view and confirm the original revision is still available.
