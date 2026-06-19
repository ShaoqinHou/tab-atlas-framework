import { z } from 'zod';

export const BrowserExecutionStrategy = z.enum([
  'bundled_chromium_playwright',
  'chrome_product_cdp',
  'edge_product_cdp',
  'chrome_manual_load_unpacked',
  'edge_manual_load_unpacked',
]);
export type BrowserExecutionStrategy = z.infer<typeof BrowserExecutionStrategy>;

export const BrowserExecutionEvidence = z.object({
  browser: z.enum(['chromium', 'chrome', 'edge']),
  strategy: BrowserExecutionStrategy,
  automated: z.boolean(),
  isolatedProfile: z.boolean(),
  executableVersion: z.string().min(1),
  executablePathHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  extensionLoadMethod: z.enum([
    'playwright_load_extension_flags',
    'cdp_extensions_load_unpacked',
    'manual_load_unpacked',
  ]),
  receiverUrl: z.string().url(),
  acceptanceSessionId: z.string().min(1),
  capabilityId: z.string().min(1),
  snapshotId: z.string().min(1),
  denialAuditId: z.string().min(1),
  popupOpened: z.boolean(),
  receiverReachable: z.boolean(),
  pairedThroughPopup: z.boolean(),
  snapshotExportedThroughPopup: z.boolean(),
  snapshotArrived: z.boolean(),
  revocationObserved: z.boolean(),
  tokenAbsentFromSnapshot: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type BrowserExecutionEvidence = z.infer<typeof BrowserExecutionEvidence>;

export function validateBrowserExecutionEvidence(
  raw: BrowserExecutionEvidence,
): string[] {
  const evidence = BrowserExecutionEvidence.parse(raw);
  const errors: string[] = [];
  const expected = expectedStrategy(evidence.browser, evidence.strategy);
  if (expected.error) errors.push(expected.error);
  if (expected.automated !== undefined && evidence.automated !== expected.automated) {
    errors.push(`${evidence.strategy} automated flag must be ${expected.automated}`);
  }
  if (expected.loadMethod && evidence.extensionLoadMethod !== expected.loadMethod) {
    errors.push(`${evidence.strategy} requires ${expected.loadMethod}`);
  }
  if (evidence.automated && !evidence.isolatedProfile) {
    errors.push('automated browser acceptance requires an isolated profile');
  }
  if (!allBehaviorProofPassed(evidence)) {
    errors.push(`${evidence.browser} browser behavior evidence is incomplete`);
  }
  if (Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt)) {
    errors.push('browser acceptance finished before it started');
  }
  return errors;
}

export function allBehaviorProofPassed(evidence: BrowserExecutionEvidence): boolean {
  return evidence.popupOpened
    && evidence.receiverReachable
    && evidence.pairedThroughPopup
    && evidence.snapshotExportedThroughPopup
    && evidence.snapshotArrived
    && evidence.revocationObserved
    && evidence.tokenAbsentFromSnapshot;
}

function expectedStrategy(
  browser: BrowserExecutionEvidence['browser'],
  strategy: BrowserExecutionStrategy,
): { automated?: boolean; loadMethod?: BrowserExecutionEvidence['extensionLoadMethod']; error?: string } {
  switch (strategy) {
    case 'bundled_chromium_playwright':
      return browser === 'chromium'
        ? { automated: true, loadMethod: 'playwright_load_extension_flags' }
        : { error: 'bundled Chromium evidence cannot be labelled Chrome or Edge' };
    case 'chrome_product_cdp':
      return browser === 'chrome'
        ? { automated: true, loadMethod: 'cdp_extensions_load_unpacked' }
        : { error: 'Chrome CDP evidence must be labelled chrome' };
    case 'edge_product_cdp':
      return browser === 'edge'
        ? { automated: true, loadMethod: 'cdp_extensions_load_unpacked' }
        : { error: 'Edge CDP evidence must be labelled edge' };
    case 'chrome_manual_load_unpacked':
      return browser === 'chrome'
        ? { automated: false, loadMethod: 'manual_load_unpacked' }
        : { error: 'manual Chrome evidence must be labelled chrome' };
    case 'edge_manual_load_unpacked':
      return browser === 'edge'
        ? { automated: false, loadMethod: 'manual_load_unpacked' }
        : { error: 'manual Edge evidence must be labelled edge' };
  }
}
