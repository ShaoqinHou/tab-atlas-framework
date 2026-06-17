# TabAtlas Extraction Design Skill

Use this skill when implementing URL/page/video/PDF extractors.

## Rule

Extraction should be deterministic, auditable, and provenance-aware. Codex consumes extraction artifacts; it should not perform arbitrary browsing.

## Extractor output requirements

Every extractor returns:

- `status`
- `artifactKind`
- `textExcerpt` or structured JSON
- `provenance`
- `confidence`
- `errorCode` if failed
- `sourceUrl`

## Privacy requirements

- Fetch without cookies.
- Do not execute arbitrary page scripts in v1.
- Redact secrets from URLs and text snippets.
- Rate-limit per host.
- Store failure honestly.

## YouTube note

Official captions download is not a universal transcript solution for arbitrary public videos. Implement URL parsing and metadata first; transcript adapters must be explicit and provenance-labeled.
