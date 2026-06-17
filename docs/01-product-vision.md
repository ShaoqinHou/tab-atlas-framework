# Product Vision

## Name

Working name: **TabAtlas**.

Other naming ideas:

- LaterLens
- PilePilot
- TabTriage
- OpenLoops
- LinkGarden
- Browser Atlas
- Tab Cartographer
- RecallMap

**TabAtlas** is the recommended name because the product is not just a "tab saver." It builds a map from chaotic browser state.

## One-sentence summary

TabAtlas turns open Chrome and Edge tabs into a local Codex-powered knowledge workspace where the user can ask for flexible groupings in natural language, quickly add human clues, and navigate meaning instead of lists.

## The real user problem

The user is not simply "bad at tab management." The user is using tabs as a temporary memory system:

- "I might need this later."
- "This is connected to a project but I do not know where yet."
- "This YouTube video may contain several important topics."
- "This tab is not worth reading now but I do not want to lose it."
- "I have too many open loops to manually sort."
- "This link looks unrelated by title, but I know why it matters."

A list of 1,000 links is not a solution. A folder tree is also not enough because the categories are not known in advance and the same link may mean different things in different contexts.

## Product principle

TabAtlas should organize **intent**, not just URLs.

A URL can represent:

- a single article;
- a YouTube video containing 10 papers, 20 tools, or several design ideas;
- a docs page belonging to a larger technology stack;
- a shopping/research item;
- a forgotten task;
- a duplicate of another tab;
- a temporary login/account page that should not be stored deeply;
- a page whose title is misleading;
- a personal inspiration clue that only the user can explain.

The system should therefore store resources, atomic items, user annotations, and semantic views.

## Agent-first behavior

The user should mostly interact with a built-in agent:

```text
User: Make a loose game inspiration board, but include any art/design video I marked as inspiration.
Agent: I found 31 strong game-inspiration links, 12 cross-domain inspiration links, and 8 ambiguous links. I can create a view with two sections and a quick review queue.
```

The agent is not a chatbot bolted onto a tab list. It is the primary way to shape the UI.

The agent should use tools to:

1. search existing resource summaries, tags, notes, and extraction artifacts;
2. retrieve compact resource briefs;
3. plan semantic views with inclusion/exclusion logic;
4. create view previews;
5. ask for focused review when human intent is missing;
6. explain decisions with evidence.

## Human clues are first-class

A user tag or note is often the most important signal.

Example:

```text
Video title: "Beautiful watercolor environments"
User note: "Use as moodboard for forest level art direction."
```

This should be a strong match for `game inspiration` even if the video title does not mention games. It should also be a reasonable match for `art inspiration`, but for different reasons.

## Product behavior

TabAtlas should behave like a calm local librarian with an agent brain:

1. Capture the mess without interrupting the user.
2. Enrich as much as possible without the LLM.
3. Let the user quickly tag/describe ambiguous links in a focused review mode.
4. Ask Codex to reason over compact extracted text and user clues, not raw browser pages.
5. Propose flexible views with evidence, confidence, and conflict handling.
6. Let the user refine the map with plain language.
7. Never destroy browser state without approval.

## Hero workflow

1. User runs `capture-now.ps1` or opens TabAtlas.
2. Browser snapshots arrive.
3. The app shows a small status panel:
   - "235 tabs captured. 197 unique resources. 24 YouTube videos. 18 docs pages. 42 unmarked."
4. User says: "Organize this for me. I care about coding agents, AI papers, game inspiration, and videos I should watch later."
5. Extractors run first:
   - URL normalization;
   - site metadata;
   - YouTube metadata;
   - transcript where honestly available;
   - page title/description;
   - PDF/GitHub/domain-specific adapters later.
6. The app builds resource briefs with user notes/tags first.
7. Codex receives candidate batches and returns semantic view plans.
8. UI renders cards instead of a huge list:
   - "Coding agents and Codex tooling" — 47 resources;
   - "AI papers and paper-survey videos" — 31 resources, 83 atomic paper/topic items;
   - "Game inspiration" — 38 strong, 9 weak, 6 needs review;
   - "Watch later: long videos" — 22 resources;
   - "Safe archive: duplicated docs/search pages" — 18 resources.
9. User can say: "Make game inspiration looser; include all marked inspiration, but put non-game items in a second section."
10. UI updates; the underlying taxonomy remains flexible.

## What success feels like

- The user closes hundreds of tabs without anxiety.
- The user can find things by meaning, not by remembering exact titles.
- The app reveals hidden structure, especially inside videos and link collections.
- The user can add quick personal clues without heavy bookkeeping.
- The agent can reshape the workspace from nuanced natural language.
- The UI never makes the user maintain a rigid hierarchy.
