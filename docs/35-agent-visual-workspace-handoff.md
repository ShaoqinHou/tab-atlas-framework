# Project lead handoff — agent visual workspace

Date: 2026-06-19 NZT

This handoff begins after the frozen release candidate:

```text
v0.1.0-dev-rc1
7c74d3fba7b8e5a89c6e841c61be75190fd2e5a0
```

The release tag must remain immutable. Implement this milestone on `main` and use a later `rc2` tag only after the UX gate passes.

## 1. Audit conclusion

The current app is technically capable but still behaves like a developer control panel.

The existing UI presents:

- a wide header containing many metrics;
- primary and secondary rows of navigation;
- conversation plus a second standalone view-planner form;
- action cards displaying internal action names and truncated JSON;
- view previews as counts, rules, and a linear list of sample titles;
- views as a paginated list of names;
- review as one text-heavy card plus control panels;
- security tokens and diagnostic controls close to ordinary workflows.

The data and agent architecture should remain. The presentation hierarchy needs to change.

## 2. Product experience decision

TabAtlas should feel like:

```text
conversation expresses intent
-> agent creates or selects a visual artifact
-> workspace shows the artifact
-> user browses sections and cards
-> inspector explains one item
-> correction changes future reasoning
```

It should not feel like:

```text
choose subsystem
-> fill form
-> read status badges
-> inspect a list
-> decode JSON-like action results
```

## 3. Main shell

Use a stable three-part shell.

### Left navigation rail

Primary:

```text
Ask
Review
Views
```

Secondary:

```text
Capture
Jobs
Settings
Diagnostics
```

Secondary navigation should be visually quiet and collapsed by default.

### Center workspace

The center is the currently active artifact:

- semantic view board;
- visual gallery;
- semantic map;
- focused review;
- revision comparison;
- job progress only when explicitly opened.

The center workspace is larger than the chat panel.

### Right inspector

A card opens a non-destructive inspector with tabs:

```text
Overview
Evidence
Notes
Related
```

Closing the inspector must preserve workspace scroll, filters, and focus.

### Conversation

Conversation is persistent but may collapse to a side panel or bottom composer.

The user should be able to say:

```text
Show only conflicts.
Switch to gallery.
Focus on cross-domain inspiration.
Why is this included?
Review the uncertain items.
```

These commands produce typed presentation actions. They do not alter data and require no confirmation.

## 4. Visual semantic view

Default layout: `board`.

Each view starts with:

- one-sentence headline;
- goal;
- strong, weak, conflict, and review counts;
- visible sections;
- compact suggested follow-up prompts.

A section contains cards rather than bare titles.

Every card should show, as available:

- thumbnail or local visual placeholder;
- title;
- host/content kind;
- one-sentence summary;
- one-sentence “why it belongs”;
- user note or tag when present;
- evidence-strength marker;
- state/confidence;
- atomic-item count;
- quick actions: inspect, explain, correct.

Excluded resources are collapsed and hidden by default.

## 5. Layouts

### Board

Default. Best for semantic sections and mixed resources.

### Gallery

For visual inspiration. Large thumbnails, minimal text, user note and reason on hover/focus.

### Map

A semantic overview, not a force-directed graph with hundreds of crossing lines.

Recommended implementation:

- sections become large regions;
- cards become bounded dots/tiles inside regions;
- size may represent confidence or activity;
- color represents state;
- zoom/focus reveals cards;
- no physics simulation is required.

### Compact

For power scanning and accessibility. It may resemble a list, but it is an optional mode rather than the product default.

Timeline is deferred unless real use proves it valuable.

## 6. Evidence design

Use five understandable levels:

```text
User note
Prior correction
Verified content
AI analysis
Title only
```

Do not expose raw evidence IDs in the ordinary view.

The inspector can show provenance and IDs in a secondary technical disclosure.

When the agent is uncertain, show what is missing:

```text
Needs your note
No transcript available
Only title evidence
Conflicting prior feedback
```

This applies the human-AI principles of making capability and uncertainty clear, supporting efficient correction, explaining behavior, remembering interaction, and encouraging granular feedback.

## 7. Agent presentation protocol

Add a presentation-only protocol separate from persistent agent actions.

Allowed presentation actions:

```text
show_view
set_layout
focus_section
set_filters
open_resource
show_explanation
open_review
compare_revisions
```

These actions:

- are safe to execute immediately;
- do not change memberships;
- do not accept views;
- do not write annotations;
- do not mutate browser tabs.

