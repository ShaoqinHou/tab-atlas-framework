import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { SnapshotInput, RawTabObservation } from '../shared/schemas.js';
import { normalizeUrl } from '../normalize/url.js';

export interface ImportResult {
  snapshotId: string;
  capturedAt: string;
  tabCount: number;
  resourceCount: number;
}

export function normalizeSnapshotRows(input: unknown): RawTabObservation[] {
  if (Array.isArray(input)) return input.map(row => RawTabObservation.parse(row));
  const parsed = SnapshotInput.parse(input);
  const rows = parsed.tabs ?? parsed.rows;
  if (rows) return rows.map(row => RawTabObservation.parse(row));
  // Some exporter shapes may use browser-specific arrays. Extend here as real samples arrive.
  throw new Error('Unsupported snapshot shape: expected array, .tabs, or .rows');
}

export function importSnapshot(db: Database.Database, input: unknown, source = 'manual_import'): ImportResult {
  const rows = normalizeSnapshotRows(input);
  const capturedAt = new Date().toISOString();
  const snapshotId = `snap_${nanoid()}`;
  const seenResources = new Set<string>();

  const insertSnapshot = db.prepare('INSERT INTO snapshots (id, captured_at, source, raw_json) VALUES (?, ?, ?, ?)');
  const upsertResource = db.prepare(`
    INSERT INTO resources (id, canonical_url, redacted_url, url_hash, url_kind, host, title_best, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_url) DO UPDATE SET
      title_best = COALESCE(excluded.title_best, resources.title_best),
      last_seen_at = excluded.last_seen_at
  `);
  const selectResource = db.prepare('SELECT id FROM resources WHERE canonical_url = ?');
  const insertObservation = db.prepare(`
    INSERT INTO tab_observations
    (id, snapshot_id, resource_id, browser, window_id, tab_id, tab_index, active, pinned, group_id, group_title, group_color, title, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertSnapshot.run(snapshotId, capturedAt, source, JSON.stringify(input));
    for (const row of rows) {
      const n = normalizeUrl(row.url);
      let resourceId = (selectResource.get(n.canonicalUrl) as { id: string } | undefined)?.id;
      if (!resourceId) resourceId = `res_${n.urlHash.slice(0, 24)}`;
      upsertResource.run(resourceId, n.canonicalUrl, n.redactedUrl, n.urlHash, n.kind, n.host, row.title, capturedAt, capturedAt);
      seenResources.add(resourceId);
      insertObservation.run(
        `obs_${nanoid()}`,
        snapshotId,
        resourceId,
        row.browser,
        row.windowId?.toString() ?? null,
        row.tabId?.toString() ?? null,
        row.index ?? null,
        row.active ? 1 : 0,
        row.pinned ? 1 : 0,
        row.groupId?.toString() ?? null,
        row.groupTitle ?? '',
        row.groupColor ?? '',
        row.title ?? '',
        row.url,
      );
    }
  });
  tx();
  return { snapshotId, capturedAt, tabCount: rows.length, resourceCount: seenResources.size };
}
