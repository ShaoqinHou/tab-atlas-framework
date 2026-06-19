# Project lead handoff — release finalization

Date: 2026-06-18 NZT

This handoff follows implementation commit `0fd4caaaa87d6dcfa6fb74bee384d890e303b499` and the project-lead scaffold commits that follow it.

## 1. Audit verdict

The implementation report is substantially accurate.

Verified in repository:

- Playwright bundled-Chromium acceptance exists and exercises popup pairing, snapshot arrival, revocation, and snapshot token absence;
- private-library acceptance is subprocess-isolated and checkpointed per command;
- all four private-library result rows can carry retrieval IDs, prompt-manifest IDs, agent-run IDs, provider scope/thread, usage, duration, and membership counts;
- hierarchical semantic planning is called from the real agent command path;
- release report validation ignores caller `releaseReady` and inspects packages;
- app/extension packaging and Windows start/check/backup/restore helpers exist;
- schema-v3 legacy replay was fixed;
- the implementation agent correctly did not claim release readiness because actual Chrome and Edge product acceptance is missing.

The exact local command output, 175-test count, private-library 4/4 results, package files, and backup/restore smoke were not rerun in the project-lead environment.

## 2. Remaining release blockers

### 2.1 Actual Chrome and Edge acceptance is still missing

Bundled Chromium is a valuable automated behavior proof. It is not product-browser acceptance for installed Google Chrome or Microsoft Edge.

Release acceptance still requires:

```text
Chrome manual Load unpacked -> popup pair -> export -> revoke -> pairing required
Edge manual Load unpacked   -> popup pair -> export -> revoke -> pairing required
```

The current manual helper writes a template. It does not bind every pass claim to server-side evidence.

### 2.2 Manual challenge generation loses the pairing secret

The manual browser helper may create pairing challenges when an admin token is supplied, but its output retains only challenge IDs and expiry. The popup requires both challenge ID and secret.

Decision: create a server-backed manual acceptance session. Return/show the secret once to the local operator, never put it in the acceptance report, and derive pairing/snapshot/revocation proof from database/audit evidence.

### 2.3 Hierarchical chunk checkpoints can become stale

Current chunk IDs depend on command text, resource IDs, and chunk ordinal. They do not include:

- user annotation changes;
- extraction/feedback changes;
- atomic-item changes;
- model/reasoning effort;
- provider role/scope;
- prompt-redaction/planner version.

A later run can reuse a stale passed chunk after evidence changed.

Decision: use a prompt-safe evidence/config fingerprint for the hierarchical run and every chunk checkpoint.

### 2.4 Chunk results can silently omit resources

The current chunk validator rejects unknown target IDs but does not require every resource in the chunk to appear in either `decisions` or `unresolvedTargets`.

Decision: every resource must be explicitly classified or unresolved. Atomic items remain optional sub-targets, but returned atomic items must belong to the chunk.

### 2.5 Unresolved atomic items can be typed incorrectly

The current unresolved-target fallback creates resource memberships for every unresolved ID. If an unresolved ID is an atomic item, this produces an invalid target kind.

Decision: preserve a target descriptor map and emit the original target kind.

### 2.6 Split-chunk failure still aborts the run

The planner splits an initial failed chunk once, but an error in either split chunk still aborts the full plan. This does not yet implement the intended `needs_review` degraded behavior.

Decision: persist failed target IDs and surface them as typed `needs_review` memberships while preserving completed chunks. Do not silently use the heuristic.

### 2.7 Acceptance evidence is not strict enough

Current release validation still has gaps:

- browser blocker logic does not consistently require popup opened, receiver reachable, and token absence;
- manual/automated mode labels are not enforced;
- exact private-library agent/prompt/thread/usage IDs are not all required;
- package hashes are optional;
- the required validation command set is not enforced;
- backup/restore evidence is not part of the release gate.

Decision: integrate the strict release policy scaffold and derive readiness only from complete evidence.

## 3. Project-lead scaffold added

```text
src/acceptance/manualBrowserSession.ts
src/acceptance/releaseGatePolicy.ts
src/ai/hierarchicalPlannerSafety.ts
src/db/schema-v6-release-acceptance.sql
tests/releaseClosureScaffold.test.ts
.agents/skills/tab-atlas-release-finalization/SKILL.md
```

The scaffold provides:

- server-backed Chrome/Edge manual acceptance sessions;
- one-time challenge-secret return without report persistence;
- server-side pairing/snapshot/revocation evidence refresh;
- token-absence verification;
- evidence/config fingerprints for hierarchical planning;
- full resource coverage validation;
- unresolved target-kind preservation;
- strict validation/browser/private-library/package/backup release policy;
- v6 schema for manual browser acceptance and durable hierarchical planning;
- initial tests.

Compile and repair the scaffold in place. Do not build parallel systems.

## 4. Milestone objective

Finish the release gate rather than adding another broad feature set.

The milestone is complete only when:

