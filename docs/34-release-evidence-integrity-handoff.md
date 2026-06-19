# Project lead handoff — release evidence integrity

Date: 2026-06-19 NZT

This handoff follows implementation commit `aae6ed823b7fdf526d6c42993757830f361b6f73` and the project-lead scaffold commits that follow it.

## 1. Audit verdict

The implementation report is substantially supported by repository code.

Verified:

- the exact pushed commit exists;
- the product-browser runner launches installed Chrome or Edge executables with a temporary isolated user-data directory and a loopback debugging port;
- the runner calls browser-level CDP `Extensions.loadUnpacked`, waits for the MV3 service worker, connects Playwright over CDP, opens the actual extension popup page, pairs, waits for snapshot evidence, revokes, triggers another export, and verifies token absence;
- the temporary product-browser process is stopped by matching the isolated user-data directory, so the user's existing browser profile/tabs are not targeted;
- schema-v6 is loaded;
- manual browser acceptance sessions store challenge/capability/snapshot/denial IDs and do not store the one-time secret;
- hierarchical planning uses evidence fingerprints, SQLite run/chunk persistence, full resource coverage validation, degraded failed-chunk results, and typed unresolved targets;
- private-library rows include exact retrieval, prompt, agent, provider, usage, and hierarchical fields;
- strict package, validation, browser, private-library, and backup evidence checks exist;
- Windows start/check/backup/restore and release-manifest helpers exist.

The exact local command output, 180-test result, private-library 4/4 result, product-browser local evidence files, package archives, and backup/restore artifacts were not independently rerun by the project lead.

## 2. Official browser-method confirmation

Chrome's June 2025 extension update states that the `--load-extension` flag was removed in Chrome 137 and that alternative testing mechanisms were being provided.

The Chrome DevTools Protocol now documents the experimental `Extensions.loadUnpacked` method, which installs an unpacked extension from an absolute path and returns its extension ID.

The implementation's use of isolated product-browser profiles, `--enable-unsafe-extension-debugging`, and `Extensions.loadUnpacked` is therefore a credible product-browser test path. It remains a testing-only path and should be described honestly as automated CDP acceptance.

## 3. Remaining evidence-integrity findings

### 3.1 Automated Chrome/Edge evidence is currently labelled manual

`manualBrowserSessionToSmoke` always returns `mode: "manual"`. The product-browser runner uses automation through installed Chrome/Edge and CDP.

This is real product-browser evidence, but the label is inaccurate.

Decision: represent strategy separately from browser:

```text
bundled_chromium_playwright
chrome_product_cdp
edge_product_cdp
chrome_manual_load_unpacked
edge_manual_load_unpacked
```

Record `automated`, `isolatedProfile`, executable version, and extension load method explicitly.

### 3.2 Receiver reachability is asserted rather than persisted

The runner checks health before the session, but the browser-smoke conversion currently returns `receiverReachable: true` unconditionally.

Decision: store health/receiver evidence in the browser acceptance record and derive the report row from that evidence.

### 3.3 The strict gate contains a self-reference

The required validation list currently includes `npm run acceptance:report`. A report validator should not require its own successful execution as an input row.

Decision: the required evidence list stops at package/manifest generation. Running `acceptance:report` is the final operation over that evidence.

### 3.4 Automated product-browser mode should be accepted directly

The current strict gate requires Chrome and Edge rows to be labelled manual. It accepts the automated CDP runs only because those rows are currently mislabelled.

Decision: accept either:

```text
chrome_product_cdp automated evidence
OR chrome_manual_load_unpacked evidence

edge_product_cdp automated evidence
OR edge_manual_load_unpacked evidence
```

Do not convert one strategy into the other.

### 3.5 Degraded hierarchical chunks are not a clean release pass

A private-library command can finish with `failedChunkCount > 0`, surface those targets as `needs_review`, and still be marked passed.

That is good product degradation behavior, but it should produce `degraded_candidate`, not a clean `release_ready` grade.

### 3.6 Backup required-table evidence is too weak

The current backup schema accepts any non-empty `requiredTablesPresent` array. A strict release gate should require the full known table set, not merely one table.

### 3.7 Final report execution was not shown

The implementation report listed browser, package, and backup validation commands, but did not include a successful strict `acceptance:report` result. The project lead cannot infer final release readiness from local evidence files that were not shared.

## 4. Project-lead scaffold added

```text
src/acceptance/browserEvidencePolicy.ts
src/acceptance/releaseEvidenceAudit.ts
tests/releaseEvidenceAudit.test.ts
.agents/skills/tab-atlas-release-evidence-integrity/SKILL.md
```

The scaffold provides:

- honest browser execution strategies;
- automated/manual and isolated-profile checks;
- executable/load-method fields;
- exact browser behavior proof requirements;
- a non-recursive validation command list;
- `release_ready`, `degraded_candidate`, and `blocked` grades;
- failed hierarchical chunk downgrade;
- complete required backup-table checks;
- report-row-to-evidence consistency validation;
- initial tests.

Compile and integrate this scaffold in place. Do not add another parallel release gate.

## 5. Workstream A — migrate browser evidence

1. Extend the report/evidence schema with `BrowserExecutionEvidence` or equivalent fields.
2. Product-browser automation writes:

