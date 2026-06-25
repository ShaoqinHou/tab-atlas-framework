export type ProductionReceiverHealth = {
  profile?: unknown;
  databaseId?: unknown;
  port?: unknown;
  instanceName?: unknown;
};

export type ProductionReceiverGuardState = {
  wasRunning: boolean;
  stopped: boolean;
  restarted: boolean;
  blocked: boolean;
  blockReason?: string;
  health?: ProductionReceiverHealth;
};

export function evaluateProductionReceiverGuard(input: {
  health: ProductionReceiverHealth | null;
  expectedDatabaseId: string;
  productionPortOccupied: boolean;
  productionPort: number;
}): ProductionReceiverGuardState {
  if (!input.health) {
    if (input.productionPortOccupied) {
      return {
        wasRunning: false,
        stopped: false,
        restarted: false,
        blocked: true,
        blockReason: `Port ${input.productionPort} is occupied but does not expose TabAtlas health. Stop it before role-play.`,
      };
    }
    return { wasRunning: false, stopped: false, restarted: false, blocked: false };
  }

  const profile = typeof input.health.profile === 'string' ? input.health.profile : '';
  const databaseId = typeof input.health.databaseId === 'string' ? input.health.databaseId : '';
  if (profile !== 'production' || databaseId !== input.expectedDatabaseId) {
    return {
      wasRunning: true,
      stopped: false,
      restarted: false,
      blocked: true,
      health: input.health,
      blockReason: `Port ${input.productionPort} has a TabAtlas receiver, but it does not match profile=production and databaseId=${input.expectedDatabaseId}.`,
    };
  }

  return {
    wasRunning: true,
    stopped: false,
    restarted: false,
    blocked: true,
    health: input.health,
    blockReason: `Role-play blocked by running production receiver on port ${input.productionPort}. Stop production with the supported launcher workflow before running pre-human role-play.`,
  };
}