```text
Bundled Chromium automated acceptance passes
AND Chrome manual acceptance passes from server evidence
AND Edge manual acceptance passes from server evidence
AND hierarchical planner cannot reuse stale evidence or drop targets
AND exact private-library evidence is complete
AND package + backup/restore evidence validates
```

## 5. Workstream A — integrate schema-v6 and manual browser sessions

1. Load `schema-v6-release-acceptance.sql` in `openDatabase`.
2. Add APIs/CLI around `manualBrowserSession.ts`:

```text
POST /api/acceptance/browser-sessions
GET  /api/acceptance/browser-sessions/:id
POST /api/acceptance/browser-sessions/:id/confirm-popup
POST /api/acceptance/browser-sessions/:id/revoke
POST /api/acceptance/browser-sessions/:id/verify-token-absence
POST /api/acceptance/browser-sessions/:id/refresh
```

3. Creation returns:

```text
session ID
challenge ID
challenge secret shown once
browser
receiver URL
expiry
```

4. Never persist the plaintext challenge secret in session/report/audit/log files.
5. The CLI should guide one browser at a time:

```text
npm run acceptance:product-browsers -- --browser chrome
npm run acceptance:product-browsers -- --browser edge
```

6. The CLI:

- prints extension directory and management URL;
- prints challenge ID and one-time secret to the local terminal only;
- polls session evidence;
- waits for pairing and snapshot arrival;
- asks for/records popup-open confirmation;
- revokes the exact capability;
- waits for denied `/snapshot` evidence;
- verifies token absence using the local token only in memory;
- writes a redacted browser row containing session/challenge/capability/snapshot/audit IDs, never the token/secret.

7. Browser rows must be distinct and labelled `manual`.

Required tests:

- secret is never stored in session tables;
- Chrome session cannot be satisfied by an Edge-labelled snapshot;
- snapshot count must increase after session baseline;
- revocation denial must occur after the capability revocation time;
- token absence is required for pass;
- a hand-edited pass boolean cannot bypass missing evidence;
- restart preserves the session.

Suggested commit:

```bash
git add .
git commit -m "Add evidence-backed Chrome and Edge acceptance sessions"
```

## 6. Workstream B — hierarchical planner freshness and coverage

Integrate `hierarchicalPlannerSafety.ts`.

### Run fingerprint

Before chunking, compute a fingerprint over:

```text
prompt-safe resource briefs
user annotations
relevant feedback
atomic items
extraction evidence
command text
model
reasoning effort
provider role/scope
redaction version
planner version
```

Persist one row in `hierarchical_planning_runs`.

### Chunk fingerprint

Each chunk uses:

```text
run fingerprint
ordinal
target kinds/IDs
```

Only reuse a passed chunk when the fingerprint matches exactly.

### Coverage validation

For each resource in a chunk:

```text
exactly one decision
OR resource ID in unresolvedTargets
```

Rules:

- unknown IDs fail validation;
- duplicate target decisions fail validation;
- target-kind mismatch fails validation;
- unresolved IDs must belong to the chunk;
- unresolved atomic items preserve `atomic_item` kind;
- evidence refs remain validated.

### Failure behavior

- split a failed chunk once;
- if a split still fails, mark that split failed in SQLite;
- continue remaining chunks;
- surface failed resource/atomic-item targets as `needs_review` with typed targets;
- preserve usage/error metadata;
- no heuristic fallback.

### Resume behavior

- persist chunk results in SQLite;
- restart resumes only matching, incomplete chunks;
- changed evidence creates a new run/fingerprint;
- completed stale chunks are never reused.

Required tests:

- annotation change invalidates cached chunks;
- extraction change invalidates cached chunks;
- model/reasoning change invalidates cached chunks;
- same evidence reuses chunks;
- omitted resource is rejected;
- duplicate target is rejected;
- unresolved atomic item remains atomic item;
- failed split becomes needs_review without aborting successful chunks;
- 200-resource restart resumes remaining chunks;
- final output is ordinary `SemanticViewPlan`.

Suggested commit:

```bash
git add .
git commit -m "Harden hierarchical semantic planning correctness"
```

## 7. Workstream C — exact private-library evidence

Strengthen private-library result rows and worker behavior.

Required fields for every passed command:

```text
retrievalRunId
promptManifestIds (non-empty)
agentRunId
provider role
provider scope
provider thread ID
model
reasoning effort
actual usage/quotaTurns
durationMs
hierarchical mode/chunk counts when used
candidate/selected counts
membership counts
redaction verification
```

Rules:

- do not fall back to `1` turn when usage is missing;
- represent usage as unknown and fail strict acceptance if exact usage is unavailable;
- bind prompt manifests to the agent run/provider scope;
- verify manifest redaction version and forbidden metadata fields;
- tie retrieval metrics to the exact retrieval run ID;
- checkpoint each command before and after planning;
- continue/retry independently;
- keep private resource text out of checkpoint/report files.

