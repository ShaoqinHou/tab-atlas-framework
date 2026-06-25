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
});
