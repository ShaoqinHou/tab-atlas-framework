const RECEIVERS = ['http://127.0.0.1:9787', 'http://127.0.0.1:9786'];
const TOKEN_KEY = 'tabAtlasToken';
const CAPABILITY_ID_KEY = 'tabAtlasCapabilityId';
const RECEIVER_KEY = 'tabAtlasReceiver';
const PAIRING_REQUIRED_KEY = 'tabAtlasPairingRequired';
const LAST_EXPORT_AT_KEY = 'tabAtlasLastExportAt';
const LAST_ERROR_KEY = 'tabAtlasLastError';
let timer = null;

chrome.runtime.onInstalled.addListener(() => scheduleExport());
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const run = async () => {
    switch (message.type) {
      case 'tabatlas:status':
        return extensionStatus(String(message.receiver || ''));
      case 'tabatlas:pair':
        return pairWithReceiver({
          challengeId: String(message.challengeId || ''),
          secret: String(message.secret || message.code || ''),
          receiver: String(message.receiver || RECEIVERS[0]),
        });
      case 'tabatlas:export-now':
        return exportNow(String(message.receiver || ''));
      case 'tabatlas:unpair':
        return unpair();
      default:
        return { ok: false, error: 'unsupported message' };
    }
  };
  run()
    .then(result => sendResponse(result))
    .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
chrome.tabs.onCreated.addListener(() => scheduleExport());
chrome.tabs.onUpdated.addListener(() => scheduleExport());
chrome.tabs.onRemoved.addListener(() => scheduleExport());
chrome.tabs.onMoved.addListener(() => scheduleExport());
if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(() => scheduleExport());
  chrome.tabGroups.onUpdated.addListener(() => scheduleExport());
  chrome.tabGroups.onRemoved.addListener(() => scheduleExport());
  chrome.tabGroups.onMoved.addListener(() => scheduleExport());
}

function scheduleExport() {
  clearTimeout(timer);
  timer = setTimeout(() => exportIfReceiverAvailable().catch(() => undefined), 1500);
}

async function extensionStatus(receiverOverride = '') {
  const stored = await chrome.storage.local.get([
    TOKEN_KEY,
    CAPABILITY_ID_KEY,
    RECEIVER_KEY,
    PAIRING_REQUIRED_KEY,
    LAST_EXPORT_AT_KEY,
    LAST_ERROR_KEY,
  ]);
  const receiver = receiverOverride || stored[RECEIVER_KEY] || RECEIVERS[0];
  const reachable = await isReceiverReachable(receiver);
  const token = typeof stored[TOKEN_KEY] === 'string' ? stored[TOKEN_KEY] : '';
  return {
    ok: true,
    receiver,
    receiverReachable: reachable,
    paired: Boolean(token),
    pairingRequired: Boolean(stored[PAIRING_REQUIRED_KEY]) || !token,
    browser: inferBrowser(),
    capabilityId: stored[CAPABILITY_ID_KEY] || '',
    lastExportAt: stored[LAST_EXPORT_AT_KEY] || '',
    lastError: stored[LAST_ERROR_KEY] || '',
  };
}

async function exportIfReceiverAvailable() {
  const stored = await chrome.storage.local.get([RECEIVER_KEY, TOKEN_KEY]);
  const preferred = stored[RECEIVER_KEY] || '';
  const receivers = preferred ? [preferred, ...RECEIVERS.filter(item => item !== preferred)] : RECEIVERS;
  for (const base of receivers) {
    try {
      if (!await isReceiverReachable(base)) continue;
      const token = await getStoredToken();
      if (!token) {
        await markPairingRequired('Pairing required');
        continue;
      }
      const result = await exportSnapshot(base, token);
      if (result.ok) return result;
    } catch {
      // Receiver not running: remain passive and try the next known receiver.
    }
  }
  return { ok: false, error: 'receiver unavailable' };
}

async function exportNow(receiverOverride = '') {
  const stored = await chrome.storage.local.get([RECEIVER_KEY, TOKEN_KEY]);
  const receiver = receiverOverride || stored[RECEIVER_KEY] || RECEIVERS[0];
  const token = typeof stored[TOKEN_KEY] === 'string' ? stored[TOKEN_KEY] : '';
  if (!token) {
    await markPairingRequired('Pairing required');
    return { ok: false, error: 'unpaired' };
  }
  return exportSnapshot(receiver, token);
}

