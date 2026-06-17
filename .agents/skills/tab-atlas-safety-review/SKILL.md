# TabAtlas Safety Review Skill

Use this skill before merging changes that affect data capture, extraction, LLM prompts, or browser actions.

## Blockers

Block the change if it:

- uploads tab data by default;
- reads cookies/passwords/local storage/raw browser profiles;
- lets Codex browse or mutate browser state autonomously;
- closes/moves/bookmarks tabs without explicit approval;
- hides transcript/extraction failures;
- commits local secrets or Codex auth files.

## Required checks

- Server binds to 127.0.0.1.
- Tests do not require Codex turns.
- Codex prompts contain only sanitized briefs.
- Agent runs are logged.
- Browser mutation is behind an approval queue or not implemented.
