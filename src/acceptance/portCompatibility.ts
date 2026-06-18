import fs from 'node:fs';
import path from 'node:path';
import type { RuntimePortCompatibility } from './contracts.js';

export interface PortCompatibilityDetails extends RuntimePortCompatibility {
  receivers: string[];
  hostPermissions: string[];
  popupDefaultReceiver: string;
  serverDefaultPort: number;
  issues: string[];
}

export function checkPortCompatibility(
  repoRoot: string,
  serverUrl = process.env.TABATLAS_SERVER_URL ?? 'http://127.0.0.1:9787',
): PortCompatibilityDetails {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension', 'manifest.json'), 'utf8')) as {
    host_permissions?: string[];
  };
  const worker = fs.readFileSync(path.join(repoRoot, 'extension', 'service_worker.js'), 'utf8');
  const popup = fs.readFileSync(path.join(repoRoot, 'extension', 'popup.html'), 'utf8');
  const server = fs.readFileSync(path.join(repoRoot, 'src', 'server', 'index.ts'), 'utf8');
  const receivers = parseReceiverList(worker);
  const hostPermissions = manifest.host_permissions ?? [];
  const popupDefaultReceiver = parsePopupDefaultReceiver(popup);
  const serverDefaultPort = parseServerDefaultPort(server);
  const receiverListIncludesServer = receivers.includes(serverUrl);
  const manifestCoversServer = hostPermissions.some(permission => permission === `${serverUrl}/*`);
  const popupDefaultMatchesServer = popupDefaultReceiver === serverUrl;
  const issues: string[] = [];
  if (!receiverListIncludesServer) issues.push(`service worker RECEIVERS does not include ${serverUrl}`);
  if (!manifestCoversServer) issues.push(`manifest host_permissions does not cover ${serverUrl}`);
  if (!popupDefaultMatchesServer) issues.push(`popup default receiver is ${popupDefaultReceiver || '(none)'}, expected ${serverUrl}`);
  const serverPort = new URL(serverUrl).port;
  if (serverPort && Number(serverPort) !== serverDefaultPort) {
    issues.push(`server default port is ${serverDefaultPort}, acceptance URL uses ${serverPort}`);
  }
  return {
    serverUrl,
    receivers,
    hostPermissions,
    popupDefaultReceiver,
    serverDefaultPort,
    receiverListIncludesServer,
    manifestCoversServer,
    popupDefaultMatchesServer,
    issues,
  };
}

function parseReceiverList(worker: string): string[] {
  const match = worker.match(/const\s+RECEIVERS\s*=\s*\[([^\]]+)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]);
}

function parsePopupDefaultReceiver(popup: string): string {
  const match = popup.match(/<input[^>]+id=["']receiver["'][^>]+value=["']([^"']+)["']/i);
  return match?.[1] ?? '';
}

function parseServerDefaultPort(server: string): number {
  const match = server.match(/TABATLAS_PORT\s*\?\?\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}
