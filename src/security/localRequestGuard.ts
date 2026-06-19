import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  countActiveAdminCapabilities,
  findCapabilityByToken,
  verifyCapabilityToken,
  type CapabilityRecord,
  type CapabilityScope,
} from './localCapability.js';
import { readSessionTokenFromCookie, verifyLocalSessionToken } from './localSession.js';

export interface LocalRequestGuardOptions {
  host: string;
  port: number;
}

type GuardScope = CapabilityScope | 'local_only' | 'bootstrap_admin' | null;

const deniedByRemote = new Map<string, { count: number; resetAt: number }>();

export function installLocalRequestGuard(
  app: FastifyInstance,
  db: Database.Database,
  options: LocalRequestGuardOptions,
): void {
  app.addHook('preHandler', async (request, reply) => {
    const decision = authorizeLocalRequest(db, request, options);
    if (decision.allowed) return;
    writeSecurityAuditEvent(db, {
      request,
      outcome: 'denied',
      reason: decision.reason,
      capabilityId: decision.capabilityId,
    });
    const remote = request.ip ?? 'unknown';
    if (recordDenied(remote) > 30) {
      return reply.code(429).send({ ok: false, error: 'unauthorized' });
    }
    return reply.code(decision.statusCode).send({ ok: false, error: 'unauthorized' });
  });
}

export function authorizeLocalRequest(
  db: Database.Database,
  request: Pick<FastifyRequest, 'method' | 'url' | 'headers' | 'ip'>,
  options: LocalRequestGuardOptions,
): { allowed: true; scope: GuardScope; capability?: CapabilityRecord } | { allowed: false; statusCode: number; reason: string; capabilityId?: string } {
  const routeScope = requiredScopeFor(request.method, request.url);
  if (!isTrustedHost(String(request.headers.host ?? ''), options)) {
    return { allowed: false, statusCode: 403, reason: 'untrusted_host' };
  }
  if (isCrossSiteFetch(request.headers)) {
    return { allowed: false, statusCode: 403, reason: 'cross_site_fetch' };
  }
  if (!isTrustedOrigin(request.headers.origin, options)) {
    return { allowed: false, statusCode: 403, reason: 'untrusted_origin' };
  }
  if (routeScope === null || routeScope === 'local_only') return { allowed: true, scope: routeScope };
  if (routeScope === 'bootstrap_admin' && countActiveAdminCapabilities(db) === 0) return { allowed: true, scope: routeScope };
  const token = readToken(request.headers);
  const requiredScope: CapabilityScope = routeScope === 'bootstrap_admin' ? 'admin' : routeScope;
  const verification = verifyCapabilityToken(db, token, requiredScope);
  if (!verification.ok) {
    const sessionToken = readSessionTokenFromCookie(request.headers.cookie);
    const sessionVerification = verifyLocalSessionToken(db, sessionToken, requiredScope);
    if (sessionVerification.ok) return { allowed: true, scope: routeScope };
    return { allowed: false, statusCode: 401, reason: verification.reason, capabilityId: findCapabilityByToken(db, token)?.id };
  }
  return { allowed: true, scope: routeScope, capability: verification.capability };
}

export function requiredScopeFor(method: string, rawUrl: string): GuardScope {
  const pathname = pathnameFor(rawUrl);
  const normalizedMethod = method.toUpperCase();
  if (pathname === '/' || pathname === '/health') return 'local_only';
  if (pathname === '/api/security/pairing-codes/exchange' && normalizedMethod === 'POST') return 'local_only';
  if (pathname === '/api/onboarding' && normalizedMethod === 'GET') return 'local_only';
  if (pathname === '/api/onboarding/bootstrap' && normalizedMethod === 'POST') return 'local_only';
  if (pathname === '/api/onboarding/recover-admin' && normalizedMethod === 'POST') return 'local_only';
  if (pathname === '/api/security/capabilities' && normalizedMethod === 'POST') return 'bootstrap_admin';
  if (pathname.startsWith('/api/security')) return 'admin';
  if (pathname === '/snapshot' && normalizedMethod === 'POST') return 'snapshot:write';
  if (!pathname.startsWith('/api/')) return 'api:read';
  if (normalizedMethod === 'GET') return 'api:read';
  if (pathname.startsWith('/api/jobs') || pathname.startsWith('/api/extract') || pathname.startsWith('/api/agent/scan')) return 'jobs:write';
  if (pathname.startsWith('/api/conversations') || pathname.startsWith('/api/agent-actions') || pathname.startsWith('/api/agent/command') || pathname.startsWith('/api/agent/refine')) {
    return 'agent:write';
  }
  return 'api:write';
}

