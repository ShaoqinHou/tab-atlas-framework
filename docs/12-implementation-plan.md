# Implementation Plan for Local Coding Agent

## Role

You are the implementation agent. Treat this zip as product leadership and architecture. Your job is to turn it into a working local repo incrementally, with commits and validation.

The product lead clarified that TabAtlas must be **agent-first**. A giant tab list is not enough. The user should mainly interact with the built-in Codex-powered agent, and the agent should use safe app tools plus user annotations to create flexible semantic views.

## Required first actions

```powershell
cd "$env:USERPROFILE\Downloads\tab-atlas-framework"
git init
git branch -M main
git status --short
git add .
git commit -m "Add TabAtlas product framework"
```

If the folder has a different extracted name, adapt the path and report it.

## Mandatory reading order

1. `README.md`
2. `AGENTS.md`
3. `docs/15-agent-first-ux-contract.md`
4. `docs/16-focused-review-tagging.md`
5. `docs/17-semantic-view-planning.md`
6. `docs/18-agent-tool-protocol.md`
7. `docs/19-resource-brief-spec.md`
8. `docs/20-v2-product-audit.md`
9. `docs/00-current-setup-integration.md`
10. `docs/06-codex-integration.md`
11. `docs/08-security-privacy.md`

## Phase 0 tasks — make scaffold real

- Verify package scripts.
- Make TypeScript compile.
- Add missing exports/imports.
- Ensure no network calls run in tests.
- Ensure `StubProvider` can run categorization/semantic-view tests without Codex.
- Validate JSON schemas parse.
- Commit:

```powershell
git add .
git commit -m "Make TabAtlas scaffold compile"
```

## Phase 1 tasks — import/store/review foundation

- Implement importer for the Headless Tab Exporter JSON/TSV shape.
- Implement URL normalization and hashing.
- Create SQLite database and insert snapshots/resources/tab observations.
- Add user annotation tables.
- Add review queue tables.
- Add semantic view tables/membership states.
- Add fixtures using `tests/fixture-snapshot.json`.
- Add CLI:

```powershell
npm run import -- --file path\to\latest-all.json
```

- Commit:

```powershell
git add .
git commit -m "Import tab snapshots into local store"
```

## Phase 2 tasks — focused review MVP

- Implement resource brief builder where user annotations appear first.
- Implement focused review service/endpoints:
  - get next unmarked resource;
  - preload next two briefs;
  - save tags/description/decision;
  - skip;
  - mark ignore;
  - open external link action metadata only.
- Minimal UI/wireframe is acceptable, but user must be able to quick-mark one resource then advance.
- Add tests that a user note is stored and appears in the resource brief before title/extracted evidence.
- Commit:

```powershell
git add .
git commit -m "Add focused review and user annotations"
```

## Phase 3 tasks — deterministic extraction

- Implement generic metadata extractor.
- Implement YouTube URL parser and metadata artifact shape.
- Implement extraction status and failures.
- Do not implement unofficial transcript scraping yet.
- Keep transcript status explicit.
- Commit:

```powershell
git add .
git commit -m "Add deterministic extraction pipeline"
```

## Phase 4 tasks — semantic view planning with stub provider

- Implement `searchResources` and `getResourceBriefs` service functions.
- Implement `planSemanticView` using `StubProvider` first.
- Validate against `SemanticViewPlan` schema.
- Store proposed views/memberships with states: `strong_include`, `weak_include`, `conflict`, `exclude`, `needs_review`.
- Add tests for:
  - user note outranks misleading title;
  - strict game inspiration excludes pure art unless user-marked;
  - loose inspiration includes cross-domain user-marked inspiration.
- Commit:

```powershell
git add .
git commit -m "Add semantic view planning"
```

## Phase 5 tasks — Codex integration

- Implement Codex SDK provider if available.
- Implement `codex exec` fallback if SDK fails or is unavailable.
- Implement structured categorization/view planning with zod validation and reask.
- Add a one-turn smoke test, not in CI.
- Add debug count for Codex turns.
- Commit:

```powershell
git add .
git commit -m "Add Codex-backed semantic planning"
```

## Phase 6 tasks — local UI MVP

- Build local UI with capture status, agent command center, view previews, focused review, resource detail, evidence explanation.
- No browser mutation yet.
- Commit:

```powershell
git add .
git commit -m "Add local TabAtlas UI MVP"
```

## Validation commands

Run whatever becomes appropriate, but at minimum:

```powershell
npm install
npm run typecheck
npm test
npm run lint
```

If a command is not implemented, either implement it or report why it is not ready.

## What not to do

- Do not upload tabs to cloud services.
- Do not add API-key-only LLM dependency.
- Do not parse cookies, passwords, local storage, or browser session files.
- Do not implement automatic tab closing/moving in the first pass.
- Do not enable unofficial transcript scraping without a clear opt-in adapter and report.
- Do not hide failing tests.
- Do not build a rigid category tree as the core product.
- Do not put user annotation support after UI polish; it is core.

## Final report required

Use `docs/13-agent-report-template.md` and include:

- commit SHA;
- validation output summary;
- tests run;
- whether Codex smoke test was run;
- whether any subscription Codex turns were spent;
- which phases are complete;
- blockers or design questions.
