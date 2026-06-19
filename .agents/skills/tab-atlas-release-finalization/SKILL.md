# TabAtlas release finalization

Read `docs/33-release-finalization-handoff.md` before changing manual browser acceptance, hierarchical planner checkpoints, private-library evidence, package validation, or release readiness.

## Truthfulness rules

- Bundled Chromium automation proves extension behavior, not installed Chrome or Edge acceptance.
- Chrome and Edge release acceptance require separate product-browser evidence rows.
- A human-edited boolean is not enough for pairing, snapshot arrival, revocation, or token-leak proof; bind those claims to server-side IDs and audit rows.
- Pairing secrets are one-time operator inputs. Never store them in acceptance reports.
- Hierarchical chunk caches must include an evidence/config fingerprint, not only command and resource IDs.
- Every resource in a semantic chunk must be classified or explicitly unresolved. Silent target loss is a hard failure.
- Unresolved atomic items remain atomic items; never coerce them into resource memberships.
- Release readiness is derived from required validations, exact private-library evidence, browser-mode honesty, package hashes/contents, and backup/restore evidence.

## Extend these scaffolds

```text
src/acceptance/manualBrowserSession.ts
src/acceptance/releaseGatePolicy.ts
src/ai/hierarchicalPlannerSafety.ts
src/db/schema-v6-release-acceptance.sql
tests/releaseClosureScaffold.test.ts
```

Do not create a second manual-browser session system, release gate, or hierarchical freshness policy.

## Implementation order

1. Compile and test the scaffold.
2. Load schema-v6.
3. Replace the hand-edited browser template with session-backed Chrome/Edge acceptance.
4. Integrate hierarchical evidence fingerprints and full chunk coverage validation.
5. Persist hierarchical runs/chunks in SQLite and resume only matching fingerprints.
6. Tighten private-library exact evidence requirements.
7. Integrate strict release-gate policy and backup/restore evidence.
8. Run actual Chrome and Edge manual popup acceptance.
9. Produce a redacted release report and verify it.

## Release gate

Do not mark release ready unless all of the following pass:

- bundled Chromium automated acceptance;
- Chrome manual product acceptance;
- Edge manual product acceptance;
- all four private-library Codex commands with exact IDs/usage;
- hierarchical planner coverage/freshness tests;
- required validation commands;
- package existence, hashes, and required contents;
- backup/restore integrity evidence;
- no safety flags.