Suggested commit:

```bash
git add .
git commit -m "Bind private-library acceptance to exact evidence"
```

## 8. Workstream D — strict release gate and backup evidence

Integrate `releaseGatePolicy.ts`.

Release readiness must require:

- Chromium row is automated and fully passed;
- Chrome row is manual and fully passed;
- Edge row is manual and fully passed;
- popup opened, receiver reachable, pair/export/snapshot/revocation/token-absence all true;
- all required validation commands present and passed;
- all four private-library commands passed in Codex mode;
- exact retrieval/prompt/agent/provider/thread/usage evidence present;
- app/extension hashes present and match;
- required package contents present;
- backup/restore integrity evidence present;
- no safety flags.

Extend the report schema with backup/restore evidence.

Backup/restore smoke must record:

```text
backup path/hash
source and restored PRAGMA integrity_check results
required tables
source/restored snapshot count
source/restored resource count
server-stopped confirmation
```

Do not trust caller `releaseReady`.

Suggested commit:

```bash
git add .
git commit -m "Enforce strict evidence-derived release readiness"
```

## 9. Workstream E — finish actual product-browser acceptance

Perform the manual Chrome and Edge sessions with the local user.

For each browser:

1. Start TabAtlas on the release port.
2. Run the guided session command.
3. Open the browser extensions page.
4. Enable Developer mode.
5. Load unpacked from the packaged extension directory.
6. Open popup.
7. Enter the one-time challenge ID/secret.
8. Pair and export.
9. Let the CLI confirm server evidence.
10. Revoke.
11. Trigger export again.
12. Let the CLI confirm denied snapshot/re-pair state.
13. Complete token-absence check.
14. Persist redacted session evidence.

If the user cannot perform the manual browser interaction during this run, report the milestone blocked. Do not label release ready.

## 10. Workstream F — package usability polish

The developer package is acceptable, but tighten these items:

- `start-tabatlas.ps1` records PID/log paths and detects an already-running receiver;
- `check-tabatlas.ps1` checks Node, npm, Codex auth, port, DB integrity, capture roots, package manifest, and extension compatibility;
- package manifest is generated after packages and includes verified hashes;
- acceptance report and release manifest hashes agree;
- backup/restore scripts emit machine-readable evidence JSON;
- restore checks server is stopped and opens the restored DB successfully;
- README points to current install/release docs rather than old framework-phase instructions.

Suggested commit:

```bash
git add .
git commit -m "Polish the developer release candidate"
```

## 11. Required validation

```text
npm install
npm run typecheck
npm test
npm run lint
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
npm run acceptance:report -- <local-redacted-report.json>
```

Manual:

```text
Chrome evidence-backed popup acceptance
Edge evidence-backed popup acceptance
backup/restore evidence smoke
```

## 12. Definition of done

Do not report release ready unless:

- schema-v6 is loaded;
- manual browser sessions are evidence-backed;
- actual Chrome passes;
- actual Edge passes;
- hierarchical chunks are fingerprinted and coverage-complete;
- failed chunks degrade to typed needs-review instead of aborting all work;
- exact private-library evidence is complete;
- strict report policy passes;
- backup/restore evidence passes;
- packages/hashes/contents pass;
- all prior evaluations remain green;
- no private data is committed;
- working tree is clean and pushed.

## 13. Copy-paste prompt for the local implementation agent

```text
Continue TabAtlas from latest main.

Read first:
1. docs/33-release-finalization-handoff.md
2. .agents/skills/tab-atlas-release-finalization/SKILL.md
3. src/acceptance/manualBrowserSession.ts
4. src/acceptance/releaseGatePolicy.ts
5. src/ai/hierarchicalPlannerSafety.ts
6. src/db/schema-v6-release-acceptance.sql
7. tests/releaseClosureScaffold.test.ts
8. scripts/live-browser-acceptance.ts
9. src/ai/hierarchicalPlanner.ts
10. scripts/private-library-acceptance-common.ts
11. scripts/acceptance-report.ts

Compile and test the project-lead scaffold. Repair small issues in place; do not create parallel browser-session, release-gate, or hierarchical-fingerprint systems.

Implement:
- schema-v6 loading;
- evidence-backed manual Chrome/Edge acceptance sessions and guided CLI;
- evidence/config fingerprints for hierarchical runs/chunks;
- full resource coverage and target-kind validation;
- typed needs-review degradation for failed split chunks;
- exact private-library prompt/retrieval/agent/provider/usage evidence;
- strict release gate including required validations, package hashes/contents, and backup/restore evidence;
- release-script/README polish.

Then perform actual manual Chrome and Edge popup acceptance with the user. If manual interaction cannot be completed, report blocked and do not claim release readiness.

Run every command in section 11 plus manual Chrome, manual Edge, and backup/restore evidence smoke. Commit in the workstream order, push main, keep git status clean, and report exact redacted evidence IDs and metrics.
```
