# V2 Product Audit

## User feedback incorporated

The original framework correctly covered local capture, extraction, dynamic views, and Codex integration. The missing clarity was the lived product loop:

- the user should mostly interact with a built-in agent;
- natural language grouping can be fuzzy and complex;
- user tags/descriptions must become primary evidence;
- the app needs a fast one-by-one review/tagging mode;
- grouping must be flexible by purpose, not rigid taxonomy;
- YouTube needs a streamlined extractor, but all link types need a useful generic path;
- the local Codex agent needs app tools/skills so it knows how to operate the product.

This v2 framework adds those as hard requirements.

## Design decisions

### Decision 1: views are semantic lenses

A resource does not belong to one permanent category. Views are generated from user intent and can overlap.

### Decision 2: user annotations outrank AI guesses

A short user note such as "game UI inspiration" should outweigh a generic video title or a weak classifier label.

### Decision 3: Codex controls the app through tools

Codex should not browse tabs. It should call app tools: search resources, get briefs, plan views, create review queues, explain memberships.

### Decision 4: focused review is core, not future polish

The app becomes much smarter after the user marks ambiguous links. The review UI must be fast enough that the user can tag dozens of links in minutes.

### Decision 5: YouTube is optimized, not special-cased into rigidity

YouTube gets a standard metadata/transcript-status pipeline because it is common. But the same resource-brief and semantic-view logic applies to any link.

## Implementation risks and fixes

### Risk: local coding agent builds a tab table first and forgets agent-first UX

Fix: first MVP must include command bar, view-plan preview, and focused review skeleton. A giant list alone is not acceptable.

### Risk: tags become rigid folders

Fix: tags are evidence clues; views are the grouping result. Membership is many-to-many and command-dependent.

### Risk: Codex ignores user notes in long briefs

Fix: resource brief spec requires user annotations first, and prompts require user annotations as primary evidence.

### Risk: iframe preview fails

Fix: preview panel uses metadata/excerpts first; iframe is opportunistic only; `Open externally` is always available.

### Risk: transcript expectations cause hallucination

Fix: transcript status is explicit; transcript-based claims require transcript artifacts; metadata-only videos are marked lower confidence or sent to review.

### Risk: grouping is too slow for many links

Fix: retrieve candidates via FTS/tags/notes first, then send compact batches to Codex. Do not re-scan all links every command.

## MVP acceptance checklist

The local agent should not report success unless these are true:

- [ ] User can import a snapshot.
- [ ] User can add/edit a tag and description for a resource.
- [ ] User can use focused review on unmarked links.
- [ ] User can ask for a natural language grouping.
- [ ] The system creates a semantic view preview with inclusion/exclusion logic.
- [ ] User annotations appear as high-priority evidence in the prompt/brief.
- [ ] Membership explanations cite evidence refs.
- [ ] No browser mutation happens without approval.
- [ ] YouTube and generic webpages both have extractor stubs/statuses.
- [ ] Tests cover misleading-title + user-note priority.

## What the local agent should build first

1. Compile the scaffold.
2. SQLite schema with user annotations, review queue, user commands, semantic views.
3. Snapshot importer.
4. Resource brief builder.
5. Focused review endpoints and minimal UI/wireframe.
6. Stub semantic view planner test.
7. Codex provider integration only after stub flow works.
