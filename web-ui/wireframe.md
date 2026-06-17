# UI Wireframe

## App shell

```text
┌──────────────────────────────────────────────────────────────────┐
│ TabAtlas                                  Capture: 235 tabs ✓     │
├──────────────────────────────────────────────────────────────────┤
│ Ask TabAtlas… [ Organize my current tabs for coding agents... ]   │
├───────────────┬──────────────────────────────────────────────────┤
│ Views         │ Map / Cards                                       │
│               │                                                  │
│ Inbox 235     │ ┌────────────────────┐ ┌────────────────────┐    │
│ AI proposed   │ │ Codex & agents 47  │ │ Watch later 24     │    │
│ Pinned        │ │ docs, repos, vids  │ │ long YouTube vids  │    │
│ Low confidence│ └────────────────────┘ └────────────────────┘    │
│ Duplicates    │ ┌────────────────────┐ ┌────────────────────┐    │
│ Archive queue │ │ AI papers 31       │ │ Safe archive 18    │    │
│               │ └────────────────────┘ └────────────────────┘    │
├───────────────┴──────────────────────────────────────────────────┤
│ Evidence / details panel                                         │
└──────────────────────────────────────────────────────────────────┘
```

## Resource card

```text
[YouTube] 10 AI agent papers that matter
Channel: Example · 42 min · Transcript: unavailable
Views: AI papers, Watch later, Video collections
Why: title + description indicate paper survey; no transcript, confidence medium.
[Open original] [Pin] [Mark watched] [Hide] [Inspect evidence]
```

## Command result preview

```text
You asked: "Split coding agents into Codex, browser automation, and evals."

Proposed changes:
- Create view: OpenAI Codex and local agents — 18 resources
- Create view: Browser automation / extensions — 11 resources
- Create view: Agent evaluation and tests — 7 resources
- Move 6 low-confidence items to Needs review

No browser tabs will be changed.
[Apply to TabAtlas] [Edit] [Cancel]
```

## Focused review screen

```text
┌──────────────────────────────────────────────────────────────────┐
│ Quick mark: Unreviewed links                         42 left      │
├──────────────────────────────┬───────────────────────────────────┤
│ Preview                      │ Human clue                        │
│                              │                                   │
│ [thumbnail/excerpt/metadata] │ Tags: [game] [inspiration] [ui]   │
│                              │ + chips: inspiration game art UI  │
│ Title: Beautiful watercolor  │                                   │
│ environments                 │ Note: Use as forest-level         │
│ Host: youtube.com            │ moodboard, not a game review.     │
│ AI guess: art, environment   │                                   │
│                              │ [Save & next] [Skip] [Ignore]     │
│ Next preloaded: Procedural   │ [Open externally] [Ask agent]     │
│ cities that feel handmade    │                                   │
└──────────────────────────────┴───────────────────────────────────┘
```

## Agent semantic view preview

```text
You asked: "Make a loose group mainly game inspiration but welcome all other inspiration."

Proposed view: Loose inspiration
Goal: collect resources useful as creative inspiration, sorted with game-related resources first.

Sections:
1. Game-centered inspiration — 31 strong, 6 weak
2. Cross-domain inspiration — 12 strong because user marked them as inspiration
3. Needs quick mark — 8 ambiguous

Rules:
- Include game/mechanics/level/UI/art-direction resources.
- Include any resource with user tag/note `inspiration`.
- Put non-game inspiration in cross-domain section.
- Exclude pure coding docs unless user note connects them to a project idea.

[Create preview] [Review 8 ambiguous] [Make stricter] [Make looser]
```
