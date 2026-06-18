# TabAtlas Release Candidate Notes

## Package

Build local packages:

```powershell
npm install
npm run package:extension
npm run package:app
```

Outputs are written to `release/`, which is ignored by git:

- `release/tabatlas-extension`
- `release/tabatlas-extension.zip`
- `release/tabatlas-app`
- `release/tabatlas-app.zip`

## Install

1. Extract or clone the app package.
2. Run `npm install`.
3. Start the receiver with `npm run dev`.
4. Open `http://127.0.0.1:9787`.
5. Use the one-time bootstrap secret file printed by the receiver to start the dashboard session.
6. Load `release/tabatlas-extension` as an unpacked extension in Chrome and Edge.
7. Pair each browser through the extension popup.

## Update

1. Stop the receiver.
2. Back up `data/tabatlas.sqlite`.
3. Replace app files from the new package.
4. Run `npm install`.
5. Start `npm run dev`.
6. Reload the unpacked extension in Chrome and Edge if extension files changed.

## Backup And Restore

Back up:

```powershell
Copy-Item data\tabatlas.sqlite data\tabatlas.sqlite.backup
```

Restore:

```powershell
Stop-Process -Name node -ErrorAction SilentlyContinue
Copy-Item data\tabatlas.sqlite.backup data\tabatlas.sqlite -Force
npm run dev
```

## Rollback

1. Stop the receiver.
2. Restore the previous app package.
3. Restore the matching SQLite backup.
4. Reload the previous unpacked extension folder.
5. Run `npm run acceptance:ports`.

## Capture Roots

Configure allowed manual import roots with environment variables used by `src/security/importPathPolicy.ts`. Manual imports outside configured capture roots are denied.

## Codex Setup

Before Codex-backed planning/scanning, verify the local Codex SDK is authenticated in the environment running `npm run dev`. The app also has deterministic fallback paths for local tests and preview behavior.

## Privacy Disclosure

TabAtlas keeps browser snapshots, annotations, extraction artifacts, and SQLite data local. Codex prompts receive compact redacted resource briefs. URL credentials, query strings, fragments, secret-looking path segments, bearer tokens, API keys, and prompt manifests are redacted or hash-only by default. Full URL sharing requires an explicit local override in code.

## Extension Troubleshooting

- Use `npm run acceptance:ports` before pairing.
- The default receiver is `http://127.0.0.1:9787`.
- If the popup says receiver unreachable, confirm `npm run dev` is running and no other service owns port `9787`.
- If export fails after revocation, pair again with a new dashboard challenge.
- Extension tokens are snapshot-only and are sent in the `x-tab-atlas-token` header, not inside snapshot JSON.
