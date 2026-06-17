# Semantic View Planning

## Why this exists

The user does not want rigid categories like `Science`, `Games`, `Videos`, `Articles`. They want flexible views whose logic changes with purpose.

The same resource can be:

- game inspiration in one view;
- art reference in another;
- watch-later content in another;
- irrelevant in a strict coding-docs view;
- a weak/conflict candidate in a loose creativity view.

Therefore TabAtlas must model grouping as a **semantic view spec**, not as a single folder assignment.

## Core concepts

### Resource facts

Stable-ish facts extracted from the link:

- URL kind;
- host;
- title;
- browser group;
- YouTube metadata;
- transcript/description excerpts;
- page metadata;
- atomic items.

### User intent clues

Signals created by the user:

- tags;
- descriptions/notes;
- corrections;
- pinned view membership;
- pinned exclusion;
- command history.

### View spec

An explicit grouping plan generated from a natural language command.

A view spec contains:

- name;
- goal;
- inclusion rules;
- exclusion rules;
- strong/weak evidence rules;
- conflict handling;
- sort policy;
- whether resources, atomic items, or both are included.

## Example: strict vs loose inspiration

### User command A

```text
Make a game inspiration group.
```

Likely interpretation:

- include resources about game design, gameplay mechanics, level design, UI, modding, art direction for games;
- include user-marked `inspiration` if game-adjacent;
- exclude pure art/music/coding unless user note says it is useful for a game idea;
- show weak candidates separately.

### User command B

```text
Make an art inspiration group.
```

Likely interpretation:

- include art, visual design, composition, lighting, illustration, animation, moodboard resources;
- include game videos only if user note/tag mentions art, style, visual mood, environment design, UI look, or animation;
- exclude gameplay-only resources.

### User command C

```text
Make a loose group mainly game inspiration but welcome all other inspiration.
```

Likely interpretation:

- primary cluster: game inspiration;
- secondary cluster: all user-marked inspiration from art, design, writing, music, UX, AI, etc.;
- keep non-game inspiration visible but label it as `cross-domain inspiration`;
- sort game-related first but do not exclude other inspiration.

The agent must not store these as permanent mutually exclusive folders. It should create one view with sections or multiple related views:

```text
Loose inspiration
  - Game-centered inspiration
  - Cross-domain inspiration
  - Needs review
```

## Scoring model

Use a transparent scoring approach, not a hard taxonomy.

Suggested evidence weights:

| Evidence | Default weight |
|---|---:|
| User description directly matches command | 1.00 |
| User tag directly matches command | 0.95 |
| User corrected previous membership | 0.95 |
| Pinned inclusion/exclusion | 1.00 |
| Browser group title supports command | 0.60 |
| Transcript/description supports command | 0.75 |
| Page metadata supports command | 0.65 |
| Title/URL supports command | 0.45 |
| Weak inferred association | 0.25 |

These weights are policy defaults. Codex can explain and adjust within bounds for each command, but user annotations remain top priority.

## Membership states

A resource can be assigned as:

- `strong_include`: matches intent clearly;
- `weak_include`: plausible but not certain;
- `conflict`: evidence points both ways;
- `exclude`: likely not part of view;
- `needs_review`: requires a quick human mark.

The UI should show strong includes by default, optionally show weak/conflict candidates, and ask for focused review when necessary.

## Agent output requirements

For each proposed view, Codex must return:

- a human-readable view name;
- a compact goal statement;
- structured inclusion/exclusion rules;
- a list of matched resources/atomic items;
- membership state and confidence;
- evidence references;
- explanation for conflicts;
- suggested review queue if needed.

## What not to do

Do not build a fixed tree like:

```text
Games
  Art
  UI
  Inspiration
```

This fails because the same link’s purpose changes by command.

Do not ask Codex to classify all links from scratch on every command. Reuse:

- existing resource briefs;
- extraction artifacts;
- previous AI tags;
- user annotations;
- accepted/rejected memberships;
- FTS search results.

## Algorithm sketch

```text
planSemanticView(command):
  parse command into intent axes
  retrieve candidate resources using FTS + tags + notes + existing summaries
  build compact evidence briefs with user annotations first
  ask Codex for a SemanticViewPlan
  validate schema and evidence refs
  calculate deterministic sanity scores
  store proposed view + memberships
  show preview
```

## MVP examples to test

Use fixtures where titles alone are misleading.

1. A watercolor video with note "forest level moodboard" should be in `game inspiration`.
2. A gameplay mechanics video with no user note should be in `game inspiration` but not `art inspiration`.
3. A UI design article tagged `inspiration` should enter `loose inspiration`, and enter `game inspiration` only if note or extracted text connects it to games.
4. A music video tagged `inspiration` should enter `loose inspiration`, but not strict `game inspiration` unless note says it is for game atmosphere.
5. A coding docs page should not enter inspiration views unless the user says it is reference/inspiration for a tool/app.
