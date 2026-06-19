import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { runAgentCommand, type RunAgentCommandInput } from '../agent/commandService.js';
import {
  cancelAgentAction,
  confirmAgentAction,
  createConversationThread,
  getAgentAction,
  getConversationSnapshot,
  sendConversationMessage,
} from '../agent/conversationService.js';
import {
  countAtomicItems,
  countCodexScanArtifacts,
  createCodexScanJob,
  resumeCodexScanJob,
  runCodexResourceScan,
  type RunCodexResourceScanInput,
} from '../agent/scanService.js';
import { openDatabase } from '../db/index.js';
import { runDeterministicExtraction } from '../extract/deterministic.js';
import { createExtractionJob, ExtractionAdapterRegistry, resumeExtractionJob } from '../extract/runtime.js';
import { createGenericWebpageAdapter } from '../extract/webpage.js';
import { createYouTubeLayeredEvidenceAdapter, importManualYouTubeTranscript } from '../extract/youtube.js';
import { importSnapshot } from '../import/headlessSnapshot.js';
import { getJobSnapshot, listJobItems, listJobs, requestJobCancel, retryFailedJobItems } from '../jobs/service.js';
import { startInProcessJobWorker } from '../jobs/worker.js';
import { addUserAnnotationTool, explainMembership, getReviewNext, getResourceBriefs, searchResources, submitReviewDecision } from '../agent/tools.js';
import type { CodexSdkProviderConfig } from '../llm/CodexSdkProvider.js';
import { createCodexProviderRegistry, type CodexProviderRole } from '../llm/providerScope.js';
import { buildResourceBrief } from '../resources/briefs.js';
import { getTargetInspector, getViewSectionPage, getViewWorkspace } from '../presentation/workspaceService.js';
import {
  completeOnboardingStep,
  consumeBootstrapSecret,
  ensureBootstrapSecret,
  getOnboardingSnapshot,
  recoverAdminSession,
} from '../onboarding/service.js';
import { OnboardingStepId } from '../onboarding/contracts.js';
import {
  createCapability,
  countActiveAdminCapabilities,
  listCapabilities,
  revokeCapability,
  rotateCapability,
  type CapabilityKind,
  type CapabilityScope,
} from '../security/localCapability.js';
import { countActiveDashboardSessions, sessionCookie } from '../security/localSession.js';
import {
  createPairingChallenge,
  exchangePairingChallenge,
  listPairingChallenges,
  PairingChallengeError,
} from '../security/pairingChallenge.js';
import { importPathPolicyFromEnv, listCaptureRoots, listRecentCaptureFiles, validateImportPath } from '../security/importPathPolicy.js';
import { installLocalRequestGuard, writeSecurityAuditRecord } from '../security/localRequestGuard.js';
import { applyViewPlan, previewView } from '../views/service.js';
import {
  acceptViewRevision,
  compareViewRevisions,
  getLatestViewRevision,
  listViewRevisions,
  recordMembershipFeedback,
  rejectViewRevision,
} from '../views/feedbackService.js';
import {
  createReviewSession,
  getReviewSession,
  pauseReviewSession,
  resumeReviewSession,
  submitReviewSessionDecision,
} from '../review/sessionService.js';
import {
  confirmPopupOpened,
  createManualBrowserAcceptanceSession,
  getManualBrowserAcceptanceSession,
  ProductBrowser,
  refreshManualBrowserAcceptanceEvidence,
  revokeManualBrowserAcceptanceCapability,
  verifySnapshotDoesNotContainCapabilityMaterial,
  verifySnapshotDoesNotContainToken,
} from '../acceptance/manualBrowserSession.js';

const host = '127.0.0.1';
const port = Number(process.env.TABATLAS_PORT ?? 9787);
const db = openDatabase(process.env.TABATLAS_DB);
const app = Fastify({ logger: true });
installLocalRequestGuard(app, db, { host, port });
const importPolicy = importPathPolicyFromEnv();
const indexHtml = new URL('../../web-ui/index.html', import.meta.url);
const webUiRoot = path.resolve(process.cwd(), 'web-ui');
const bootstrapSecret = (countActiveAdminCapabilities(db) === 0 && countActiveDashboardSessions(db) === 0)
  ? ensureBootstrapSecret(db, {
    directory: process.env.TABATLAS_BOOTSTRAP_DIR ?? path.join(process.cwd(), 'data'),
  })
  : null;
