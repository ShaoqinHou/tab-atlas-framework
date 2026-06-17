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

type JsonRecord = Record<string, unknown>;

export function normalizeSnapshotRows(input: unknown): RawTabObservation[] {
  if (Array.isArray(input)) return input.map(row => RawTabObservation.parse(row));
  if (isRecord(input)) {
    const browserRows = normalizePerBrowserSnapshots(input);
    if (browserRows.length) return browserRows.map(row => RawTabObservation.parse(row));
  }
  const parsed = SnapshotInput.parse(input);
  const rows = parsed.tabs ?? parsed.rows;
  if (rows) return rows.map(row => RawTabObservation.parse(row));
  throw new Error('Unsupported snapshot shape: expected array, .tabs, .rows, or per-browser latest-all object');
}

export function importSnapshot(db: Database.Database, input: unknown, source = 'manual_import'): ImportResult {
  const rows = normalizeSnapshotRows(input);
  const capturedAt = findCapturedAt(input, rows) ?? new Date().toISOString();
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
  const deleteFts = db.prepare('DELETE FROM resource_fts WHERE resource_id = ?');
  const insertFts = db.prepare(`
    INSERT INTO resource_fts (resource_id, title, url, user_text, extracted_text)
    VALUES (?, ?, ?, ?, ?)
  `);
  const hasResourceAnnotation = db.prepare(`
    SELECT 1 FROM user_annotations
    WHERE target_kind = 'resource' AND target_id = ?
    LIMIT 1
  `);
  const ensureReviewQueueItem = db.prepare(`
    INSERT INTO review_queue_items (id, resource_id, queue_name, status, reason, priority, position, created_at)
    VALUES (?, ?, 'unmarked', 'pending', 'No user tag, note, or decision yet.', 0, NULL, ?)
    ON CONFLICT(queue_name, resource_id) DO NOTHING
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
      deleteFts.run(resourceId);
      insertFts.run(resourceId, row.title ?? '', n.redactedUrl, row.groupTitle ?? '', '');
      if (!hasResourceAnnotation.get(resourceId)) {
        ensureReviewQueueItem.run(`rq_${nanoid()}`, resourceId, capturedAt);
      }
    }
  });
  tx();
  return { snapshotId, capturedAt, tabCount: rows.length, resourceCount: seenResources.size };
}

function normalizePerBrowserSnapshots(input: JsonRecord): RawTabObservation[] {
  const rows: RawTabObservation[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value) || !Array.isArray(value.tabs)) continue;
    const browser = browserNameFromKeyOrUserAgent(key, value.userAgent);
    const groups = mapById(value.groups);
    const windows = mapById(value.windows);
    const capturedAt = typeof value.capturedAt === 'string' ? value.capturedAt : undefined;

    for (const rawTab of value.tabs) {
      if (!isRecord(rawTab)) continue;
      const url = readString(rawTab.url) || readString(rawTab.pendingUrl);
      if (!url) continue;
      const groupId = readId(rawTab.groupId);
      const windowId = readId(rawTab.windowId);
      const group = groupId === undefined ? undefined : groups.get(groupId);
      const windowInfo = windowId === undefined ? undefined : windows.get(windowId);
      rows.push({
        browser,
        capturedAt,
        windowId,
        windowFocused: readBoolean(windowInfo?.focused),
        tabId: readId(rawTab.id) ?? readId(rawTab.tabId),
        index: readNumber(rawTab.index),
        active: readBoolean(rawTab.active),
        pinned: readBoolean(rawTab.pinned),
        audible: readBoolean(rawTab.audible),
        muted: readBoolean(rawTab.muted),
        discarded: readBoolean(rawTab.discarded),
        autoDiscardable: readBoolean(rawTab.autoDiscardable),
        incognito: readBoolean(rawTab.incognito),
        groupId,
        groupTitle: readString(group?.title) ?? '',
        groupColor: readString(group?.color) ?? '',
        groupCollapsed: readBoolean(group?.collapsed),
        title: readString(rawTab.title) ?? '',
        url,
      });
    }
  }
  return rows;
}

function mapById(value: unknown): Map<string | number, JsonRecord> {
  const map = new Map<string | number, JsonRecord>();
  if (!Array.isArray(value)) return map;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = readId(item.id);
    if (id !== undefined) map.set(id, item);
  }
  return map;
}

function findCapturedAt(input: unknown, rows: RawTabObservation[]): string | undefined {
  if (isRecord(input) && typeof input.capturedAt === 'string') return input.capturedAt;
  const rowCapturedAt = rows.find(row => row.capturedAt)?.capturedAt;
  if (rowCapturedAt) return rowCapturedAt;
  if (isRecord(input)) {
    for (const value of Object.values(input)) {
      if (isRecord(value) && typeof value.capturedAt === 'string') return value.capturedAt;
    }
  }
  return undefined;
}

function browserNameFromKeyOrUserAgent(key: string, userAgent: unknown): RawTabObservation['browser'] {
  const lowerKey = key.toLowerCase();
  if (lowerKey === 'chrome') return 'chrome';
  if (lowerKey === 'edge') return 'edge';
  if (typeof userAgent === 'string') {
    if (userAgent.includes('Edg/')) return 'edge';
    if (userAgent.includes('Chrome/')) return 'chrome';
  }
  return 'unknown';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
