# Installation and Onboarding Plan

## v1 target

A Windows-first local app the user can run from a folder.

## Install flow

1. User downloads/unzips TabAtlas.
2. User runs:

```powershell
npm install
npm run dev
```

3. App opens `http://127.0.0.1:9787`.
4. App checks:
   - Node version;
   - Codex CLI availability;
   - Codex SDK availability;
   - capture receiver/extension status;
   - database path.
5. User imports existing Headless Tab Exporter files or enables compatible receiver mode.

## First-run checklist UI

```text
✓ Local server running on 127.0.0.1
✓ Database created
? Chrome extension installed
? Edge extension installed
? Latest capture found
? Codex login detected
```

## Capture modes

### Manual import

User chooses `latest-all.json` from current exporter output folder.

### Compatible receiver

TabAtlas starts a receiver compatible with the current extension:

- `GET /health`
- `POST /snapshot`

### One-shot capture wrapper

Later: TabAtlas can call the existing `capture-now.ps1` script and then import the result.

## Codex setup

The app should not ask for an API key. It should detect local Codex:

```powershell
codex --version
```

Then smoke test a tiny structured output turn only when the user clicks "Test Codex".

## Optional YouTube setup

For richer metadata, allow optional YouTube Data API key. Keep it off by default.

For transcripts, show honest choices:

- official owner-caption OAuth: only useful for videos the user controls;
- optional local adapter: advanced, disabled by default;
- manual paste/import;
- metadata-only.

## Packaging roadmap

Phase 1:

- dev folder with npm scripts.

Phase 2:

- `start-tab-atlas.ps1` launcher.
- app icon/shortcut.

Phase 3:

- Electron/Tauri wrapper or Windows service-like tray app, if the user wants always-available local UX.

Avoid a background daemon until the core value is proven.