if (bootstrapSecret) {
  app.log.info({ filePath: bootstrapSecret.filePath, expiresAt: bootstrapSecret.expiresAt }, 'TabAtlas bootstrap secret file ready');
}
const codexProviders = createCodexProviderRegistry(db, {
  maxTurnsPerThread: Number(process.env.TABATLAS_CODEX_MAX_TURNS_PER_THREAD ?? 20),
  workingDirectory: process.cwd(),
});
const extractionRegistry = new ExtractionAdapterRegistry();
registerExtractionAdapters(extractionRegistry);
const jobWorker = startInProcessJobWorker(db, {
  codex_scan: async (jobId, context) => {
    const job = getJobSnapshot(db, jobId);
    const input = asRecord(job.input);
    const reasoningEffort = readReasoningEffort(input.reasoningEffort);
    const provider = getCodexProvider({ role: 'resource_scan', reasoningEffort, scope: `job:${jobId}` });
    await resumeCodexScanJob(db, provider, jobId, {
      maxItems: Number(process.env.TABATLAS_WORKER_MAX_ITEMS_PER_TICK ?? 1),
      maxRetries: Number(process.env.TABATLAS_JOB_MAX_RETRIES ?? 3),
      signal: context.signal,
    });
  },
  metadata_fetch: async (jobId, context) => {
    await resumeExtractionJob(db, extractionRegistry, jobId, {
      maxItems: Number(process.env.TABATLAS_WORKER_MAX_ITEMS_PER_TICK ?? 1),
      maxRetries: Number(process.env.TABATLAS_JOB_MAX_RETRIES ?? 3),
      signal: context.signal,
    });
  },
}, {
  pollMs: Number(process.env.TABATLAS_WORKER_POLL_MS ?? 1500),
  concurrency: Number(process.env.TABATLAS_WORKER_CONCURRENCY ?? 1),
});

app.get('/health', async () => ({ ok: true, app: 'tabatlas', time: new Date().toISOString() }));

