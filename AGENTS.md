# AGENTS.md — TabAtlas

## Project mission

TabAtlas is a local-first, agent-first app that converts huge Chrome/Edge tab piles into an AI-navigable knowledge map.

The user should mostly interact with a built-in Codex-powered agent. The agent must use safe app tools and stored evidence to create flexible views, not force the user into rigid folders or a giant link list.

## Non-negotiable behavior

- Do not upload tab data to cloud services.
- Do not require API-key LLM usage for normal operation.
- Use local Codex CLI/SDK through a provider seam.
- Do not make the LLM browse/open every tab.
- Use deterministic extractors first; Codex reasons over compact extracted briefs.
- Treat user tags/descriptions as high-priority evidence.
- Support focused one-by-one review for unmarked resources.
- Do not parse browser cookies, passwords, local storage, or raw session files.
- Do not mutate browser state without user approval.
- Store evidence for AI-made classifications.
- Be honest when extraction is partial or unavailable.

## Must-read product contracts

Read these before implementation:

- `docs/15-agent-first-ux-contract.md`
- `docs/16-focused-review-tagging.md`
- `docs/17-semantic-view-planning.md`
- `docs/18-agent-tool-protocol.md`
- `docs/19-resource-brief-spec.md`
- `docs/20-v2-product-audit.md`

A static table/list app is not a successful MVP. The MVP must include the agent command loop and quick-mark loop, even if the first UI is simple.

## Development style

- Prefer TypeScript with strict types.
- Keep domain schemas in `src/shared/schemas.ts` and JSON schemas in `knowledge/schema/`.
- Use `StubProvider` for tests; do not burn Codex turns in CI.
- Keep Codex smoke tests manual.
- Add commits in logical phases.
- Every agent output path must have local validation.

## Architecture boundary

Runtime layers:

1. capture/import;
2. normalization;
3. deterministic extraction;
4. knowledge store;
5. user annotation/focused review;
6. resource brief builder;
7. Codex reasoning through a provider seam;
8. semantic view engine;
9. UI;
10. future browser action approval queue.

Do not collapse these layers.

## Agent tool boundary

The runtime Codex agent should use app tools such as:

- `searchResources`;
- `getResourceBriefs`;
- `planSemanticView`;
- `previewViewPlan`;
- `addUserAnnotation`;
- `getReviewNext`;
- `submitReviewDecision`;
- `explainMembership`.

The first implementation may make these TypeScript services. HTTP/MCP wrappers can come later.

## Safety checks before adding features

Ask:

- Does this read private browser/session data?
- Does this send data outside localhost?
- Does this allow Codex to browse or act autonomously?
- Does this change browser state without approval?
- Does this create categories without evidence?
- Does this ignore user annotations in favor of AI guesses?
- Does this force rigid categories where dynamic views are needed?

If yes, redesign or gate behind explicit user approval.
