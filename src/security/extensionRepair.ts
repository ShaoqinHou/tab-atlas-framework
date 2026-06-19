import type Database from 'better-sqlite3';
import {
  getCapability,
  revokeCapability,
  type CapabilityRecord,
} from './localCapability.js';
import {
  createPairingChallenge,
  type PairingChallengeRecord,
} from './pairingChallenge.js';

export type ExtensionProductBrowser = 'chrome' | 'edge';

export interface ExtensionRepairResult {
  browser: ExtensionProductBrowser;
  revokedCapability: CapabilityRecord;
  challenge: PairingChallengeRecord;
  secret: string;
  expiresAt: string;
}

export function rePairExtensionCapability(
  db: Database.Database,
  capabilityId: string,
  input: { ttlMs?: number } = {},
): ExtensionRepairResult {
  const capability = getCapability(db, capabilityId);
  if (capability.kind !== 'extension') {
    throw new Error('Only extension capabilities can be re-paired');
  }
  const browser = resolveCapabilityBrowser(db, capability);
  if (!browser) {
    throw new Error('Extension capability is not tied to Chrome or Edge');
  }

  const tx = db.transaction(() => {
    const revokedCapability = revokeCapability(db, capability.id);
    const created = createPairingChallenge(db, {
      kind: 'extension',
      scopes: ['snapshot:write'],
      browser,
      label: `${browser} extension re-pair`,
      ttlMs: input.ttlMs,
      maxAttempts: 5,
    });
    return {
      browser,
      revokedCapability,
      challenge: created.challenge,
      secret: created.secret,
      expiresAt: created.challenge.expiresAt,
    };
  });
  return tx();
}

function resolveCapabilityBrowser(
  db: Database.Database,
  capability: CapabilityRecord,
): ExtensionProductBrowser | null {
  const challenge = db.prepare(`
    SELECT browser
    FROM pairing_challenges
    WHERE capability_id = ?
      AND browser IN ('chrome', 'edge')
    ORDER BY COALESCE(used_at, created_at) DESC
    LIMIT 1
  `).get(capability.id) as { browser: ExtensionProductBrowser } | undefined;
  if (challenge?.browser) return challenge.browser;
  const labelMatch = capability.label?.toLowerCase().match(/\b(chrome|edge)\b/);
  return labelMatch?.[1] === 'chrome' || labelMatch?.[1] === 'edge' ? labelMatch[1] : null;
}
