import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot, normalizeSnapshotRows } from '../src/import/headlessSnapshot.js';
import fixture from './fixture-snapshot.json' with { type: 'json' };

describe('Headless Tab Exporter import', () => {
  it('imports flattened fixture snapshots into resources, observations, and review queue', () => {
    const db = openDatabase(':memory:');
    const result = importSnapshot(db, fixture, 'test');

    expect(result.tabCount).toBe(2);
    expect(result.resourceCount).toBe(2);
    expect(result.capturedAt).toBe('2026-06-16T16:24:30.000Z');

    const resources = db.prepare('SELECT COUNT(*) AS count FROM resources').get() as { count: number };
    const observations = db.prepare('SELECT COUNT(*) AS count FROM tab_observations').get() as { count: number };
    const reviewItems = db.prepare('SELECT COUNT(*) AS count FROM review_queue_items WHERE queue_name = ?').get('unmarked') as { count: number };

    expect(resources.count).toBe(2);
    expect(observations.count).toBe(2);
    expect(reviewItems.count).toBe(2);
  });

  it('normalizes real latest-all per-browser JSON and preserves tab group context', () => {
    const rows = normalizeSnapshotRows({
      chrome: {
        capturedAt: '2026-06-16T16:24:28.000Z',
        userAgent: 'Mozilla/5.0 HeadlessChrome/149.0.0.0',
        windows: [{ id: 10, focused: true }],
        groups: [{ id: 7, title: 'Ideas', color: 'blue', collapsed: false }],
        tabs: [{
          id: 11,
          windowId: 10,
          index: 0,
          groupId: 7,
          active: true,
          pinned: false,
          title: 'Inventory UI reference',
          url: 'https://youtu.be/dQw4w9WgXcQ?utm_source=x',
        }],
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].browser).toBe('chrome');
    expect(rows[0].capturedAt).toBe('2026-06-16T16:24:28.000Z');
    expect(rows[0].groupTitle).toBe('Ideas');
    expect(rows[0].windowFocused).toBe(true);
  });
});
