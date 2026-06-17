# Codex Integration Design

## Goal

Use the user's installed Codex CLI / subscription-backed Codex environment as the local reasoning engine without using OpenAI API keys for normal operation.

## Recommended primary route

Use `@openai/codex-sdk` in the local Node server.

Why:

- It is designed to control local Codex agents from an application.
- It supports threads.
- It avoids one process spawn per turn.
- It can be wrapped behind a provider seam.

## Fallback route

Use `codex exec` with:

- `--json` for JSONL event stream;
- `--output-schema` for structured final response;
- `--output-last-message` / `-o` for final output file;
- `--sandbox read-only` for pure reasoning;
- `--skip-git-repo-check` only where appropriate.

## Provider seam

The app should never hard-code Codex throughout the codebase.

Define:

```ts
interface LlmProvider {
  complete(prompt: string, opts?: LlmTurnOptions): Promise<LlmResult>;
}
```

Then implement:

- `CodexSdkProvider`
- `CodexExecProvider`
- `StubProvider` for tests
- optional future API-key provider if the user later wants it

## Structured output pattern

Use a single path:

```text
prompt → provider.complete → extract JSON → zod validate → semantic validate → reask if needed
```

Do not trust native structured output alone. Treat provider schema support as a hint and validate locally.

## Sandboxing

For categorization and view planning:

- filesystem: read-only;
- approvals: never / no autonomous changes;
- web search: disabled;
- working directory: a limited project/cache dir containing only sanitized extracted briefs and schemas.

The model should not need network access because extractors already gathered evidence.

## Concurrency

Subscription limits and local harness overhead matter. Recommended v1:

- one Codex turn at a time;
- batch resources to reduce turns;
- cache resource briefs and results;
- do not rerun categorization unless source evidence or user command changes;
- prefer deterministic extractors first;
- expose a "Codex turns used" debug counter.

## Prompt contracts

Codex should receive:

- explicit role: local tab curator;
- user preference context;
- known dynamic views and pinned tags;
- resource briefs with evidence IDs;
- schema and output requirements;
- strict rule: do not ask to browse; do not infer unavailable content.

Codex should return:

- valid JSON;
- proposed resources summaries;
- tags/groups/views;
- memberships with evidence IDs;
- low-confidence cases;
- follow-up extraction needs.

## Model behavior rules

- Never claim transcript-backed knowledge when transcript is missing.
- Never classify a login/account page as a content resource unless user says so.
- Prefer meaningful views over generic folders.
- Preserve user-pinned views and names.
- Dynamic categories are allowed, but must be explainable.
- Avoid too many tiny categories unless the user asks for granularity.

## Smoke test

The local coding agent should implement one deliberate smoke test:

```powershell
npm run smoke:codex
```

It should spend at most one Codex turn and verify:

- Codex provider initializes;
- structured output returns valid JSON;
- validation catches schema errors;
- no browser data is sent during the smoke test.

## V2: built-in agent uses app tools

The Codex-powered agent is the primary interaction surface. It should not directly edit SQLite or browse links. It should operate through the app's safe tool contract:

- `searchResources`
- `getResourceBriefs`
- `planSemanticView`
- `previewViewPlan`
- `applyViewPlan` after user acceptance
- `addUserAnnotation`
- `getReviewNext`
- `submitReviewDecision`
- `explainMembership`

For a grouping command, the runtime should:

1. parse the command;
2. retrieve candidates with FTS/tags/notes/summaries;
3. build compact resource briefs with user annotations first;
4. ask Codex for a validated `SemanticViewPlan`;
5. preview strong/weak/conflict/needs-review buckets;
6. apply only if the user accepts.

The agent should be able to handle complex natural language logic such as "strict", "loose", "mostly", "welcome", "exclude unless I marked it", and "practical not academic".
