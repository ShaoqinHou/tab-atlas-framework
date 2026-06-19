# TabAtlas release evidence integrity

Read `docs/34-release-evidence-integrity-handoff.md` before changing product-browser acceptance, final report assembly, backup/restore evidence, or release grading.

## Truthfulness rules

- Installed Chrome/Edge driven through CDP are automated product-browser runs. Do not serialize them as manual acceptance.
- Bundled Chromium, product Chrome, product Edge, and genuinely manual Load unpacked are distinct strategies.
- Browser evidence must include isolated-profile status, executable version, load method, acceptance session/capability/snapshot/denial IDs, and every behavior proof.
- `acceptance:report` cannot be a prerequisite validation row inside the report it is validating.
- Passed private-library commands with failed hierarchical chunks are degraded candidates, not clean release-ready evidence.
- Backup/restore evidence must prove the complete required table set, matching counts, integrity checks, and server-stopped restore.
- Release status is computed from evidence. Never trust a caller-supplied `releaseReady` flag.

## Extend these scaffolds

```text
src/acceptance/browserEvidencePolicy.ts
src/acceptance/releaseEvidenceAudit.ts
tests/releaseEvidenceAudit.test.ts
```

Do not create another release gate. Migrate `LiveAcceptanceReport`, product-browser evidence generation, and `acceptance:report` onto this policy.

## Completion checks

- Chrome CDP evidence is labelled `chrome_product_cdp`, automated, isolated profile.
- Edge CDP evidence is labelled `edge_product_cdp`, automated, isolated profile.
- Report rows are derived from the corresponding evidence record.
- Actual executable versions are recorded.
- The final audit has no self-referential required command.
- Any failed hierarchical chunk downgrades the grade unless explicitly approved.
- Backup evidence contains every required table.
- A final redacted report prints one of: release_ready, degraded_candidate, blocked.
