# Security and Privacy Model

## Threat model

TabAtlas handles sensitive browser context. A URL list can reveal:

- personal interests;
- medical/legal/financial research;
- logged-in services;
- work projects;
- private documents;
- identity/account pages.

The app must be safe by default.

## Local-first rules

- Server binds to `127.0.0.1` only.
- No cloud upload.
- No scheduled daemon in v1.
- No automatic startup unless user explicitly enables it later.
- No cookies, passwords, local storage, or raw browser session files.
- No extension content scripts unless a later feature is explicitly approved.
- No autonomous browser control.

## LLM containment

Codex receives only sanitized extracted briefs, not full raw browser state by default.

Never send to Codex:

- cookies;
- authorization headers;
- local storage;
- password-manager content;
- full HTML from private pages;
- raw screenshots of logged-in tabs;
- private file contents unless user explicitly imports them.

## URL redaction

Some URLs contain secrets in query params. Add a redaction pass before storage and before Codex prompts:

- tokens;
- auth codes;
- signed URLs;
- emails;
- session IDs;
- API keys;
- long opaque query values.

Keep the original raw URL in a protected table only if needed for browser actions. Show the redacted URL in AI contexts.

## Fetching rules

Deterministic extractors should fetch only public pages without cookies.

Do not:

- send browser cookies;
- bypass login;
- execute arbitrary page JavaScript in v1;
- scrape private dashboards;
- hammer sites without rate limiting.

## Destructive action rules

Actions requiring explicit approval:

- closing tabs;
- moving tabs;
- creating browser tab groups;
- renaming browser tab groups;
- bookmarking/exporting to browser;
- deleting app data;
- enabling optional plugins.

## Audit log

Record:

- snapshots imported;
- extraction jobs run;
- Codex agent runs;
- view/category changes;
- user approvals;
- browser actions performed.

## Safe defaults

- Read-only advisory UI first.
- Browser mutation bridge disabled initially.
- Optional transcript adapters disabled initially.
- Privacy mode toggle: "Do not send sensitive-looking URLs to Codex".
- Manual review bucket for private/account pages.

## Failure honesty

If extraction fails, the UI should say so.

Bad:

> "This video is about 10 AI papers" when no transcript/description was available.

Good:

> "Likely a video about AI papers based on title only. Transcript unavailable. Confidence low."
