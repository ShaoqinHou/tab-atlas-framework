# Acceptance Closure Handoff

This repo now separates browser acceptance into three honest lanes:

- `npm run acceptance:chromium` runs automated extension acceptance with Playwright bundled Chromium in a persistent context. It defaults to `http://127.0.0.1:9786`, starts a temporary receiver if needed, pairs through the real popup, exports a snapshot, revokes the extension capability, and writes redacted evidence to `.local/acceptance/chromium-smoke.json`.
- `npm run acceptance:browser` generates the Chrome and Edge manual acceptance template. Installed Chrome and Edge should use Developer mode and Load unpacked; command-line sideload automation is intentionally not used.
- `npm run acceptance:private-library -- --mode codex --resume` runs the four private-library commands with checkpoints in `.local/acceptance/private-library-checkpoints.json`, one row per command, exact retrieval run IDs, prompt manifest IDs, provider scope/thread, duration, and real usage.

Release readiness is derived by `npm run acceptance:report -- <redacted-report.json>`. The validator ignores caller-provided `releaseReady`, verifies validation command outcomes, checks package existence, computes SHA-256 hashes, inspects required archive contents, requires Chromium/Chrome/Edge browser rows, requires all private-library Codex commands to pass, and applies safety flags.

Large semantic planning now flows through `planSemanticViewHierarchical`. Small candidate sets still use direct planning. Large candidate sets are split into deterministic chunks, checkpointed, pre-merged with conflict preservation, and merged back into the normal `SemanticViewPlan` shape.

Developer release helpers:

- `scripts/start-tabatlas.ps1`
- `scripts/check-tabatlas.ps1`
- `scripts/backup-tabatlas.ps1`
- `scripts/restore-tabatlas.ps1`
- `npm run release:manifest`

Do not report release-ready unless the automated Chromium row, manual Chrome row, manual Edge row, all four real private-library Codex commands, package hashes/content checks, and safety checks pass.
