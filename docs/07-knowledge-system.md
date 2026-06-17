# Knowledge System Design

## Purpose

The app needs a repo-local knowledge system so Codex and future coding agents can understand how TabAtlas should behave without rediscovering the product every time.

This is not long-term personal memory. It is typed product knowledge, extraction recipes, policies, prompts, and evidence schemas.

## Structure

```text
AGENTS.md
.agents/skills/
knowledge/
  schema/
  recipes/
  policies/
  prompts/
  examples/
```

## Types of knowledge

### 1. Product rules

Examples:

- Do not browse every tab with the LLM.
- Do not close tabs automatically.
- Use dynamic views instead of rigid folders.
- Treat current browser groups as evidence, not truth.

### 2. Extraction recipes

Domain-specific instructions for extracting facts:

- YouTube;
- generic web page;
- PDF;
- GitHub;
- docs sites.

Each recipe says:

- when it applies;
- what it may fetch;
- what it must not fetch;
- expected artifacts;
- failure statuses;
- privacy risk.

### 3. Categorization policies

Rules for views/tags:

- avoid overly broad labels when finer intent is available;
- split collections from single resources;
- identify duplicates;
- preserve user language;
- show confidence.

### 4. Evidence schemas

Every important AI output should have evidence references.

Examples:

- view proposal evidence;
- membership evidence;
- atomic item evidence;
- duplicate evidence;
- archive suggestion evidence.

### 5. Agent skills

Skills are local instructions for Codex coding agents, not runtime user data. They explain how to safely change the project.

## Knowledge validation

Add scripts later:

```bash
node scripts/knowledge/validate-knowledge.mjs
node scripts/knowledge/build-knowledge-index.mjs
```

Validation checks:

- every recipe conforms to schema;
- every policy has an ID/version;
- every prompt schema is valid JSON Schema;
- recipe risk levels are explicit;
- no recipe silently enables cookie/session scraping.

## Runtime use

At runtime, the app can load knowledge files to decide:

- which extractor applies;
- how to construct Codex prompts;
- what safety checks to enforce;
- whether a proposed action needs user approval.

## Personal preference layer

The product should eventually store user preferences, but keep them separate from repo knowledge.

Examples:

- "I call this topic coding agents, not AI agents."
- "Hide shopping tabs unless I ask."
- "Treat YouTube videos as watch-later by default."
- "Pin OpenAI/Codex as a top-level view."

Store these in the user database, not `knowledge/`.

## V2 skills/policies required by the runtime agent

The knowledge system now needs to teach the runtime agent how to use TabAtlas, not just how to categorize batches.

Required policies:

- `knowledge/policies/evidence-priority.v1.json`
- `knowledge/policies/agent-tool-policy.v1.json`
- `knowledge/policies/grouping-defaults.v1.json`
- `knowledge/policies/privacy-defaults.v1.json`

Required prompts:

- `knowledge/prompts/categorize-batch.system.md`
- `knowledge/prompts/user-command.system.md`
- `knowledge/prompts/semantic-view-planner.system.md`
- `knowledge/prompts/focused-review-assistant.system.md`

Required schemas:

- `knowledge/schema/user-annotation.schema.json`
- `knowledge/schema/semantic-view-plan.schema.json`
- `knowledge/schema/review-queue-item.schema.json`

The local implementation agent should keep JSON schema files valid and update TypeScript zod schemas in parallel.