export function isTrustedHost(hostHeader: string, options: LocalRequestGuardOptions): boolean {
  const host = hostHeader.toLowerCase().trim();
  const allowed = new Set([
    `${options.host}:${options.port}`.toLowerCase(),
    `127.0.0.1:${options.port}`,
    `localhost:${options.port}`,
    `[::1]:${options.port}`,
  ]);
  return allowed.has(host);
}

function isCrossSiteFetch(headers: FastifyRequest['headers']): boolean {
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase();
  return site === 'cross-site';
}

function isTrustedOrigin(origin: unknown, options: LocalRequestGuardOptions): boolean {
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  const value = String(origin);
  if (value.startsWith('chrome-extension://') || value.startsWith('moz-extension://')) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return false;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') return false;
    return Number(url.port || '80') === options.port;
  } catch {
    return false;
  }
}

function readToken(headers: FastifyRequest['headers']): string | undefined {
  const direct = headers['x-tab-atlas-token'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

export function writeSecurityAuditEvent(
  db: Database.Database,
  input: {
    request: Pick<FastifyRequest, 'method' | 'url' | 'headers' | 'ip'>;
    outcome: 'allowed' | 'denied';
    reason?: string;
    capabilityId?: string;
    details?: unknown;
  },
): void {
  db.prepare(`
    INSERT INTO security_audit_events
      (id, event_type, method, route, outcome, reason, capability_id, host, origin, remote_address, details_json, created_at)
    VALUES (?, 'request_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `audit_${nanoid()}`,
    input.request.method,
    pathnameFor(input.request.url),
    input.outcome,
    input.reason ?? null,
    input.capabilityId ?? null,
    String(input.request.headers.host ?? ''),
    typeof input.request.headers.origin === 'string' ? input.request.headers.origin : null,
    input.request.ip ?? null,
    input.details === undefined ? null : JSON.stringify(input.details),
    new Date().toISOString(),
  );
}

export function writeSecurityAuditRecord(
  db: Database.Database,
  input: {
    eventType: string;
    method?: string;
    route?: string;
    outcome: 'allowed' | 'denied';
    reason?: string;
    capabilityId?: string;
    host?: string;
    origin?: string;
    remoteAddress?: string;
    details?: unknown;
  },
): void {
  db.prepare(`
    INSERT INTO security_audit_events
      (id, event_type, method, route, outcome, reason, capability_id, host, origin, remote_address, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `audit_${nanoid()}`,
    input.eventType,
    input.method ?? null,
    input.route ?? null,
    input.outcome,
    input.reason ?? null,
    input.capabilityId ?? null,
    input.host ?? null,
    input.origin ?? null,
    input.remoteAddress ?? null,
    input.details === undefined ? null : JSON.stringify(input.details),
    new Date().toISOString(),
  );
}

function recordDenied(remote: string): number {
  const now = Date.now();
  const current = deniedByRemote.get(remote);
  if (!current || current.resetAt <= now) {
    deniedByRemote.set(remote, { count: 1, resetAt: now + 60_000 });
    return 1;
  }
  current.count += 1;
  return current.count;
}

function pathnameFor(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return rawUrl.split('?')[0] || '/';
  }
}

export function sendUnauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ ok: false, error: 'unauthorized' });
}
