# Focused Review and Fast Tagging

## Purpose

The user will often have hundreds or thousands of links. They should not maintain tags from a giant table. TabAtlas needs a fast one-by-one review mode where the user quickly adds a tag, note, or skip decision. These user marks become the strongest clues for later agent grouping.

This is the manual intelligence loop that makes the AI flexible.

## What counts as user-marked?

A resource is user-marked if it has at least one of:

- a user tag;
- a user description/note;
- an explicit user decision: `important`, `ignore`, `archive_later`, `watch_later`, `project_reference`, `inspiration`, `needs_deeper_read`;
- a manual correction to an AI grouping.

A resource is unmarked if all available labels are AI/system/browser-derived only.

## Screen design

```text
Quick mark: unreviewed links                 18 left
----------------------------------------------------
[Preview pane]

Title: 7 UI tricks from classic RPG inventory screens
Host: youtube.com
Current AI guess: game design, UI, video
Existing browser group: Ideas

Tags: [__________]  + quick chips: inspiration / game / art / UI / later / ignore
Note: [________________________________________________]

[Save & next] [Skip] [Open externally] [Mark ignore] [Ask agent why this is here]

Next preloaded: "Making procedural cities feel handmade"
```

## Preview strategy

### Preferred v1 preview

Use a safe resource preview panel, not arbitrary full browsing:

- YouTube: embedded player or thumbnail + metadata + description/transcript excerpts where available.
- Normal web page: title, URL, extracted metadata, main text excerpt, screenshot placeholder if later supported.
- PDF: first-page text/metadata excerpt if extracted.
- GitHub: repo/file/issue metadata excerpt.
- Unknown or auth-required: show title/URL and an `Open externally` button.

### Iframe policy

Do not rely on iframe as the only preview method. Many sites block embedding with `X-Frame-Options` or CSP, and embedding logged-in pages can be privacy-sensitive. The UI may attempt an iframe only when:

- the resource kind is allowed;
- the app is not passing cookies manually;
- the user can open externally if blocked;
- failure is graceful.

### Preload requirement

Focused review must feel instant:

- keep current item + next two briefs loaded;
- prefetch thumbnails/metadata only, not full arbitrary pages;
- save user annotation optimistically to local DB;
- advance immediately;
- background refresh the AI suggestions later.

## Keyboard-driven flow

The user should be able to review fast:

- `Enter`: save and next;
- `S`: skip;
- `I`: add `inspiration`;
- `G`: add `game`;
- `A`: add `art`;
- `U`: add `ui`;
- `W`: add `watch_later`;
- `X`: mark ignore;
- `/`: focus tag box;
- `N`: focus note box;
- `O`: open externally.

Quick chips must be configurable because the user’s actual recurring tags will emerge over time.

## Annotation priority

When the agent groups resources, evidence priority is:

1. explicit user description/note;
2. explicit user tags and corrections;
3. pinned view membership or pinned exclusion;
4. existing browser tab group name;
5. extracted transcript/description/metadata;
6. title and URL signals;
7. weak AI inference.

If a user note conflicts with title/metadata, the note wins unless it is obviously about a different URL.

Example:

```text
Title: "Beautiful watercolor environments"
User tag: game
User note: "Use as moodboard for forest level art direction."
```

This should be a strong match for `game inspiration` and a moderate match for `art inspiration`. If the user asks for `pure art study`, the agent should explain the conflict instead of blindly including it.

## Review queues

TabAtlas should support multiple queues:

- `unmarked`: no user annotation yet;
- `low_confidence`: AI is unsure;
- `conflicts`: user note and AI/extraction disagree;
- `youtube_needs_transcript`: video has weak metadata and no transcript;
- `safe_archive_review`: candidates before close/archive action;
- `project_specific`: resources relevant to a command but ambiguous.

The agent may create a temporary queue:

> "I can make the game-inspiration view, but 12 links are ambiguous. Quick-mark those first?"

## Minimum implementation API

The UI/server needs these operations:

- `GET /api/review/next?queue=unmarked&preload=2`
- `POST /api/annotations` for tags/notes/decisions
- `POST /api/review/:resourceId/skip`
- `POST /api/review/:resourceId/complete`
- `GET /api/resources/:id/preview`
- `GET /api/resources/:id/explain`

## MVP acceptance criteria

- The user can review at least 100 links without navigating a giant list.
- The next item appears without noticeable delay after save/skip.
- A tag/note written in focused review appears in the resource detail page.
- The agent uses that tag/note in later view planning.
- Skipped items do not disappear forever; they remain available in `skipped` or return after lower priority.
