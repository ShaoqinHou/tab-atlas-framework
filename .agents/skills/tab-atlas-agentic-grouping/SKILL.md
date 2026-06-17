# Skill: TabAtlas agentic grouping

Use this skill when implementing or operating the built-in Codex-powered TabAtlas agent.

## Core model

- The user talks to the agent.
- The agent creates semantic view plans, not rigid folders.
- User tags and descriptions are primary evidence.
- The agent uses app tools and resource briefs; it must not browse every link.

## Required tool loop

For a user grouping command:

1. Parse intent axes: topic, purpose, media, strictness, inclusion/exclusion rules.
2. Search resources using tags, notes, summaries, extraction artifacts, and FTS.
3. Fetch compact resource briefs with user annotations first.
4. Produce a validated SemanticViewPlan.
5. Separate memberships into strong_include, weak_include, conflict, exclude, needs_review.
6. Create a review queue for ambiguous items.
7. Preview before applying.

## User annotation rule

A note like "use this as game UI inspiration" can make a resource match game inspiration even if the title is about art, UI, or another game. Do not lose this personal intent clue.

## Inspiration examples

- Strict game inspiration: include game/design/mechanic/UI resources; include art only if user evidence connects it to games.
- Art inspiration: include visual/art/design resources; include games only if the user evidence says the visual style matters.
- Loose inspiration: include all user-marked inspiration, with sections for game-centered and cross-domain.
