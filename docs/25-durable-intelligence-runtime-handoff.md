# Durable intelligence runtime handoff

This follows local-agent commit `f5a659a412dd3015af067a8a2d563d9e86eafbb2`.

## Audit

The claimed Codex scan artifact, atomic-item, FTS, command-history, refinement, explanation, filter, and counter work is present in the repo. The exact local command outputs and Codex turn counts were not rerun in the project-lead environment.

The next blockers are scalability and learning:

- timestamp-only scan freshness can rescan unchanged resources;
- scan requests are synchronous and cannot safely resume after restart;
- one failed batch stops the run;
- old Codex-created atomic items can remain active after a new scan omits them;
- refined views have no explicit revision lineage;
- membership corrections are not reused as evidence.

## Project-lead scaffold already added

```text
src/knowledge/dependencyHash.ts
src/jobs/contracts.ts
src/jobs/service.ts
src/db/schema-v2-durable.sql
src/views/feedbackService.ts
tests/dependencyHash.test.ts
tests/jobService.test.ts
tests/viewFeedback.test.ts
.agents/skills/tab-atlas-durable-intelligence/SKILL.md
```

`src/db/index.ts` now loads the durable schema.

## Required implementation stride

1. Replace timestamp-only Codex scan selection with `computeResourceKnowledgeDependencyHash` and `resource_knowledge_state`.
2. Move long scans to durable SQLite jobs. Creation returns immediately; progress, retry, cancellation, and restart/resume use `jobs` and `job_items`.
3. Make scan artifact, current atomic items, FTS refresh, knowledge state, and job-item completion one transaction per resource.
4. Supersede or remove Codex-created atomic items omitted by a newer generation.
5. Treat accepted views as immutable revisions. Refinement creates a child revision; acceptance supersedes rather than deletes the prior revision.
6. Add per-membership reject/correct/pin actions and include that feedback ahead of Codex evidence in future briefs.
7. Bound Codex thread lifetime and prompt size for large scans. Split failed batches and preserve completed items.

## Acceptance smoke

- Process 5 of 20 job items, restart, then resume the remaining 15 without repetition.
- Re-run unchanged deterministic extraction and confirm no rescan.
- Change one user note and confirm only that resource becomes stale.
- Rescan four atomic items down to two and confirm only the current two remain active.
- Refine an accepted view, reject the child revision, and confirm the original remains accepted.
- Pin-exclude a membership and confirm a later relevant plan respects or surfaces the conflict.

## Local coding-agent prompt

```text
Continue TabAtlas from latest main. Read docs/25-durable-intelligence-runtime-handoff.md and .agents/skills/tab-atlas-durable-intelligence/SKILL.md first.

Compile and test the project-lead scaffold before replacing anything. Repair small issues in place.

Implement hash-based scan freshness, durable scan jobs, coherent atomic-item generations, immutable view revisions, membership feedback evidence, and bounded Codex batching.

Run npm run typecheck, npm test, npm run lint, a real Codex scan, and a restart/resume smoke. Commit in coherent phases and report validation, scan skip counts, job recovery, atomic-item generation behavior, revision behavior, and feedback behavior.
```