Existing persistent actions remain unchanged and retain confirmation.

## 8. Review experience

Focused review should occupy the center workspace.

Recommended layout:

```text
large preview / thumbnail / embed
resource context and extraction status
quick chips
short note field
save-next / skip / ignore / open externally
progress
next three preloaded cards
```

Keyboard shortcuts must be visible until the user learns them.

A blocked iframe or embed must fall back to metadata and external open without interrupting review.

## 9. Architecture constraint

Do not rewrite the backend or replace the current single-page app with a heavy framework solely for aesthetics.

Recommended incremental structure:

```text
web-ui/
  index.html
  workspace.css
  api.js
  shell.js
  conversation.js
  view-workspace.js
  inspector.js
  review.js
  settings.js
```

A small module split is justified. A full React/Vue migration is not part of this milestone.

Keep existing APIs initially. Add presentation endpoints only where the current `ViewPreview` lacks data.

## 10. Required server projection

Add a read-only endpoint such as:

```text
GET /api/views/:viewId/workspace
```

It should use `projectSemanticViewWorkspace` and return:

- hero summary;
- counts;
- sectioned visual cards;
- review lane;
- layout options;
- suggested prompts.

The current `ViewPreview.samples` limit of 12 is insufficient for a workspace. Use bounded pagination per section.

Add:

```text
GET /api/resources/:id/inspector
GET /api/views/:viewId/sections/:sectionId
```

The inspector endpoint should combine ResourceBrief, view membership, notes, evidence summaries, related views, and atomic items without exposing raw private URLs unnecessarily.

## 11. Role-play gate

Before the human uses the app, the local agent must run five roles from `roleplayScenarios.ts`.

### Creative collector

Tests whether a person can browse inspiration visually without reading a giant list.

### Project builder

Tests cross-domain sections, atomic items, and evidence inspection.

### Skeptical curator

Tests explanations, granular correction, and visible consequences.

### Tab triager

Tests keyboard-first rapid review and preload behavior.

### Returning user

Tests restart continuity and restoration of context.

## 12. Evaluation rules

Create:

```text
npm run eval:workspace-ux
```

Use deterministic fixtures and Playwright.

Measure:

- whether the requested artifact is visible;
- number of primary clicks;
- whether a user note appears before AI evidence;
- whether weak/conflict/review states are distinguishable without opening a card;
- whether the user can answer the scenario completion question;
- whether board position survives inspector open/close;
- whether review advances without perceptible blank state;
- whether restart restores conversation, artifact, and review progress.

Screenshot comparison may support the evaluation but cannot be the only criterion.

## 13. Implementation stride

### Phase A — presentation model

Integrate:

```text
src/presentation/contracts.ts
src/presentation/projectWorkspace.ts
tests/presentationWorkspace.test.ts
```

Add read-only workspace and inspector endpoints.

### Phase B — workspace shell

- convert horizontal navigation to a left rail;
- make Ask/visual workspace the default;
- collapse metrics into a small status disclosure;
- move security and diagnostics out of normal flow;
- remove the duplicate standalone planner from the main Ask surface.

### Phase C — visual board and inspector

- board sections;
- visual cards;
- state/evidence markers;
- section pagination;
- inspector drawer;
- explanation and correction controls.

### Phase D — agent presentation actions

Teach conversational action planning to emit presentation actions.

They execute on the client and should not be stored as persistent write actions unless conversation replay requires it.

### Phase E — focused review workspace

Apply the same visual card/inspector model to focused review.

### Phase F — role-play evaluation

Implement all scenarios and produce a redacted UX report.

## 14. Definition of done

Do not ask the human to begin the pilot until:

- the default result is visual, not a list;
- the conversation and result occupy one coherent workspace;
- duplicate planner UI is removed from the primary flow;
- all cards show a reason and evidence strength;
- user notes are visibly privileged;
- weak/conflict/review states are distinguishable;
- inspector preserves context;
- presentation commands work conversationally;
- review is keyboard-first and visibly preloaded;
- all five role-play scenarios pass;
- no backend/security/privacy regression occurs;
- existing release tests remain green.

## 15. Expected local-agent report

Report:

- commits created;
- UI files changed;
- workspace projection endpoint;
- layouts implemented;
- inspector tabs implemented;
- presentation actions implemented;
- role-play scenario result for each persona;
- screenshots stored under ignored local paths;
- accessibility checks;
- existing validation results;
- known UX limitations;
- final SHA.