```text
Chrome:
  strategy = chrome_product_cdp
  automated = true
  isolatedProfile = true
  extensionLoadMethod = cdp_extensions_load_unpacked

Edge:
  strategy = edge_product_cdp
  automated = true
  isolatedProfile = true
  extensionLoadMethod = cdp_extensions_load_unpacked
```

3. Bundled Chromium writes `bundled_chromium_playwright`.
4. Actual manual sideload remains available and uses `*_manual_load_unpacked`.
5. Record:

```text
browser/executable version
executable path hash, not raw path
acceptance session ID
capability ID
snapshot ID
denial audit ID
receiver health evidence
start/finish times
```

6. Derive the legacy browser-smoke booleans from the richer evidence; do not hand-set them independently.
7. Do not store challenge secrets or tokens.

Suggested commit:

```bash
git add .
git commit -m "Record truthful product-browser acceptance evidence"
```

## 6. Workstream B — consolidate the release gate

Migrate `acceptance:report` to `releaseEvidenceAudit.ts` and retire duplicate policy logic.

Required behavior:

- `acceptance:report` is not required inside its own validation rows;
- caller `releaseReady` remains ignored;
- Chrome/Edge automated CDP or true manual evidence is accepted according to its actual strategy;
- report rows must match the richer evidence;
- browser duplicate/missing rows fail;
- package existence/hashes/content checks remain mandatory;
- all exact private-library IDs/usage remain mandatory;
- `failedChunkCount > 0` yields `degraded_candidate`;
- full required backup table set is enforced;
- output grade is one of:

```text
release_ready
degraded_candidate
blocked
```

Exit policy:

```text
release_ready -> exit 0
degraded_candidate -> exit 2
blocked -> exit 1
```

Suggested commit:

```bash
git add .
git commit -m "Consolidate evidence-derived release grading"
```

## 7. Workstream C — produce the final redacted evidence bundle

Add an evidence assembler command:

```text
npm run acceptance:assemble
```

Inputs under ignored `.local/acceptance`:

- bundled Chromium smoke;
- Chrome product-browser evidence;
- Edge product-browser evidence;
- private-library smoke;
- validation-command results;
- release manifest;
- backup/restore evidence.

The assembler must:

- validate every input schema;
- verify browser rows refer to distinct sessions/capabilities/snapshots;
- verify package hashes against the release manifest;
- ensure no token/challenge secret/raw prompt/private title/private URL fields are present;
- create one redacted report;
- run the release audit;
- write a report hash and grade.

Do not commit the local evidence bundle unless it contains only stable, non-private aggregate data and the user explicitly approves publication.

Suggested commit:

```bash
git add .
git commit -m "Assemble final redacted release evidence"
```

## 8. Workstream D — final verification

Run all existing validations plus:

```text
npm run acceptance:product-browsers -- --browser chrome --server-url http://127.0.0.1:9786 --automate-extension
npm run acceptance:product-browsers -- --browser edge --server-url http://127.0.0.1:9786 --automate-extension
npm run acceptance:private-library -- --mode codex --resume
npm run package:extension
npm run package:app
npm run release:manifest
npm run acceptance:assemble
npm run acceptance:report -- .local/acceptance/live-acceptance-redacted.json
```

Record the exact final grade and blockers/degraded reasons.

If the grade is `release_ready`, package the final developer release candidate and tag it only after the user approves.

## 9. Definition of done

Do not call the release gate closed unless:

- browser strategies are labelled truthfully;
- installed Chrome and Edge evidence uses isolated profiles and records versions;
- report rows derive from server/browser evidence;
- no self-referential validation remains;
- private-library degraded chunks are surfaced in the grade;
- complete backup table evidence is verified;
- final redacted evidence assembly succeeds;
- final `acceptance:report` execution is shown;
- no secrets/private data are committed;
- all tests/evaluations pass;
- working tree is clean and pushed.

## 10. Copy-paste prompt for the local implementation agent

```text
Continue TabAtlas from latest main.

Read first:
1. docs/34-release-evidence-integrity-handoff.md
2. .agents/skills/tab-atlas-release-evidence-integrity/SKILL.md
3. src/acceptance/browserEvidencePolicy.ts
4. src/acceptance/releaseEvidenceAudit.ts
5. tests/releaseEvidenceAudit.test.ts
6. scripts/product-browser-acceptance.ts
7. src/acceptance/manualBrowserSession.ts
8. src/acceptance/releaseGatePolicy.ts
9. scripts/acceptance-report.ts
10. src/acceptance/contracts.ts

Compile and test the project-lead scaffold. Repair small integration issues in place. Do not create another release gate.

Implement:
- truthful Chrome/Edge CDP automated evidence strategies;
- executable version, isolated-profile, load-method, receiver-health, and exact server evidence fields;
- report rows derived from rich browser evidence;
- consolidated non-recursive release grading;
- degraded_candidate when hierarchical failed chunks exist;
- complete backup required-table checks;
- acceptance:assemble for all local redacted evidence;
- final acceptance:report execution and grade.

Run the full suite plus Chrome/Edge product acceptance, private-library Codex acceptance, package/manifest generation, evidence assembly, and final report validation. Commit in the suggested order, push main, keep the tree clean, and report the exact final grade, package hashes, browser strategies, evidence IDs, and any degraded reasons without private data.
```
