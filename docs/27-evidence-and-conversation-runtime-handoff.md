# Evidence and conversation runtime handoff

This follows `20caf72ed70847b2baa5921a9def5bee8f075d76`.

## Audit

The durable-runtime report is substantially supported by code and tests. Hash freshness, job APIs, resume, active atomic-item replacement, view revisions, feedback evidence, and UI controls exist. Local command output and model-turn counts were not rerun here.

Important remaining issues:

- jobs advance only when resume is explicitly called;
- durable scans use one model call per resource;
- terminal failures lack selected retry;
- cancellation does not interrupt an in-flight model call;
- zero-item jobs need immediate finalization;
- revision listing is view-ID based rather than lineage based;
- prior feedback is applied too broadly across unrelated purposes;
- content understanding is still mostly titles, groups, stubs, and model inference.

## Project-lead scaffold

```text
src/extract/adapterContracts.ts
src/extract/networkPolicy.ts
src/extract/youtubeContracts.ts
src/preferences/intentScope.ts
src/preferences/feedbackContextService.ts
src/agent/actionProtocol.ts
src/agent/conversationService.ts
src/db/schema-v3-evidence.sql
tests/networkPolicy.test.ts
tests/intentScope.test.ts
```

The database loader now includes the new schema.

## Next stride

### 1. Finish worker semantics

Finalize empty jobs, retry selected failures, add cooperative cancellation points, add leases for interrupted items, and run a small worker while TabAtlas is open. Rotate model threads after bounded work.

### 2. Scope feedback by purpose

Store the source command, goal, rules, view/revision, and scope mode with every membership correction. Apply feedback automatically only when the new command is relevant. Unrelated feedback remains visible history, not a universal rule.

### 3. Build the extraction adapter runtime

Use the typed adapter contracts and durable jobs. Every result records recipe/adapter version, status, provenance, confidence, source, content hash, warnings, and retry state.

All public fetches must use the network policy, validate resolved addresses and redirects, omit session headers, and enforce per-host concurrency, timeout, redirect, content-type, and byte limits.

### 4. Standardize YouTube evidence

Layer the workflow:

1. parsed IDs and snapshot title;
2. optional official metadata API, batched by video ID;
3. optional local metadata/subtitle adapter, disabled unless configured;
4. manual transcript import;
5. honest no-transcript fallback.

Store channel, description, duration, thumbnails, chapters, mentioned links, transcript status, language, provenance, and segments. Do not assume official caption download works for arbitrary public videos.

### 5. Add generic webpage evidence

Extract public title, canonical link, Open Graph, description, headings, JSON-LD, and a bounded article-text excerpt. Do not execute page scripts. Store explicit auth, policy, network, size, and parse failure states.

### 6. Make the agent conversational

Persist threads, messages, and typed proposed actions. The action protocol covers view planning/refinement, review, scanning, annotations, explanations, and view acceptance. Preview/read operations may proceed; state-changing operations require confirmation and must call app services rather than edit storage directly.

### 7. Add semantic evaluation gates

Check in fixtures for strict/loose inspiration, art inspiration, project reference, purpose-scoped rejection, misleading titles, missing transcripts, and dense multi-topic resources. Score decisions and evidence use, not only JSON validity.

## Acceptance checks

- local/private destinations and redirect targets are blocked;
- public metadata fetches stay within limits;
- YouTube metadata is batched;
- subtitle provenance is explicit;
- unrelated feedback does not affect a new intent;
- related feedback is applied and explained;
- conversations survive restart;
- state-changing actions wait for confirmation;
- better evidence changes grouping without overwriting user truth.

## Implementation-agent prompt

```text
Continue TabAtlas from latest main. Read docs/27-evidence-and-conversation-runtime-handoff.md first.

Compile and test the project-lead scaffold. Repair it in place; do not create parallel adapter, feedback-scope, conversation, or network-policy systems.

Implement worker/retry/cancellation semantics, purpose-scoped feedback, typed durable extraction adapters, YouTube metadata and optional local subtitle evidence, safe generic page extraction, persistent conversational actions with confirmations, and semantic evaluation fixtures.

Run typecheck, tests, lint, network-policy tests, adapter fixtures, a public metadata smoke, an optional subtitle smoke when configured, and a conversation restart smoke. Commit in coherent phases and report provenance/status behavior and limitations.
```