app.get('/', async (_request, reply) => {
  const html = await fs.readFile(indexHtml, 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

app.get('/web-ui/*', async (request, reply) => {
  const params = request.params as { '*': string };
  const requestedPath = params['*'] ?? '';
  const resolvedPath = path.resolve(webUiRoot, requestedPath);
  if (!resolvedPath.startsWith(`${webUiRoot}${path.sep}`)) {
    return reply.status(404).send({ ok: false, error: 'not found' });
  }
  try {
    const content = await fs.readFile(resolvedPath);
    return reply.type(contentTypeFor(resolvedPath)).send(content);
  } catch {
    return reply.status(404).send({ ok: false, error: 'not found' });
  }
});

app.post('/snapshot', async (request, reply) => {
  const result = importSnapshot(db, request.body, 'extension_snapshot');
  completeOnboardingStep(db, 'snapshot_captured', { source: 'extension_snapshot' });
  return reply.send(result);
});

app.post('/api/import-file', async (request, reply) => {
  const body = asRecord(request.body);
  const file = typeof body.file === 'string' ? body.file : '';
  if (!file) return reply.status(400).send({ ok: false, error: 'file is required' });
  let validated;
  try {
    validated = validateImportPath(file, importPolicy);
  } catch (error) {
    return reply.status(400).send({ ok: false, error: error instanceof Error ? error.message : 'invalid import path' });
  }
  const json = JSON.parse(await fs.readFile(validated.path, 'utf8'));
  const result = importSnapshot(db, json, 'manual_file_import');
  completeOnboardingStep(db, 'snapshot_captured', { source: 'manual_file_import' });
  return reply.send({ ok: true, ...result });
});

app.get('/api/onboarding', async () => {
  return {
    ...getOnboardingSnapshot(db),
    bootstrapFilePath: bootstrapSecret?.filePath,
  };
});

app.post('/api/onboarding/bootstrap', async (request, reply) => {
  const body = asRecord(request.body);
  const secret = typeof body.secret === 'string' ? body.secret : '';
  if (!secret.trim()) return reply.status(400).send({ ok: false, error: 'secret is required' });
  try {
    const session = consumeBootstrapSecret(db, secret);
    writeSecurityAuditRecord(db, {
      eventType: 'onboarding_bootstrap',
      method: request.method,
      route: request.url,
      outcome: 'allowed',
      details: { sessionId: session.sessionId },
    });
    return reply
      .header('set-cookie', sessionCookie(session.token))
      .send({ ok: true, session: { id: session.sessionId, expiresAt: session.expiresAt }, onboarding: getOnboardingSnapshot(db) });
  } catch (error) {
    writeSecurityAuditRecord(db, {
      eventType: 'onboarding_bootstrap',
      method: request.method,
      route: request.url,
      outcome: 'denied',
      reason: error instanceof Error ? error.message : String(error),
    });
    return reply.status(400).send({ ok: false, error: 'invalid bootstrap secret' });
  }
});

app.post('/api/onboarding/:stepId/complete', async (request, reply) => {
  const params = request.params as { stepId: string };
  const parsed = OnboardingStepId.safeParse(params.stepId);
  if (!parsed.success) return reply.status(400).send({ ok: false, error: 'invalid onboarding step' });
  completeOnboardingStep(db, parsed.data, asRecord(request.body));
  return reply.send({ ok: true, onboarding: getOnboardingSnapshot(db) });
});

app.post('/api/onboarding/recover-admin', async (request, reply) => {
  const body = asRecord(request.body);
  const secret = typeof body.secret === 'string' ? body.secret : '';
  if (!secret.trim()) return reply.status(400).send({ ok: false, error: 'secret is required' });
  try {
    const session = recoverAdminSession(db, secret);
    writeSecurityAuditRecord(db, {
      eventType: 'onboarding_recover_admin',
      method: request.method,
      route: request.url,
      outcome: 'allowed',
      details: { sessionId: session.sessionId },
    });
    return reply
      .header('set-cookie', sessionCookie(session.token))
      .send({ ok: true, session: { id: session.sessionId, expiresAt: session.expiresAt }, onboarding: getOnboardingSnapshot(db) });
  } catch (error) {
    writeSecurityAuditRecord(db, {
      eventType: 'onboarding_recover_admin',
      method: request.method,
      route: request.url,
      outcome: 'denied',
      reason: error instanceof Error ? error.message : String(error),
    });
    return reply.status(400).send({ ok: false, error: 'recovery unavailable' });
  }
});

app.get('/api/security/status', async () => {
  const denied = db.prepare(`
    SELECT COUNT(*) AS count
    FROM security_audit_events
    WHERE outcome = 'denied'
  `).get() as { count: number };
  return {
    bound: { host, port },
    capabilities: listCapabilities(db),
    pairingCodes: [],
    pairingChallenges: listPairingChallenges(db),
    captureRoots: listCaptureRoots(importPolicy),
    recentCaptureFiles: listRecentCaptureFiles(importPolicy, 10),
    deniedRequests: denied.count,
  };
});

app.post('/api/security/capabilities', async (request, reply) => {
  const body = asRecord(request.body);
  const created = createCapability(db, {
    kind: readCapabilityKind(body.kind),
    scopes: readCapabilityScopes(body.scopes),
    label: typeof body.label === 'string' ? body.label : undefined,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
  });
  writeSecurityAuditRecord(db, {
    eventType: 'capability_create',
    method: request.method,
    route: request.url,
    outcome: 'allowed',
    capabilityId: created.capability.id,
    details: { kind: created.capability.kind, scopes: created.capability.scopes },
  });
  return reply.code(201).send(created);
});

app.post('/api/security/capabilities/:id/revoke', async (request, reply) => {
  const params = request.params as { id: string };
  const capability = revokeCapability(db, params.id);
  writeSecurityAuditRecord(db, {
    eventType: 'capability_revoke',
    method: request.method,
    route: request.url,
    outcome: 'allowed',
    capabilityId: capability.id,
    details: { kind: capability.kind },
  });
  return reply.send({ capability });
});

app.post('/api/security/capabilities/:id/rotate', async (request, reply) => {
  const params = request.params as { id: string };
  const rotated = rotateCapability(db, params.id);
  writeSecurityAuditRecord(db, {
    eventType: 'capability_rotate',
    method: request.method,
    route: request.url,
    outcome: 'allowed',
    capabilityId: rotated.capability.id,
    details: { kind: rotated.capability.kind },
  });
  return reply.send(rotated);
});

app.post('/api/security/pairing-codes', async (request, reply) => {
  const body = asRecord(request.body);
  const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : undefined;
  const browser = typeof body.browser === 'string' ? body.browser : 'unknown';
  const created = createPairingChallenge(db, {
    kind: 'extension',
    scopes: ['snapshot:write'],
    ttlMs,
    browser,
    label: typeof body.label === 'string' ? body.label : undefined,
    maxAttempts: typeof body.maxAttempts === 'number' ? body.maxAttempts : undefined,
  });
  writeSecurityAuditRecord(db, {
    eventType: 'pairing_challenge_create',
    method: request.method,
    route: request.url,
    outcome: 'allowed',
    details: { challengeId: created.challenge.id, browser: created.challenge.browser, expiresAt: created.challenge.expiresAt },
  });
  return reply.code(201).send(created);
});

app.post('/api/security/pairing-codes/exchange', async (request, reply) => {
  const body = asRecord(request.body);
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const secret = typeof body.secret === 'string' ? body.secret : typeof body.code === 'string' ? body.code : '';
  if (!challengeId.trim() || !secret.trim()) return reply.status(400).send({ ok: false, error: 'challengeId and secret are required' });
  try {
    const exchanged = exchangePairingChallenge(db, {
      challengeId,
      secret,
      label: typeof body.label === 'string' ? body.label : 'Browser extension',
      browser: typeof body.browser === 'string' ? body.browser : 'unknown',
      throttleKey: request.ip ?? 'local',
    });
    writeSecurityAuditRecord(db, {
      eventType: 'pairing_exchange',
      method: request.method,
      route: request.url,
      outcome: 'allowed',
      capabilityId: exchanged.capability.id,
      remoteAddress: request.ip,
      details: { challengeId, browser: exchanged.challenge.browser },
    });
    return reply.send(exchanged);
  } catch (error) {
    const reason = error instanceof PairingChallengeError ? error.reason : 'invalid_challenge';
    writeSecurityAuditRecord(db, {
      eventType: 'pairing_exchange',
      method: request.method,
      route: request.url,
      outcome: 'denied',
      reason,
      remoteAddress: request.ip,
      details: { challengeId },
    });
    return reply.status(reason === 'global_rate_limited' ? 429 : 400).send({ ok: false, error: reason });
  }
});

app.post('/api/acceptance/browser-sessions', async (request, reply) => {
  const body = asRecord(request.body);
  const parsed = ProductBrowser.safeParse(body.browser);
  if (!parsed.success) return reply.status(400).send({ ok: false, error: 'browser must be chrome or edge' });
  const receiverUrl = typeof body.receiverUrl === 'string' && body.receiverUrl.trim()
    ? body.receiverUrl.trim()
    : `http://${host}:${port}`;
  const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : undefined;
  const created = createManualBrowserAcceptanceSession(db, {
    browser: parsed.data,
    receiverUrl,
    ttlMs,
  });
  writeSecurityAuditRecord(db, {
    eventType: 'manual_browser_acceptance_create',
    method: request.method,
    route: request.url,
    outcome: 'allowed',
    details: { sessionId: created.session.id, browser: created.session.browser, challengeId: created.session.challengeId },
  });
  return reply.code(201).send({
    session: created.session,
    challengeSecret: created.challengeSecret,
  });
});

app.get('/api/acceptance/browser-sessions/:id', async (request) => {
  const params = request.params as { id: string };
  return { session: getManualBrowserAcceptanceSession(db, params.id) };
});

app.post('/api/acceptance/browser-sessions/:id/confirm-popup', async (request) => {
  const params = request.params as { id: string };
  return { session: confirmPopupOpened(db, params.id, true) };
});

app.post('/api/acceptance/browser-sessions/:id/refresh', async (request) => {
  const params = request.params as { id: string };
  return { session: refreshManualBrowserAcceptanceEvidence(db, params.id) };
});

app.post('/api/acceptance/browser-sessions/:id/revoke', async (request) => {
  const params = request.params as { id: string };
  const session = revokeManualBrowserAcceptanceCapability(db, params.id);
  writeSecurityAuditRecord(db, {
    eventType: 'manual_browser_acceptance_revoke',
    method: request.method,
    route: request.url,
    outcome: 'allowed',
    capabilityId: session.capabilityId,
    details: { sessionId: session.id, browser: session.browser },
  });
  return { session };
});

app.post('/api/acceptance/browser-sessions/:id/verify-token-absence', async (request) => {
  const params = request.params as { id: string };
  const body = asRecord(request.body);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const session = token
    ? verifySnapshotDoesNotContainToken(db, params.id, token)
    : verifySnapshotDoesNotContainCapabilityMaterial(db, params.id);
  return { session };
});

app.post('/api/extract/run', async (request, reply) => {
  const body = asRecord(request.body);
  const resourceIds = Array.isArray(body.resourceIds)
    ? body.resourceIds.filter((item): item is string => typeof item === 'string')
    : undefined;
  return reply.send(runDeterministicExtraction(db, resourceIds));
});

app.post('/api/jobs/extraction', async (request, reply) => {
  const body = asRecord(request.body);
  const result = createExtractionJob(db, {
    resourceIds: Array.isArray(body.resourceIds) ? body.resourceIds.filter((item): item is string => typeof item === 'string') : undefined,
    recipeIds: Array.isArray(body.recipeIds) ? body.recipeIds.filter((item): item is string => typeof item === 'string') : undefined,
    force: Boolean(body.force),
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : undefined,
  });
  return reply.code(202).send(result);
});

app.post('/api/resources/:resourceId/youtube/manual-transcript', async (request, reply) => {
  const params = request.params as { resourceId: string };
  const body = asRecord(request.body);
  const plainText = typeof body.plainText === 'string' ? body.plainText : '';
  if (!plainText.trim()) return reply.status(400).send({ ok: false, error: 'plainText is required' });
  const result = importManualYouTubeTranscript(db, {
    resourceId: params.resourceId,
    plainText,
    language: typeof body.language === 'string' ? body.language : undefined,
    isAutoGenerated: Boolean(body.isAutoGenerated),
  });
  return reply.send({ ok: true, ...result });
});

app.get('/api/status', async () => {
  const snapshots = db.prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number };
  const resources = db.prepare('SELECT COUNT(*) AS c FROM resources').get() as { c: number };
  const observations = db.prepare('SELECT COUNT(*) AS c FROM tab_observations').get() as { c: number };
  const unmarked = db.prepare(`
    SELECT COUNT(*) AS c
    FROM review_queue_items
    WHERE queue_name = 'unmarked' AND status IN ('pending', 'skipped')
  `).get() as { c: number };
  const youtube = db.prepare("SELECT COUNT(*) AS c FROM resources WHERE url_kind LIKE 'youtube_%'").get() as { c: number };
  const proposedViews = db.prepare("SELECT COUNT(*) AS c FROM views WHERE status = 'proposed'").get() as { c: number };
  const acceptedViews = db.prepare("SELECT COUNT(*) AS c FROM views WHERE status = 'accepted'").get() as { c: number };
  const agentRuns = db.prepare('SELECT COUNT(*) AS c FROM agent_runs').get() as { c: number };
  const annotated = db.prepare(`
    SELECT COUNT(DISTINCT target_id) AS c
    FROM user_annotations
    WHERE target_kind = 'resource'
  `).get() as { c: number };
  return {
    snapshots: snapshots.c,
    resources: resources.c,
    observations: observations.c,
    unmarked: unmarked.c,
    youtube: youtube.c,
    annotated: annotated.c,
    proposedViews: proposedViews.c,
    acceptedViews: acceptedViews.c,
    agentRuns: agentRuns.c,
    codexScanArtifacts: countCodexScanArtifacts(db),
    atomicItems: countAtomicItems(db),
  };
});

app.get('/api/resources', async () => {
  return db.prepare('SELECT id, canonical_url, url_kind, host, title_best, first_seen_at, last_seen_at FROM resources ORDER BY last_seen_at DESC LIMIT 500').all();
});

app.post('/api/agent/tools/searchResources', async (request, reply) => {
  return reply.send(searchResources(db, request.body));
});

app.post('/api/agent/tools/getResourceBriefs', async (request, reply) => {
  return reply.send(getResourceBriefs(db, request.body));
});

app.post('/api/agent/command', async (request, reply) => {
  const body = asRecord(request.body);
  const mode = body.mode === 'heuristic' ? 'heuristic' : 'codex';
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = mode === 'codex'
    ? getCodexProvider({ role: 'semantic_planner', reasoningEffort, scope: `agent-command:${crypto.randomUUID()}`, reuseThread: false })
    : 'heuristic';
  const input: RunAgentCommandInput = {
    text: typeof body.text === 'string' ? body.text : '',
    mode,
    candidateLimit: typeof body.candidateLimit === 'number' ? body.candidateLimit : undefined,
    dryRun: Boolean(body.dryRun),
    reasoningEffort,
  };
  const result = await runAgentCommand(db, provider, input);
  return reply.send(result);
});

app.post('/api/conversations', async (request, reply) => {
  const body = asRecord(request.body);
  const thread = createConversationThread(db, typeof body.title === 'string' ? body.title : undefined);
  return reply.code(201).send(getConversationSnapshot(db, thread.id));
});

app.get('/api/conversations/:threadId', async (request, reply) => {
  const params = request.params as { threadId: string };
  return reply.send(getConversationSnapshot(db, params.threadId));
});

app.post('/api/conversations/:threadId/messages', async (request, reply) => {
  const params = request.params as { threadId: string };
  const body = asRecord(request.body);
  const content = typeof body.content === 'string' ? body.content : '';
  if (!content.trim()) return reply.status(400).send({ ok: false, error: 'content is required' });
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = getCodexProvider({ role: 'conversation_planner', reasoningEffort, scope: `conversation:${params.threadId}` });
  const snapshot = await sendConversationMessage(db, {
    threadId: params.threadId,
    content,
  }, {
    plannerProvider: provider,
  });
  return reply.send(snapshot);
});

app.post('/api/agent-actions/:actionId/confirm', async (request, reply) => {
  const params = request.params as { actionId: string };
  const body = asRecord(request.body);
  const action = getAgentAction(db, params.actionId);
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = getCodexProvider({ role: 'semantic_planner', reasoningEffort, scope: `conversation-action:${action.threadId}` });
  return reply.send(await confirmAgentAction(db, params.actionId, { plannerProvider: provider }));
});

app.post('/api/agent-actions/:actionId/cancel', async (request, reply) => {
  const params = request.params as { actionId: string };
  return reply.send(cancelAgentAction(db, params.actionId));
});

app.post('/api/agent/refine', async (request, reply) => {
  const body = asRecord(request.body);
  const viewId = typeof body.viewId === 'string' ? body.viewId : '';
  const refinement = typeof body.text === 'string' ? body.text : '';
  if (!viewId || !refinement) return reply.status(400).send({ ok: false, error: 'viewId and text are required' });
  const mode = body.mode === 'heuristic' ? 'heuristic' : 'codex';
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = mode === 'codex'
    ? getCodexProvider({ role: 'semantic_planner', reasoningEffort, scope: `agent-refine:${viewId}:${crypto.randomUUID()}`, reuseThread: false })
    : 'heuristic';
  const preview = previewView(db, viewId);
  const parentRevision = getLatestViewRevision(db, viewId);
  const seedResourceIds = db.prepare(`
    SELECT DISTINCT target_id AS id
    FROM memberships
    WHERE view_id = ? AND target_kind = 'resource'
  `).all(viewId).map((row: unknown) => (row as { id: string }).id);
  const input: RunAgentCommandInput = {
    text: [
      `Refine existing view "${preview.name}".`,
      preview.goal ? `Existing goal: ${preview.goal}` : '',
      `User refinement: ${refinement}`,
    ].filter(Boolean).join(' '),
    mode,
    candidateLimit: typeof body.candidateLimit === 'number' ? body.candidateLimit : undefined,
    reasoningEffort,
    seedResourceIds,
    parentRevisionId: parentRevision?.id,
  };
  const result = await runAgentCommand(db, provider, input);
  return reply.send(result);
});

app.post('/api/agent/scan', async (request, reply) => {
  const body = asRecord(request.body);
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const provider = getCodexProvider({ role: 'resource_scan', reasoningEffort, scope: `scan:${crypto.randomUUID()}`, reuseThread: false });
  const input = readCodexScanInput(body, reasoningEffort);
  const result = await runCodexResourceScan(db, provider, input);
  return reply.send(result);
});

app.get('/api/jobs', async () => {
  return listJobs(db, { limit: 25 });
});

app.post('/api/jobs/codex-scan', async (request, reply) => {
  const body = asRecord(request.body);
  const reasoningEffort = readReasoningEffort(body.reasoningEffort);
  const result = createCodexScanJob(db, readCodexScanInput(body, reasoningEffort));
  return reply.code(202).send(result);
});

app.get('/api/jobs/:jobId', async (request, reply) => {
  const params = request.params as { jobId: string };
  return reply.send({
    job: getJobSnapshot(db, params.jobId),
    items: listJobItems(db, params.jobId),
  });
});

app.post('/api/jobs/:jobId/cancel', async (request, reply) => {
  const params = request.params as { jobId: string };
  return reply.send(requestJobCancel(db, params.jobId));
});

app.post('/api/jobs/:jobId/resume', async (request, reply) => {
  const params = request.params as { jobId: string };
  const body = asRecord(request.body);
  const job = getJobSnapshot(db, params.jobId);
  if (job.kind === 'metadata_fetch') {
    const result = await resumeExtractionJob(db, extractionRegistry, params.jobId, {
      maxItems: typeof body.maxItems === 'number' ? body.maxItems : undefined,
      maxRetries: typeof body.maxRetries === 'number' ? body.maxRetries : undefined,
    });
    return reply.send(result);
  }
  if (job.kind !== 'codex_scan') return reply.status(400).send({ ok: false, error: `Unsupported job kind: ${job.kind}` });
  const input = asRecord(job.input);
  const reasoningEffort = readReasoningEffort(input.reasoningEffort);
  const provider = getCodexProvider({ role: 'resource_scan', reasoningEffort, scope: `job:${params.jobId}` });
  const result = await resumeCodexScanJob(db, provider, params.jobId, {
    maxItems: typeof body.maxItems === 'number' ? body.maxItems : undefined,
    maxRetries: typeof body.maxRetries === 'number' ? body.maxRetries : undefined,
  });
  return reply.send(result);
});

app.post('/api/jobs/:jobId/retry-failed', async (request, reply) => {
  const params = request.params as { jobId: string };
  const body = asRecord(request.body);
  const retried = retryFailedJobItems(db, params.jobId, {
    itemIds: Array.isArray(body.itemIds) ? body.itemIds.filter((item): item is string => typeof item === 'string') : undefined,
    maxAttempts: typeof body.maxAttempts === 'number' ? body.maxAttempts : undefined,
  });
  return reply.send(retried);
});

app.get('/api/commands', async () => {
  return db.prepare(`
    SELECT
      c.id,
      c.text,
      c.status,
      c.created_at,
      COALESCE((
        SELECT json_group_array(s.view_id)
        FROM semantic_view_specs s
        WHERE s.command_id = c.id
      ), '[]') AS view_ids_json
    FROM user_commands c
    ORDER BY c.created_at DESC
    LIMIT 25
  `).all().map((row: unknown) => {
    const command = row as { view_ids_json: string };
    return { ...command, viewIds: parseJsonArray(command.view_ids_json) };
  });
});

app.post('/api/annotations', async (request, reply) => {
  return reply.send(addUserAnnotationTool(db, request.body));
});

app.get('/api/review/next', async (request, reply) => {
  const query = request.query as { queue?: string; preload?: string };
  return reply.send(getReviewNext(db, {
    queue: query.queue ?? 'unmarked',
    preload: query.preload ? Number(query.preload) : 2,
  }));
});

app.post('/api/review/:resourceId/skip', async (request, reply) => {
  const params = request.params as { resourceId: string };
  return reply.send(submitReviewDecision(db, {
    resourceId: params.resourceId,
    action: 'skip',
    tags: [],
    decision: 'none',
  }));
});

app.post('/api/review/:resourceId/complete', async (request, reply) => {
  const params = request.params as { resourceId: string };
  const body = typeof request.body === 'object' && request.body !== null ? request.body : {};
  return reply.send(submitReviewDecision(db, {
    resourceId: params.resourceId,
    action: 'save_and_next',
    ...body,
  }));
});

app.post('/api/review/:resourceId/ignore', async (request, reply) => {
  const params = request.params as { resourceId: string };
  return reply.send(submitReviewDecision(db, {
    resourceId: params.resourceId,
    action: 'mark_ignore',
    tags: ['ignore'],
    decision: 'ignore',
  }));
});

app.post('/api/review-sessions', async (request, reply) => {
  const session = createReviewSession(db, asRecord(request.body));
  return reply.code(201).send(session);
});

app.get('/api/review-sessions/:id', async (request, reply) => {
  const params = request.params as { id: string };
  return reply.send(getReviewSession(db, params.id));
});

app.post('/api/review-sessions/:id/decisions', async (request, reply) => {
  const params = request.params as { id: string };
  const snapshot = submitReviewSessionDecision(db, params.id, asRecord(request.body));
  completeOnboardingStep(db, 'first_review_completed', { sessionId: params.id });
  return reply.send(snapshot);
});

app.post('/api/review-sessions/:id/pause', async (request, reply) => {
  const params = request.params as { id: string };
  return reply.send(pauseReviewSession(db, params.id));
});

app.post('/api/review-sessions/:id/resume', async (request, reply) => {
  const params = request.params as { id: string };
  return reply.send(resumeReviewSession(db, params.id));
});

app.get('/api/resources/:id/preview', async (request, reply) => {
  const params = request.params as { id: string };
  return reply.send(buildResourceBrief(db, params.id));
});

app.get('/api/resources/:id/explain', async (request, reply) => {
  const params = request.params as { id: string };
  const query = request.query as { viewId?: string };
  return reply.send(explainMembership(db, {
    resourceId: params.id,
    viewId: query.viewId ?? '',
  }));
});

app.get('/api/views', async () => {
  return db.prepare(`
    SELECT id, name, description, origin, status, created_at
    FROM views
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
});

app.get('/api/views/:viewId/preview', async (request, reply) => {
  const params = request.params as { viewId: string };
  return reply.send(previewView(db, params.viewId));
});

app.get('/api/views/:viewId/workspace', async (request, reply) => {
  const params = request.params as { viewId: string };
  const query = request.query as { limit?: string };
  return reply.send(getViewWorkspace(db, params.viewId, {
    maxCardsPerSection: query.limit ? Number(query.limit) : undefined,
  }));
});

app.get('/api/views/:viewId/sections/:sectionId', async (request, reply) => {
  const params = request.params as { viewId: string; sectionId: string };
  const query = request.query as { cursor?: string; limit?: string };
  return reply.send(getViewSectionPage(db, params.viewId, params.sectionId, {
    cursor: query.cursor ? Number(query.cursor) : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
  }));
});

app.get('/api/targets/:targetKind/:targetId/inspector', async (request, reply) => {
  const params = request.params as { targetKind: string; targetId: string };
  const query = request.query as { viewId?: string };
  return reply.send(getTargetInspector(db, {
    targetKind: params.targetKind,
    targetId: params.targetId,
    viewId: query.viewId,
  }));
});

app.get('/api/resources/:id/inspector', async (request, reply) => {
  const params = request.params as { id: string };
  const query = request.query as { viewId?: string };
  return reply.send(getTargetInspector(db, {
    targetKind: 'resource',
    targetId: params.id,
    viewId: query.viewId,
  }));
});

app.get('/api/views/:viewId/revisions', async (request, reply) => {
  const params = request.params as { viewId: string };
  return reply.send(listViewRevisions(db, params.viewId));
});

app.post('/api/views/:viewId/revisions/:revisionId/accept', async (request, reply) => {
  const params = request.params as { revisionId: string };
  return reply.send(acceptViewRevision(db, params.revisionId));
});

app.post('/api/views/:viewId/revisions/:revisionId/reject', async (request, reply) => {
  const params = request.params as { revisionId: string };
  return reply.send(rejectViewRevision(db, params.revisionId));
});

app.get('/api/views/:viewId/revisions/:revisionId/compare', async (request, reply) => {
  const params = request.params as { revisionId: string };
  const query = request.query as { otherRevisionId?: string };
  if (!query.otherRevisionId) return reply.status(400).send({ ok: false, error: 'otherRevisionId is required' });
  return reply.send(compareViewRevisions(db, params.revisionId, query.otherRevisionId));
});

app.post('/api/views/:viewId/apply', async (request, reply) => {
  const params = request.params as { viewId: string };
  const body = asRecord(request.body);
  const mode = body.mode === 'accepted' ? 'accepted' : 'proposed';
  return reply.send(applyViewPlan(db, params.viewId, mode));
});

app.post('/api/membership-feedback', async (request, reply) => {
  return reply.send(recordMembershipFeedback(db, asRecord(request.body) as Parameters<typeof recordMembershipFeedback>[1]));
});

app.listen({ host, port }).catch(err => {
  app.log.error(err);
  process.exit(1);
});

process.once('SIGINT', () => jobWorker.stop());
process.once('SIGTERM', () => jobWorker.stop());

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml; charset=utf-8';
  return 'application/octet-stream';
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function readCodexScanInput(
  body: Record<string, unknown>,
  reasoningEffort: CodexSdkProviderConfig['reasoningEffort'],
): RunCodexResourceScanInput {
  return {
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    batchSize: typeof body.batchSize === 'number' ? body.batchSize : undefined,
    maxBatchBytes: typeof body.maxBatchBytes === 'number' ? body.maxBatchBytes : undefined,
    resourceIds: Array.isArray(body.resourceIds) ? body.resourceIds.filter((item): item is string => typeof item === 'string') : undefined,
    reasoningEffort,
    force: Boolean(body.force),
  };
}

function getCodexProvider(
  config: Pick<CodexSdkProviderConfig, 'reasoningEffort' | 'reuseThread'> & { role: CodexProviderRole; scope: string },
) {
  return codexProviders.getProvider({
    role: config.role,
    scopeKey: config.scope,
    reasoningEffort: config.reasoningEffort ?? 'medium',
    reuseThread: config.reuseThread,
  });
}

function readReasoningEffort(value: unknown): CodexSdkProviderConfig['reasoningEffort'] {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' ? value : 'medium';
}

function readCapabilityKind(value: unknown): CapabilityKind {
  if (value === 'extension' || value === 'automation') return value;
  return 'ui';
}

function readCapabilityScopes(value: unknown): CapabilityScope[] {
  const allowed = new Set<CapabilityScope>(['snapshot:write', 'api:read', 'api:write', 'jobs:write', 'agent:write', 'admin']);
  if (!Array.isArray(value)) return ['api:read'];
  const scopes = value.filter((item): item is CapabilityScope => typeof item === 'string' && allowed.has(item as CapabilityScope));
  return scopes.length ? [...new Set(scopes)] : ['api:read'];
}

function registerExtractionAdapters(registry: ExtractionAdapterRegistry): void {
  registry.register(createGenericWebpageAdapter());
  registry.register(createYouTubeLayeredEvidenceAdapter({
    officialDataApi: {
      enabled: process.env.TABATLAS_YOUTUBE_DATA_API_ENABLED === '1',
      apiKeyEnvironmentVariable: process.env.TABATLAS_YOUTUBE_API_KEY_ENV ?? 'YOUTUBE_API_KEY',
    },
    localYtDlp: {
      enabled: process.env.TABATLAS_YTDLP_ENABLED === '1',
      executable: process.env.TABATLAS_YTDLP_EXECUTABLE ?? 'yt-dlp',
      allowAutomaticCaptions: process.env.TABATLAS_YTDLP_AUTO_CAPTIONS === '1',
      preferredLanguages: (process.env.TABATLAS_YTDLP_LANGS ?? 'en.*').split(',').map(item => item.trim()).filter(Boolean),
    },
  }));
}
