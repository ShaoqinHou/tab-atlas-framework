# Live Acceptance Release Handoff

TabAtlas is implementation-rich enough that the next milestone is acceptance, not new product surface.

The release candidate must prove these real-world paths before being called ready:

1. Runtime server URL is covered by the extension receiver list, manifest host permissions, and popup default.
2. Chrome pairs through the extension popup, exports through the popup, and shows revoked/unpaired state after capability revocation.
3. Edge pairs through the extension popup, exports through the popup, and shows revoked/unpaired state after capability revocation.
4. Private-library grouping smoke is run locally and reported only as redacted metrics.
5. App and extension release packages exist.
6. Install, update, backup, restore, rollback, capture-root, Codex auth, privacy, and troubleshooting docs are present.
7. Raw private URLs, titles, prompt bodies, local tokens, DB snapshots, and raw acceptance reports are not committed.

## Local Acceptance Files

Use these commands:

```powershell
npm run acceptance:ports
npm run acceptance:browser
npm run acceptance:private-library
npm run package:extension
npm run package:app
npm run acceptance:report -- .local\acceptance\live-acceptance-redacted.json
```

`.local/acceptance` is intentionally ignored. Keep private smoke outputs there.

## Required Report Shape

The final redacted report must validate against `LiveAcceptanceReport` in `src/acceptance/contracts.ts`.

The validator fails if runtime ports are incompatible, Chrome/Edge popup acceptance is incomplete, private-library smoke is skipped, safety flags indicate committed private data, or release package paths are missing.

## Runtime Port Standard

The release standard server URL is:

```text
http://127.0.0.1:9787
```

If a smoke run uses a different port, either rebuild/package the extension for that port or mark the report blocked. Do not silently use an uncovered port.
