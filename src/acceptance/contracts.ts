import { z } from 'zod';

export const BrowserAcceptanceSmoke = z.object({
  browser: z.enum(['chromium', 'chrome', 'edge']),
  mode: z.enum(['automated', 'manual']),
  popupOpened: z.boolean(),
  receiverReachable: z.boolean(),
  pairedThroughPopup: z.boolean(),
  snapshotExportedThroughPopup: z.boolean(),
  snapshotArrived: z.boolean(),
  revocationVisible: z.boolean(),
  tokenAbsentFromSnapshot: z.boolean(),
  notes: z.string().default(''),
});
export type BrowserAcceptanceSmoke = z.infer<typeof BrowserAcceptanceSmoke>;

export const PrivateLibraryCommandSmoke = z.object({
  commandId: z.string(),
  description: z.string(),
  status: z.enum(['passed', 'failed', 'timeout', 'skipped']).default('passed'),
  mode: z.enum(['codex', 'heuristic']).default('codex'),
  durationMs: z.number().int().nonnegative().optional(),
  candidateCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
  retrievalSourceCoverage: z.record(z.string(), z.number().int().nonnegative()),
  retrievalRunId: z.string().optional(),
  promptManifestIds: z.array(z.string()).default([]),
  agentRunId: z.string().optional(),
  providerScope: z.string().optional(),
  providerThreadId: z.string().nullable().optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    quotaTurns: z.number().int().nonnegative().optional(),
  }).optional(),
  codexTurns: z.number().int().nonnegative(),
  strongIncludeCount: z.number().int().nonnegative(),
  weakIncludeCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  needsReviewCount: z.number().int().nonnegative(),
  evidenceReasonCategories: z.array(z.string()),
  usedUserNotes: z.boolean(),
  usedCodexScanEvidence: z.boolean(),
  usedAtomicItems: z.boolean(),
  promptRedactionOk: z.boolean(),
  error: z.string().optional(),
});
export type PrivateLibraryCommandSmoke = z.infer<typeof PrivateLibraryCommandSmoke>;

export const RuntimePortCompatibility = z.object({
  serverUrl: z.string().url(),
  receiverListIncludesServer: z.boolean(),
  manifestCoversServer: z.boolean(),
  popupDefaultMatchesServer: z.boolean(),
});
export type RuntimePortCompatibility = z.infer<typeof RuntimePortCompatibility>;

export const ReleaseArtifacts = z.object({
  appPackagePath: z.string(),
  extensionPackagePath: z.string(),
  appPackageSha256: z.string().optional(),
  extensionPackageSha256: z.string().optional(),
  installDocsPath: z.string().min(1),
  backupRestoreDocsPath: z.string().min(1),
});
export type ReleaseArtifacts = z.infer<typeof ReleaseArtifacts>;

export const ValidationCommandResult = z.object({
  command: z.string().min(1),
  passed: z.boolean(),
  summary: z.string().default(''),
});
export type ValidationCommandResult = z.infer<typeof ValidationCommandResult>;

export const SafetyFlags = z.object({
  privateUrlsCommitted: z.boolean(),
  privateTitlesCommitted: z.boolean(),
  rawPromptBodiesCommitted: z.boolean(),
  tokensCommitted: z.boolean(),
  rawAcceptanceReportCommitted: z.boolean(),
});
export type SafetyFlags = z.infer<typeof SafetyFlags>;

export const LiveAcceptanceReport = z.object({
  schemaVersion: z.literal('tabatlas-live-acceptance-v1'),
  generatedAt: z.string(),
  runtime: RuntimePortCompatibility,
  browserSmokes: z.array(BrowserAcceptanceSmoke).min(2),
  privateLibrarySmoke: z.object({
    ran: z.boolean(),
    commands: z.array(PrivateLibraryCommandSmoke),
  }),
  validationCommands: z.array(ValidationCommandResult),
  releaseArtifacts: ReleaseArtifacts,
  safety: SafetyFlags,
  blockers: z.array(z.string()),
  releaseReady: z.boolean(),
});
export type LiveAcceptanceReport = z.infer<typeof LiveAcceptanceReport>;

export function acceptanceBlockers(report: LiveAcceptanceReport): string[] {
  const blockers = [...report.blockers];
  if (!report.runtime.receiverListIncludesServer || !report.runtime.manifestCoversServer || !report.runtime.popupDefaultMatchesServer) {
    blockers.push('runtime port incompatible');
  }
  const chromium = report.browserSmokes.find(item => item.browser === 'chromium');
  if (!chromium?.pairedThroughPopup || !chromium.snapshotExportedThroughPopup || !chromium.snapshotArrived || !chromium.revocationVisible) {
    blockers.push('chromium automated acceptance incomplete');
  }
  for (const browser of ['chrome', 'edge'] as const) {
    const smoke = report.browserSmokes.find(item => item.browser === browser);
    if (!smoke?.pairedThroughPopup || !smoke.snapshotExportedThroughPopup || !smoke.snapshotArrived || !smoke.revocationVisible) {
      blockers.push(`${browser} popup acceptance incomplete`);
    }
  }
  const privateCommands = report.privateLibrarySmoke.commands;
  if (!report.privateLibrarySmoke.ran || privateCommands.length < 4) {
    blockers.push('private-library smoke skipped');
  }
  for (const command of privateCommands) {
    if (command.status !== 'passed') blockers.push(`private-library command ${command.commandId} did not pass`);
    if (command.mode !== 'codex') blockers.push(`private-library command ${command.commandId} did not run in codex mode`);
    if (!command.retrievalRunId) blockers.push(`private-library command ${command.commandId} missing retrieval run id`);
    if (!command.promptRedactionOk) blockers.push(`private-library command ${command.commandId} prompt redaction not verified`);
  }
  if (report.validationCommands.some(command => !command.passed)) {
    blockers.push('validation command failed');
  }
  if (Object.values(report.safety).some(Boolean)) {
    blockers.push('private data or token committed');
  }
  if (!report.releaseArtifacts.appPackagePath || !report.releaseArtifacts.extensionPackagePath) {
    blockers.push('release archive missing');
  }
  return [...new Set(blockers)];
}
