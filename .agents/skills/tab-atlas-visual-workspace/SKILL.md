# TabAtlas agent visual workspace

Read `docs/35-agent-visual-workspace-handoff.md` before changing the main UI.

## Product invariant

TabAtlas is not a chat box beside a list of links. The conversation expresses intent; the workspace makes the result visible and manipulable.

The UI must show:

```text
overview
-> visual sections and cards
-> filters/focus
-> detail inspector
-> evidence and correction
```

## Extend these scaffolds

```text
src/presentation/contracts.ts
src/presentation/projectWorkspace.ts
src/presentation/roleplayScenarios.ts
tests/presentationWorkspace.test.ts
web-ui/prototypes/agent-workspace-wireframe.html
```

Do not replace the server, resource model, view model, review service, conversation service, or action protocol.

## Required interaction hierarchy

1. Persistent left navigation: Ask, Review, Views.
2. Center workspace: current visual artifact.
3. Collapsible conversation panel.
4. Right inspector: overview, evidence, notes, related.
5. Diagnostics/settings remain secondary.

## Presentation rules

- Default semantic-view layout is a sectioned board.
- Gallery emphasizes visual material.
- Map is an overview, not a force-directed spaghetti graph.
- Compact mode is available for scanning, never the only view.
- Excluded resources are collapsed by default.
- Weak/conflict/review states are visually distinct.
- Every card gives a short “why this belongs” explanation.
- User notes appear before generated analysis.
- A card opens an inspector without losing the board position.
- Presentation actions never change memberships or browser tabs.
- Data-changing actions retain existing confirmations.

## Role-play before human use

Implement Playwright scenarios from `src/presentation/roleplayScenarios.ts`.

The coding agent must complete all five personas:

- creative collector;
- project builder;
- skeptical curator;
- tab triager;
- returning user.

Do not claim UX-ready merely because screenshots look polished. Verify task completion, correction behavior, visual comprehension, keyboard flow, and restart continuity.
