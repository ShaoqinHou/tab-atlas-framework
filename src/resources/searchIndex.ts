import type Database from 'better-sqlite3';

export function refreshResourceSearchText(db: Database.Database, resourceId: string): void {
  const resource = db.prepare(`
    SELECT id, title_best, redacted_url
    FROM resources
    WHERE id = ?
  `).get(resourceId) as { id: string; title_best: string | null; redacted_url: string } | undefined;
  if (!resource) return;

  const annotations = db.prepare(`
    SELECT tags_json, description, decision
    FROM user_annotations
    WHERE target_kind = 'resource' AND target_id = ?
  `).all(resourceId) as { tags_json: string; description: string | null; decision: string }[];

  const userText = annotations
    .flatMap(annotation => [...parseStringArray(annotation.tags_json), annotation.description ?? '', annotation.decision])
    .filter(Boolean)
    .join(' ');

  const extractedText = (db.prepare(`
    SELECT text_excerpt, json_payload
    FROM extraction_artifacts
    WHERE resource_id = ?
  `).all(resourceId) as { text_excerpt: string | null; json_payload: string | null }[])
    .map(row => row.text_excerpt ?? summarizeJsonPayload(row.json_payload))
    .filter(Boolean)
    .join(' ');

  db.prepare('DELETE FROM resource_fts WHERE resource_id = ?').run(resourceId);
  db.prepare(`
    INSERT INTO resource_fts (resource_id, title, url, user_text, extracted_text)
    VALUES (?, ?, ?, ?, ?)
  `).run(resource.id, resource.title_best ?? '', resource.redacted_url, userText, extractedText);
}

function summarizeJsonPayload(payload: string | null): string {
  if (!payload) return '';
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return '';
    return Object.entries(parsed)
      .flatMap(([key, value]) => typeof value === 'string' ? [`${key}: ${value}`] : [])
      .join(' ');
  } catch {
    return '';
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
