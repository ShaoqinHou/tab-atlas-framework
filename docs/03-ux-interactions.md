# UX and Interaction Design

## Core UX idea

The user should not organize tabs manually. The user should talk to the app, quickly mark ambiguous links when useful, and approve useful structure.

The interface should feel like:

- an agent command center;
- a map of dynamic views;
- a fast focused review queue;
- an evidence inspector;
- an approval queue.

Avoid making the user learn a complex taxonomy editor.

## Primary screens

### 1. Capture status

Purpose: answer "what did the app see?"

Suggested content:

```text
Captured just now
235 tabs across Chrome + Edge
197 unique resources
24 YouTube videos
5 existing Edge tab groups
42 unmarked by user
12 likely duplicates
18 tabs look safe to archive after review
```

Buttons:

- `Ask agent to organize`
- `Quick mark unreviewed links`
- `Import latest exporter files`
- `Refresh snapshot`
- `Open privacy settings`

### 2. Agent command center

A single input box with examples:

```text
Ask TabAtlas…
"Make a game inspiration board, but include art videos I marked as inspiration."
"Show me things useful to my Codex tab-manager project."
"Find YouTube videos that contain multiple papers/tools."
"Make a loose inspiration view, mostly games but welcome other marked inspiration."
"Find stuff I can probably close, except pinned tabs and Research groups."
```

The command should produce a proposed plan before changing the map:

```text
I will create 2 views:
1. Game inspiration — strict game/design/mechanics/UI matches
2. Cross-domain inspiration — non-game resources you marked as inspiration

I will also create a review queue with 8 ambiguous links.
No browser tabs will be closed or moved.
[Create preview] [Edit logic] [Quick review ambiguous]
```

### 3. Dynamic views panel

Instead of showing 1,000 links, show 8–20 view cards.

Each view card:

- name;
- one-sentence goal;
- count and membership states;
- top user tags and AI/system tags;
- representative resources;
- confidence;
- reason it exists;
- quick filters.

Example:

```text
Loose inspiration
50 resources · 38 game-centered · 12 cross-domain · 8 needs review
Why: command asked for mainly game inspiration but welcomed all marked inspiration.
[Open] [Pin] [Tighten] [Make looser] [Review ambiguous]
```

### 4. Focused review

A one-by-one screen for unmarked or ambiguous resources.

```text
Quick mark: unreviewed links                 42 left
----------------------------------------------------
[Preview]
Title: Beautiful watercolor environments
Current signals: art, video, environment design

Tags: [ inspiration ] [ art ] [ game ] [ moodboard ]
Note: Use as moodboard for forest level art direction.

[Save & next] [Skip] [Open externally] [Ignore]
Next preloaded: Procedural cities that feel handmade
```

This screen is core, not optional. It lets the user inject the missing personal context that makes fuzzy grouping good.

### 5. Resource detail page

Shows a resource without requiring the user to open the original tab:

- title;
- canonical URL;
- current browser/window/group observations;
- user tags and description editor;
- extracted metadata;
- summary;
- atomic items;
- memberships in views;
- evidence excerpts;
- actions.

For YouTube:

- channel;
- duration;
- description/chapter signals;
- transcript status: `available`, `unavailable`, `blocked`, `not_attempted`, `manual_needed`, etc.;
- topics and timestamped items where available.

### 6. Evidence inspector

Every AI claim should be inspectable:

```text
Claim: This belongs in "Game inspiration".
Evidence:
- User tag: inspiration
- User note: "inventory UI idea"
- Title: RPG inventory screens
- Browser group: Ideas
Confidence: 0.94
```

For low-confidence claims, show why:

```text
Low confidence because only title was available and no page description/transcript was extracted.
```

### 7. Approval queue

Any action that changes browser state goes here.

Examples:

- close 27 duplicate tabs;
- create Chrome group "Codex docs" with 14 tabs;
- bookmark 33 tabs into `TabAtlas Archive / 2026-06-17`;
- open 9 "urgent" tabs in a new window.

The default should be `review before apply`.

## Natural language operations

The user should be able to say:

- "Make the categories more practical, less academic."
- "Split videos from articles."
- "Only show things I personally marked as inspiration."
- "Make game inspiration strict."
- "Make game inspiration loose and include cross-domain ideas."
- "This one is art reference, not game inspiration. Remember that."
- "These are all for my browser-agent project."
- "Show things where I need to add a note before you can decide."

## Result style

The agent should return:

```text
Created preview: Game inspiration
Strong: 31
Weak: 9
Conflicts: 4
Needs quick mark: 8

Top reasons:
- 14 have user tags/notes matching inspiration/game/UI/mechanic.
- 11 are YouTube videos whose titles/descriptions mention game design.
- 6 are art/design resources included because your notes connect them to game moodboards.

[Apply] [Review weak] [Make stricter] [Make looser]
```

## MVP acceptance criteria

A first UI is acceptable only if it supports:

1. command bar;
2. dynamic view preview;
3. focused review queue;
4. user tags/descriptions;
5. evidence explanation;
6. no browser mutation without approval.
