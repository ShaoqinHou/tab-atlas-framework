---
name: tab-atlas-acceptance-closure
description: Finish or audit TabAtlas release acceptance, browser extension smoke evidence, private-library Codex acceptance, and release packaging.
---

# TabAtlas Acceptance Closure

Use this skill when working on final TabAtlas acceptance or release-readiness claims.

Read first:

1. `docs/32-acceptance-closure-handoff.md`
2. `src/acceptance/contracts.ts`
3. `scripts/chromium-extension-acceptance.ts`
4. `scripts/live-browser-acceptance.ts`
5. `scripts/private-library-acceptance.ts`
6. `scripts/acceptance-report.ts`

Rules:

- Use Playwright bundled Chromium for automated extension smoke.
- Use manual Developer mode and Load unpacked for actual Chrome and Edge acceptance.
- Keep all acceptance artifacts under ignored `.local/acceptance`.
- Do not store private URLs, titles, raw prompts, extension tokens, pairing secrets, or raw snapshots in committed files.
- Treat `releaseReady` in a report as an input claim only; derive readiness from evidence.
- Private-library acceptance must use Codex mode for release claims and must retain exact retrieval run IDs, prompt manifest IDs, provider scope/thread, agent run ID, duration, and usage.
- Hierarchical semantic planning must preserve chunk conflicts and surface unresolved targets as review work, not silently drop them.
