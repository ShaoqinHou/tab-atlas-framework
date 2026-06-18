# TabAtlas Live Acceptance

Use this skill when the task is to prove TabAtlas is release-ready rather than add more product features.

## Order

1. Run `npm run acceptance:ports`.
2. Build extension and app packages.
3. Run Chrome popup smoke and Edge popup smoke against `http://127.0.0.1:9787`.
4. Run private-library smoke locally and report only redacted metrics.
5. Validate the redacted report with `npm run acceptance:report -- <path>`.

## Privacy Rules

Do not commit private URLs, titles, prompt bodies, local tokens, raw snapshots, SQLite DBs, or raw acceptance reports.

Use `.local/acceptance` for local-only reports. It is gitignored.

## Definition

Release-ready means the typed `LiveAcceptanceReport` validates, has no blockers, and `releaseReady` is true.
