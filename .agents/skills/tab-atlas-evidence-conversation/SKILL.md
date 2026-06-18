# TabAtlas evidence and conversation

Read `docs/27-evidence-and-conversation-runtime-handoff.md` before changing extraction, feedback relevance, or conversational behavior.

## Invariants

- User notes and explicit corrections outrank generated evidence.
- Feedback is purpose-scoped unless the user explicitly marks it global.
- Every extraction artifact records adapter, version, status, provenance, confidence, and source.
- A transcript claim requires a stored transcript artifact.
- Public fetches must pass URL, resolved-address, redirect, timeout, type, and size checks.
- Conversation actions are typed and persisted.
- Read/preview actions may run directly; annotations, scans, and view acceptance require confirmation.
- Current app actions do not include browser tab mutation.

## Extend, do not replace

```text
src/extract/adapterContracts.ts
src/extract/networkPolicy.ts
src/extract/youtubeContracts.ts
src/preferences/intentScope.ts
src/preferences/feedbackContextService.ts
src/agent/actionProtocol.ts
src/agent/conversationService.ts
src/db/schema-v3-evidence.sql
```

Use durable jobs for extraction. Add fake adapters and fixtures before real network tests. Keep explicit failure states and provenance visible to the resource brief and UI.