async function exportSnapshot(receiver, token) {
  const snapshot = await buildSnapshot();
  const response = await fetch(`${receiver}/snapshot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tab-atlas-token': token,
    },
    body: JSON.stringify(snapshot),
  });
  if (response.status === 401 || response.status === 403) {
    await clearStoredToken();
    await markPairingRequired('Token revoked or unauthorized');
    return { ok: false, error: 'revoked_or_unauthorized' };
  }
  if (!response.ok) {
    await setLastError(`export failed: ${response.status}`);
    return { ok: false, error: `export failed: ${response.status}` };
  }
  const payload = await response.json().catch(() => ({}));
  const exportedAt = new Date().toISOString();
  await chrome.storage.local.set({
    [RECEIVER_KEY]: receiver,
    [LAST_EXPORT_AT_KEY]: exportedAt,
    [LAST_ERROR_KEY]: '',
    [PAIRING_REQUIRED_KEY]: false,
  });
  if (chrome.action) await chrome.action.setBadgeText({ text: '' });
  return { ok: true, exportedAt, tabCount: snapshot.tabs.length, result: payload };
}

async function buildSnapshot() {
  const capturedAt = new Date().toISOString();
  const tabs = await chrome.tabs.query({});
  const groups = chrome.tabGroups ? await chrome.tabGroups.query({}) : [];
  const groupById = new Map(groups.map(g => [g.id, g]));
  return {
    capturedAt,
    tabs: tabs.map(t => {
      const g = typeof t.groupId === 'number' ? groupById.get(t.groupId) : undefined;
      return {
        browser: inferBrowser(),
        capturedAt,
        windowId: t.windowId,
        tabId: t.id,
        index: t.index,
        active: t.active,
        pinned: t.pinned,
        audible: t.audible,
        muted: t.mutedInfo?.muted ?? false,
        discarded: t.discarded,
        autoDiscardable: t.autoDiscardable,
        incognito: t.incognito,
        groupId: t.groupId,
        groupTitle: g?.title ?? '',
        groupColor: g?.color ?? '',
        groupCollapsed: g?.collapsed ?? false,
        title: t.title ?? '',
        url: t.url ?? t.pendingUrl ?? '',
      };
    }).filter(t => t.url.startsWith('http://') || t.url.startsWith('https://')),
  };
}

async function pairWithReceiver({ challengeId, secret, receiver }) {
  if (!challengeId.trim() || !secret.trim()) {
    await setLastError('challenge id and secret required');
    return { ok: false, error: 'challenge id and secret required' };
  }
  const browser = inferBrowser();
  const response = await fetch(`${receiver}/api/security/pairing-codes/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId,
      secret,
      browser,
      label: `${browser} extension`,
    }),
  });
  if (!response.ok) {
    const error = await response.text().catch(() => 'pairing failed');
    await setLastError(error);
    return { ok: false, error };
  }
  const payload = await response.json();
  if (!payload.token) return { ok: false, error: 'pairing response missing token' };
  await chrome.storage.local.set({
    [TOKEN_KEY]: payload.token,
    [CAPABILITY_ID_KEY]: payload.capability?.id || '',
    [RECEIVER_KEY]: receiver,
    [PAIRING_REQUIRED_KEY]: false,
    [LAST_ERROR_KEY]: '',
  });
  if (chrome.action) await chrome.action.setBadgeText({ text: '' });
  const exportResult = await exportSnapshot(receiver, payload.token);
  return {
    ok: true,
    capabilityId: payload.capability?.id || '',
    exportedAt: exportResult.ok ? exportResult.exportedAt : '',
    exportError: exportResult.ok ? '' : exportResult.error,
  };
}

async function unpair() {
  await clearStoredToken();
  await chrome.storage.local.set({
    [PAIRING_REQUIRED_KEY]: true,
    [LAST_ERROR_KEY]: '',
  });
  if (chrome.action) {
    await chrome.action.setBadgeText({ text: 'PAIR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#cf222e' });
  }
  return { ok: true };
}

async function isReceiverReachable(receiver) {
  try {
    const health = await fetch(`${receiver}/health`, { method: 'GET' });
    return health.ok;
  } catch {
    return false;
  }
}

async function getStoredToken() {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  return typeof stored[TOKEN_KEY] === 'string' ? stored[TOKEN_KEY] : '';
}

async function clearStoredToken() {
  await chrome.storage.local.remove([TOKEN_KEY, CAPABILITY_ID_KEY]);
}

async function markPairingRequired(error) {
  await chrome.storage.local.set({
    [PAIRING_REQUIRED_KEY]: true,
    [LAST_ERROR_KEY]: error || '',
  });
  if (chrome.action) {
    await chrome.action.setBadgeText({ text: 'PAIR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#cf222e' });
  }
}

async function setLastError(error) {
  await chrome.storage.local.set({ [LAST_ERROR_KEY]: error || '' });
}

function inferBrowser() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('chrome/')) return 'chrome';
  return 'unknown';
}
