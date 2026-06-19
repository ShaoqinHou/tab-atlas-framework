# TabAtlas Framework

TabAtlas is a Windows local-first receiver, browser extension, and Codex-powered tab workspace for turning large Chrome and Edge tab sets into an AI-navigable personal knowledge map.

The receiver binds to `127.0.0.1`; the Manifest V3 extension is passive until the local receiver is running and a pairing challenge is exchanged through the popup. Snapshots are stored locally in SQLite, enriched with deterministic extractors, and exposed to a local Codex agent through scoped app tools.

## Safety Model

- Do not parse browser profile, session, cookie, password, or history databases.
- Do not upload tab data to cloud services as a background sync path.
- Do not let Codex freely open every URL.
- Do not close, bookmark, move, or group browser tabs without explicit user approval.
- User tags and descriptions outrank inferred metadata.
- Extension pairing secrets are shown once and are not written to redacted reports.

## Quick Start

Install dependencies:

```powershell
npm install
```

Start the local receiver:

```powershell
.\scripts\start-tabatlas.ps1
```

Check the local installation:

```powershell
.\scripts\check-tabatlas.ps1
```

Package the extension and load it unpacked from `release\tabatlas-extension`:

```powershell
npm run package:extension
```

Chrome uses `chrome://extensions`; Edge uses `edge://extensions`. Enable Developer mode, choose Load unpacked, and select the packaged extension directory.

## Product Browser Acceptance

Run the evidence-backed acceptance flow separately for Chrome and Edge while the receiver is running:

```powershell
npm run acceptance:product-browsers -- --browser chrome
npm run acceptance:product-browsers -- --browser edge
```

The command creates a manual browser acceptance session, prints the one-time pairing secret, verifies popup pairing and snapshot arrival, revokes the extension capability, requires one more denied export attempt, and writes redacted evidence under `.local\acceptance`.

`npm run acceptance:browser` now writes only a guide. It does not create pairing challenges because a challenge without its one-time secret is not actionable.

## Validation

Core checks:

```powershell
npm run typecheck
npm test
npm run lint
```

Release-oriented checks:

```powershell
npm run eval:semantic
npm run eval:agent
npm run eval:security
npm run eval:privacy
npm run eval:onboarding
npm run eval:retrieval
npm run eval:review
npm run acceptance:ports
npm run acceptance:chromium
npm run acceptance:private-library -- --mode codex --resume
npm run package:extension
npm run package:app
npm run release:manifest
npm run acceptance:report -- .local\acceptance\live-acceptance-redacted.json
```

## Backup And Restore

Create a backup with evidence:

```powershell
.\scripts\backup-tabatlas.ps1 -EvidencePath .local\acceptance\backup-evidence.json
```

Restore from a backup with evidence:

```powershell
.\scripts\restore-tabatlas.ps1 -BackupPath .\backups\tabatlas.sqlite -EvidencePath .local\acceptance\restore-evidence.json
```

Release gating expects backup and restore evidence with SQLite integrity checks, required tables, package hashes, and matching source/restored resource counts.

## Key Docs

- `docs/15-agent-first-ux-contract.md`
- `docs/16-focused-review-tagging.md`
- `docs/17-semantic-view-planning.md`
- `docs/31-live-acceptance-release-handoff.md`
- `docs/32-release-candidate.md`
- `docs/33-release-finalization-handoff.md`

## Current Release Bar

The repo is not considered release-ready from automated scaffold checks alone. The final gate requires real Chrome and Edge product-browser acceptance evidence, bundled Chromium evidence, Codex-mode private-library acceptance with exact provider/thread/usage evidence, backup/restore evidence, and matching packaged release artifacts.
