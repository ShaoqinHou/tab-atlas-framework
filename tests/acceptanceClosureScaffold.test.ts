import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserStrategyAdvice } from '../src/acceptance/browserStrategy.js';
import { CheckpointStore } from '../src/acceptance/checkpointStore.js';
import { compactChunkDecisions, SemanticChunkResult } from '../src/ai/hierarchicalPlannerContracts.js';

describe('acceptance closure scaffold', () => {
  it('persists checkpoint status and honors resume options', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-checkpoint-'));
    const checkpointPath = path.join(dir, 'checkpoints.json');
    const store = new CheckpointStore<{ ok: boolean }>(checkpointPath);

    store.start('command-a', 1000);
    store.pass('command-a', { ok: true });

    const reopened = new CheckpointStore<{ ok: boolean }>(checkpointPath);
    expect(reopened.get('command-a')?.result).toEqual({ ok: true });
    expect(reopened.shouldRun('command-a', { resume: true })).toBe(false);
    expect(reopened.shouldRun('command-a', { resume: false })).toBe(true);
  });

  it('labels bundled Chromium as automated and Chrome/Edge as manual', () => {
    expect(browserStrategyAdvice('bundled_chromium_automated')).toMatchObject({
      browserLabel: 'chromium',
      automated: true,
      supported: true,
    });
    expect(browserStrategyAdvice('chrome_manual_load_unpacked')).toMatchObject({
      browserLabel: 'chrome',
      automated: false,
      supported: true,
    });
    expect(browserStrategyAdvice('edge_manual_load_unpacked')).toMatchObject({
      browserLabel: 'edge',
      automated: false,
      supported: true,
    });
  });

  it('preserves chunk disagreements as merge conflicts', () => {
    const chunks = [
      SemanticChunkResult.parse({
        commandText: 'Make a project view',
        chunkId: 'chunk-1',
        decisions: [{
          targetKind: 'resource',
          targetId: 'res_1',
          state: 'strong_include',
          evidenceRefs: ['ev_1'],
        }],
      }),
      SemanticChunkResult.parse({
        commandText: 'Make a project view',
        chunkId: 'chunk-2',
        decisions: [{
          targetKind: 'resource',
          targetId: 'res_1',
          state: 'needs_review',
          evidenceRefs: ['ev_2'],
        }],
      }),
    ];

    expect(compactChunkDecisions(chunks)).toEqual([{
      targetKind: 'resource',
      targetId: 'res_1',
      states: ['strong_include', 'needs_review'],
      evidenceRefs: ['ev_1', 'ev_2'],
    }]);
  });
});
