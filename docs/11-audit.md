# Plan Audit

## User intention coverage

| User intention | Design response |
|---|---|
| Too many Chrome/Edge tabs | Snapshot import + unique resource store + dynamic views |
| Does not want to close tabs blindly | Read-only first, approval queue for destructive actions |
| Lists are too long | View cards, clusters, map, evidence drill-down |
| Needs intelligence | Codex reasoning layer over extracted briefs |
| Avoid API billing | Local Codex SDK/CLI provider, no API-key default |
| LLM should not open every page | Deterministic extractors + no autonomous browsing rule |
| YouTube needs standardized workflow | Dedicated YouTube recipe and transcript status model |
| Videos can contain many important points | Atomic items model |
| Categories should be dynamic | Views/tags are AI/user-created and overlapping |
| User can describe desired groups | Command bar + view mutation plans |
| Need knowledge system | AGENTS.md + .agents skills + knowledge recipes/policies/schemas |
| Local Codex agents need handoff | Handoff prompt + implementation plan + report template |
| GitHub repo should be initialized | Handoff explicitly instructs `git init`, commits, final report |

## Major risks

### Risk: transcript extraction expectations are too high

Mitigation: honest transcript adapter model; metadata-only fallback; UI confidence; no hallucinated details.

### Risk: Codex quota/time use becomes annoying

Mitigation: batch prompts; cache; deterministic extraction first; one worker; visible turn count; stub provider for tests.

### Risk: categories become noisy

Mitigation: proposed vs accepted status; view merging; user language preservation; confidence thresholds; evidence inspector.

### Risk: privacy leak through URLs

Mitigation: local-only; redaction; no cookies; sensitive pages bucket; do not send private-looking URLs to Codex by default.

### Risk: browser mutation breaks trust

Mitigation: disable browser actions initially; approval queue; dry-run previews; undo/export.

### Risk: extension limitations differ across Chrome/Edge

Mitigation: keep current tested extension behavior; schema-normalize captures; build browser-specific adapter layer.

## Missing decisions for the coding agent to resolve

- Exact UI framework: React/Vite vs Next.js.
- SQLite package: `better-sqlite3` vs `sqlite`/`sqlite3`.
- Queue package: simple in-process queue first, no Redis.
- Transcript adapter implementation: leave disabled until explicit review.
- Whether to merge the existing exporter code or import its files first.

## Recommended first MVP boundary

Do not try to build everything. First MVP:

1. Import latest capture.
2. Normalize URLs.
3. Store in SQLite.
4. Show local web UI counts and view cards.
5. Run one Codex batch categorization from title/URL/group/metadata only.
6. No browser actions yet.

## V2 audit after user clarification

The clarified product vision changes the MVP bar.

The app is not successful if it only imports tabs and shows a sortable list. It must include:

- an agent command surface;
- semantic view previews;
- user tags/descriptions as first-class evidence;
- a focused unmarked-link review mode;
- flexible grouping logic that supports strict/loose/purpose-based commands;
- reusable app tools for Codex to operate safely.

The highest risk is that a coding agent builds a rigid taxonomy UI. The implementation plan now explicitly requires semantic views and focused review early.
