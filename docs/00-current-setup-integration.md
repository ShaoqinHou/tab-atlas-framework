# Current Setup Integration: Headless Tab Exporter → TabAtlas

Your current prototype is valuable and should not be replaced. TabAtlas should absorb it as the capture layer.

## Existing capture behavior to preserve

The current Headless Tab Exporter design has these properties:

- Passive Manifest V3 extension installed in Chrome and Edge.
- Local receiver runs only when needed on `http://127.0.0.1:9786`.
- Extension OFF means no listeners, no checks, no export.
- Extension ON means passive low-impact mode:
  - checks `/health` on localhost;
  - exports only if receiver is running;
  - debounces tab/window/group changes;
  - does a low-rate periodic check around once per minute.
- Receiver endpoints:
  - `GET /health`
  - `POST /snapshot`
- Receiver writes JSON, TSV, and URL text exports.
- One-shot script can launch closed browsers headlessly, capture restored session tabs, and close only the browser processes it launched.
- It avoids cookies, passwords, local storage, raw session-store parsing, and normal-operation UI automation.

## How TabAtlas should consume it

TabAtlas should add a second local app layer:

```text
Chrome extension ┐
                 ├─> Headless Tab Exporter receiver ─> latest-all.json
Edge extension   ┘                                      latest-all-tabs.tsv
                                                          latest-all-urls.txt
                                                                  │
                                                                  ▼
                                                       TabAtlas importer
                                                                  │
                                                                  ▼
                                                       SQLite knowledge store
                                                                  │
                            deterministic extractors ─────────────┤
                                                                  ▼
                                                       Codex reasoning worker
                                                                  │
                                                                  ▼
                                                       dynamic views + UI
```

## Integration contract

TabAtlas should accept both modes:

1. **Pull mode**: user points TabAtlas to the capture folder; TabAtlas imports `latest-all.json` on demand.
2. **Receiver mode**: TabAtlas exposes its own compatible `/snapshot` endpoint and can replace the original receiver later.

## Import semantics

- A browser tab snapshot is not the same as a long-term saved resource.
- `browser + windowId + tabId` are ephemeral.
- `canonicalUrl` and `normalizedUrlHash` identify resources across snapshots.
- A tab can be open many times; a resource should have one main knowledge record.
- Preserve current browser tab groups as user evidence, not as final categories.

## First implementation target

The first working TabAtlas should import this JSON shape:

```json
{
  "capturedAt": "2026-06-16T16:24:30.000Z",
  "tabs": [
    {
      "browser": "edge",
      "windowId": 12345,
      "tabId": 67890,
      "title": "Example",
      "url": "https://example.com/",
      "groupId": 12,
      "groupTitle": "Research",
      "groupColor": "blue",
      "groupCollapsed": false
    }
  ]
}
```

If the current exporter uses a different top-level shape, the importer should detect it and normalize it.
