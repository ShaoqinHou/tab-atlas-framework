# Copy-paste prompt for your local Codex coding agent

Use this prompt after you place the zip under your Downloads folder and extract it. Adjust the exact zip/folder name only if needed.

```text
You are my local implementation agent for a project called TabAtlas.

Context:
I have a zip from the project lead at:
%USERPROFILE%\Downloads\tab-atlas-agentic-framework.zip

Unzip it to:
%USERPROFILE%\Downloads\tab-atlas-framework

If the zip file has the older name tab-atlas-framework.zip, use that instead. The important thing is that the extracted folder contains README.md, AGENTS.md, docs/, src/, knowledge/, and extension/.

Your role:
Turn this framework into a working local-first Windows web app MVP for organizing huge Chrome + Edge tab piles. The project lead has refined the vision: this must be an agent-first app where the user mostly talks to a built-in Codex-powered agent. The app should support flexible natural-language grouping, quick user tags/descriptions, and a focused one-by-one review mode. You are strong at coding; follow the framework instead of redesigning the product from scratch.

First actions:
1. Expand the zip if it is not already expanded.
2. cd into %USERPROFILE%\Downloads\tab-atlas-framework
3. Initialize a Git repository:
   git init
   git branch -M main
   git add .
   git commit -m "Add TabAtlas product framework"
4. Read these files before coding, in this exact order:
   - README.md
   - AGENTS.md
   - docs/15-agent-first-ux-contract.md
   - docs/16-focused-review-tagging.md
   - docs/17-semantic-view-planning.md
   - docs/18-agent-tool-protocol.md
   - docs/19-resource-brief-spec.md
   - docs/20-v2-product-audit.md
   - docs/12-implementation-plan.md
   - docs/00-current-setup-integration.md
   - docs/06-codex-integration.md
   - docs/08-security-privacy.md
5. Implement in small committed phases. Do not do one giant uncommitted change.

Core product constraints:
- Local-first only. Bind local server to 127.0.0.1.
- Do not upload tab data to any cloud service.
- Do not require OpenAI API keys for normal use.
- Use the installed Codex CLI / @openai/codex-sdk as the LLM backbone, similar in spirit to the auteur repo pattern, with a provider seam and structured output validation.
- The built-in Codex agent should operate through safe app tools such as searchResources, getResourceBriefs, planSemanticView, addUserAnnotation, getReviewNext, submitReviewDecision, and explainMembership.
- The LLM must reason over extracted briefs and user annotations. Do not make the LLM open every page or drive the browser.
- Preserve the existing Headless Tab Exporter design: passive MV3 extension, local receiver, snapshot JSON/TSV import, no cookies/passwords/local storage/raw profile parsing.
- User tags and user descriptions are high-priority evidence and must appear first in resource briefs.
- Do not close, move, group, or bookmark tabs automatically. Browser mutation must be future/approval-queue only.
- For YouTube, implement URL parsing and metadata/transcript-status artifact structure first. Do not add unofficial transcript scraping unless it is behind an explicit optional adapter and you report the risk clearly.
- Do not build a rigid taxonomy as the main product. Views are flexible semantic lenses, not folders.

Implementation target for this run:
Complete Phase 0 and as much of Phases 1-2 as possible from docs/12-implementation-plan.md:
- make the TypeScript scaffold compile;
- add/repair package scripts;
- implement importer for latest-all.json or tests/fixture-snapshot.json;
- implement URL normalization and SQLite schema initialization;
- add user_annotations and review_queue storage;
- build resource briefs with user annotations first;
- implement focused review service/endpoints for unmarked resources;
- add stub-provider tests that do not call Codex;
- commit your work.

Important behavior tests to add early:
1. A user note/tag appears before title/extracted evidence in ResourceBrief.
2. A user note can make a misleading-title resource match game inspiration.
3. A strict game inspiration view excludes unrelated art unless user evidence connects it.
4. A loose inspiration view includes cross-domain user-marked inspiration.
5. Skipped focused-review items are not lost forever.

Validation:
Run:
- npm install
- npm run typecheck
- npm test
- npm run lint
If a command does not exist, implement it or explain why not.
Only run the Codex smoke test if the scaffold is ready and you deliberately accept spending one subscription Codex turn. Do not run repeated paid/subscription turns.

At the end:
1. git status --short must be clean unless you explicitly explain uncommitted files.
2. Commit all completed work with clear commit messages.
3. Provide a final report using docs/13-agent-report-template.md.
4. Include the latest commit SHA and every validation command/output summary.
5. Report whether Codex smoke test was run and whether any subscription turns were spent.
6. Report which phase(s) are complete and what remains.

I will paste your report back to the project lead for review.
```
