# RC3 Runtime Safety And Pilot Readiness Handoff

RC3 closes the production/role-play boundary that blocked the human pilot after RC2.

## Runtime Profiles

Every receiver process must declare all three values:

```text
TABATLAS_RUNTIME_PROFILE
TABATLAS_PORT
TABATLAS_DB
```

Supported profiles are `production`, `roleplay`, `acceptance`, `development`, and `test`.

`npm run dev` no longer selects port `9787` or `data/tabatlas.sqlite` by itself. Use `scripts/start-tabatlas.ps1` for an explicit production launch, and use `npm run roleplay:prehuman` for isolated role-play.

## Startup Order

The receiver starts in this order:

```text
resolve explicit config
check port
acquire database lease
read identity
verify profile/database compatibility
open and migrate database
bind listener
create bootstrap state
start worker
```

An occupied port fails before a database file is opened. A lease conflict fails before writable database access. Bootstrap files and the in-process worker are created only after the listener is healthy.

## Database Identity

Each persistent database has one identity:

```text
databaseId
environment
sourceDatabaseId
createdAt
updatedAt
```

Compatibility is strict:

```text
production  -> production
roleplay    -> clone
acceptance  -> acceptance, clone, test
development -> development, clone, test
test        -> test
```

Role-play cannot open production data. Production cannot open a clone.

## Incident Handling

Use:

```powershell
npm run runtime:inspect -- --database data\tabatlas.sqlite
npm run runtime:remediate-bootstrap -- --database data\tabatlas.sqlite --bootstrap-id <id> --incident-report <path> --dry-run
npm run runtime:remediate-bootstrap -- --database data\tabatlas.sqlite --bootstrap-id <id> --incident-report <path> --backup <backup> --apply
```

The remediation command preserves the bootstrap row, confirms the plaintext file is absent, confirms no active authority was created, marks the row orphaned, and writes a `runtime_incidents` record.

## Role-Play

Use only:

```powershell
npm run roleplay:prehuman
```

The runner creates a verified clone, starts a role-play receiver with a clone identity, runs the RC3 gates, stops the receiver, and verifies production counts and hash.

## Gates

Run:

```powershell
npm run eval:runtime-safety
npm run eval:action-lifecycle
npm run eval:pilot-readiness
```

The normal regression suite still applies:

```powershell
npm run typecheck
npm test
npm run lint
```
