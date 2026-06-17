# Agent-first UX Contract

## Product truth

The main interface is a conversation with a local agent, not a static tab list. The user should not need to learn a folder model or a query language. The user says what kind of organization they want, including fuzzy taste and logic, and the app responds by making temporary or pinned views.

The built-in agent is powered by local Codex through the provider seam. Codex must reason over app-provided resource briefs, tags, notes, and evidence. It must not browse the live web page for each tab, automate Chrome/Edge, or inspect cookies/session state.

## How the user should experience the app

### First launch

The user opens TabAtlas and sees:

```text
235 tabs captured
197 unique links
24 YouTube videos
17 links already have user notes/tags
42 links need a quick human mark

Ask me to organize this, or start quick review.
```

The two primary actions are:

- `Ask agent`
- `Quick mark unreviewed links`

The full list exists, but it is not the default experience.

### Normal use: talk, preview, apply

The user types something like:

```text
Make a game inspiration group. Include gameplay analysis, level design, UI/UX, modding, art style videos if they help game ideas. Exclude pure music and coding docs unless I marked them as inspiration.
```

The agent returns a plan, not an immediate destructive action:

```text
I will create one pinned view: Game inspiration.
Inclusion rules:
- strong include: user tag/note contains inspiration, game idea, level design, mechanic, UI, art style for game;
- include: resources whose extracted brief is about games, gameplay, design, creative direction, modding, worldbuilding;
- weak include: general art/design videos only if a user note says they are inspiration;
- exclude: pure music, generic programming docs, unrelated AI papers unless user-marked.

I found 38 likely matches, 9 weak matches, and 6 conflicts.
[Create view] [Edit logic] [Show conflicts]
```

This is the key interaction model: Codex turns fuzzy intent into a semantic view spec, uses stored evidence, and then the UI displays/editably applies it.

### User command can be complex

Commands can describe logic, tradeoffs, exceptions, tone, priority, or purpose:

- "Make this practical, not academic."
- "Mostly game inspiration, but accept anything I personally marked as inspiration."
- "Separate tutorials I can act on from videos that are just vibes."
- "Find things I opened for later but probably can close, except pinned tabs and anything in a group named Research."
- "Create a view for things useful to my tab-manager project: browser extension, local app, Codex CLI, YouTube transcript, SQLite, UI ideas."
- "Group videos by what I could get out of them: watch, extract ideas, cite later, ignore."

The local agent should plan with explicit inclusion/exclusion logic rather than reducing the command to a single keyword search.

## Required interaction loop

```text
user command
  -> command planner parses intent
  -> planner asks app tools for relevant resources/briefs/tags/notes
  -> planner proposes semantic view spec
  -> app previews matches, conflicts, exclusions, and confidence
  -> user applies/refines/pins view
  -> memberships are stored with evidence and reasons
```

## UI objects the agent can create

### View

A named lens over resources and atomic items. A resource can be in many views.

Examples:

- `Game inspiration`
- `Art inspiration`
- `Loose inspiration pile`
- `Codex / local AI app architecture`
- `Watch later: high-value videos`
- `Safe to archive after review`

### Tag

A small clue attached to a resource or atomic item. Tags may come from the user, AI, browser groups, or extractors.

User tags are not just labels. They are high-priority evidence.

### Description / note

A short user-written explanation of why the resource matters. This should outrank title-only AI guessing.

Example:

```text
User note: "Inspiration for inventory UI, not really about the game itself."
```

This resource should match a `game UI inspiration` or `game inspiration` view, but probably not a `game reviews` view.

### Atomic item

A meaningful item inside a resource, especially inside YouTube videos or link collections.

Example: one YouTube video may generate atomic items for `paper: Voyager`, `tool: BrowserGym`, `idea: multi-agent evaluation`, or `topic: level-design pacing`.

## Agent personality

The agent should be direct and operational:

- "I can create this view."
- "This is a weak match because only the title supports it."
- "Your note makes this a strong match even though the video title looks unrelated."
- "I need a quick human mark for these 12 ambiguous links."

It should not over-explain implementation details unless asked.

## Required safeguards

- No browser mutation without approval.
- No hidden reclassification that overwrites user pinned categories.
- No claim without evidence.
- No transcript-based reasoning unless a transcript artifact exists.
- No command should require the user to inspect a huge list; the agent should summarize and ask for focused review when needed.

## MVP acceptance criteria

The first useful MVP must support:

1. Import a snapshot.
2. Show counts and dynamic view cards.
3. Add/edit user tag and user description on a resource.
4. Start a focused review queue for unmarked resources.
5. Ask the agent for a view using natural language.
6. Use user annotations as high-priority evidence in view planning.
7. Preview matches before applying the view.
8. Explain why a resource is or is not included.
