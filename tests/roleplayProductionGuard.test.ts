import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateProductionReceiverGuard } from '../src/runtime/roleplayProductionGuard.js';

describe('role-play production receiver guard', () => {
  it('allows role-play when no production receiver is running', () => {
    expect(evaluateProductionReceiverGuard({
      health: null,
      expectedDatabaseId: 'db_prod',
      productionPortOccupied: false,
      productionPort: 9787,
    })).toMatchObject({
      wasRunning: false,
      blocked: false,
    });
  });

  it('blocks safely when the matching production receiver is running', () => {
    expect(evaluateProductionReceiverGuard({
      health: { profile: 'production', databaseId: 'db_prod', port: 9787 },
      expectedDatabaseId: 'db_prod',
      productionPortOccupied: true,
      productionPort: 9787,
    })).toMatchObject({
      wasRunning: true,
      stopped: false,
      restarted: false,
      blocked: true,
    });
  });

  it('blocks safely on receiver identity mismatch', () => {
    const result = evaluateProductionReceiverGuard({
      health: { profile: 'production', databaseId: 'db_other', port: 9787 },
      expectedDatabaseId: 'db_prod',
      productionPortOccupied: true,
      productionPort: 9787,
    });

    expect(result.blocked).toBe(true);
    expect(result.blockReason).toMatch(/does not match/);
    expect(result.stopped).toBe(false);
  });

  it('does not contain taskkill force-kill in the role-play runner', () => {
    const script = fs.readFileSync('scripts/roleplay-prehuman.ts', 'utf8');
    expect(script).not.toMatch(/taskkill(?:\.exe)?[\s\S]*\/F/i);
  });

  it('keeps pre-human role-play evidence deterministic across actions and views', () => {
    const script = fs.readFileSync('scripts/roleplay-prehuman.ts', 'utf8');
    const providerScope = fs.readFileSync('src/llm/providerScope.ts', 'utf8');
    expect(script).toContain('--provider <provider>');
    expect(script).toContain('--resilience');
    expect(script).toContain("roleplayGate: RoleplayGate = opts.resilience ? 'live_resilience' : 'deterministic_release'");
    expect(script).toContain('TABATLAS_ROLEPLAY_PROVIDER: roleplayProvider');
    expect(script).toContain('latestActionResultViewEvidenceSince');
    expect(script).toContain("requiredActionKinds: ['plan_view']");
    expect(script).toContain('waitForReviewActionOrSessionSince');
    expect(script).toContain('reviewSessionCount(cloneDb) > previousReviewSessions');
    expect(script).toContain('openViewById(page, projectView.id, projectView.name)');
    expect(script).toContain('clearInvalidActiveViewThroughControl');
    expect(script).toContain("localStorage.setItem('tabatlas.workspace.activeViewId', '')");
    expect(script).toContain("page.locator('#refreshButton').click");
    expect(script).toContain('selectViewOptionThroughControl');
    expect(script).toContain("response.url().includes(`/api/views/${encodeURIComponent(viewId)}/workspace`)");
    expect(script).toContain('normalizedWorkspace.includes(normalizedName)');
    expect(script).toContain("requiredActionKinds: ['scan_resources']");
    expect(script).toContain('waitForTerminalActionKindSince');
    expect(script).toContain('states.some(action => visibleActionIds.includes(action.id))');
    expect(script).toContain("Per-story interaction timeout', '300000'");
    expect(providerScope).toContain('class RoleplayDeterministicProvider');
    expect(providerScope).toContain("process.env.TABATLAS_ROLEPLAY_PROVIDER === 'deterministic'");
    expect(providerScope).toContain('roleplay_watch_later_view');
    expect(providerScope).toContain('roleplay_scan_video_evidence');
  });
});
