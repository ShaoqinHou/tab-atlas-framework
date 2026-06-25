---
name: tab-atlas-pilot-readiness
description: Use when preparing, auditing, or running TabAtlas RC3 runtime-safety and human-pilot readiness workflows.
---

# TabAtlas Pilot Readiness

Use this workflow for RC3 runtime safety and pilot-readiness work.

## Required Checks

Start by confirming the repository and branch:

```powershell
git remote get-url origin
git status --short --branch
git rev-parse HEAD
```

Do not move RC1 or RC2 tags.

## Runtime Safety Rules

The receiver must never start without explicit runtime profile, port, and database:

```text
TABATLAS_RUNTIME_PROFILE
TABATLAS_PORT
TABATLAS_DB
```

Use `scripts/start-tabatlas.ps1` for production launches. Use `npm run roleplay:prehuman` for role-play. Do not compose ad hoc role-play environment commands.

## Production Incident Rules

Before modifying production data:

1. Stop the receiver normally if deterministic evidence is needed.
2. Create a fresh backup.
3. Record integrity, counts, active capabilities, active sessions, bootstrap rows, and plaintext file presence.
4. Use `runtime:remediate-bootstrap` first with `--dry-run`, then with `--apply`.
5. Preserve the forensic bootstrap row and write a runtime incident record.

Never commit `.local`, production backups, role-play databases, browser profiles, raw private reports, or secret material.

## Gates

Run these focused gates:

```powershell
npm run eval:runtime-safety
npm run eval:action-lifecycle
npm run eval:pilot-readiness
```

Then run the normal checks:

```powershell
npm run typecheck
npm test
npm run lint
```

The autonomous pre-human run must go through:

```powershell
npm run roleplay:prehuman
```
