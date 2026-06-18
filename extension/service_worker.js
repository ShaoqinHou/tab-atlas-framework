const RECEIVERS = ['http://127.0.0.1:9787', 'http://127.0.0.1:9786'];
const TOKEN_KEY = 'tabAtlasToken';
const PAIRING_REQUIRED_KEY = 'tabAtlasPairingRequired';
let timer = null;

chrome.runtime.onInstalled.addListener(() => scheduleExport());
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'tabatlas:pair') return false;
  pairWithReceiver(String(message.code || ''), String(message.receiver || RECEIVERS[0]))
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
  timer = setTimeout(exportIfReceiverAvailable, 1500);
}

async function exportIfReceiverAvailable() {
  for (const base of RECEIVERS) {
    try {
      const health = await fetch(`${base}/health`, { method: 'GET' });
      if (!health.ok) continue;
      const token = await getStoredToken();
      if (!token) {
        await markPairingRequired();
        continue;
      }
      const snapshot = await buildSnapshot();
      const response = await fetch(`${base}/snapshot`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tab-atlas-token': token,
        },
        body: JSON.stringify(snapshot),
      });
      if (response.status === 401 || response.status === 403) {
        await clearStoredToken();
        await markPairingRequired();
        continue;
      }
      if (!response.ok) continue;
      await markPaired();
      return;
    } catch {
      // receiver not running: remain passive
    }
  }
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
        url: t.url ?? t.pendingUrl ?? ''
      };
    }).filter(t => t.url.startsWith('http://') || t.url.startsWith('https://'))
  };
}

async function pairWithReceiver(code, receiver) {
  if (!code.trim()) return { ok: false, error: 'pairing code required' };
  const response = await fetch(`${receiver}/api/security/pairing-codes/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, label: `${inferBrowser()} extension` }),
  });
  if (!response.ok) return { ok: false, error: 'pairing failed' };
  const payload = await response.json();
  if (!payload.token) return { ok: false, error: 'pairing response missing token' };
  await chrome.storage.local.set({
    [TOKEN_KEY]: payload.token,
    [PAIRING_REQUIRED_KEY]: false,
  });
  await markPaired();
  scheduleExport();
  return { ok: true, capabilityId: payload.capability?.id };
}

async function getStoredToken() {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  return typeof stored[TOKEN_KEY] === 'string' ? stored[TOKEN_KEY] : '';
}

async function clearStoredToken() {
  await chrome.storage.local.remove(TOKEN_KEY);
}

async function markPairingRequired() {
  await chrome.storage.local.set({ [PAIRING_REQUIRED_KEY]: true });
  if (chrome.action) {
    await chrome.action.setBadgeText({ text: 'PAIR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#cf222e' });
  }
}

async function markPaired() {
  await chrome.storage.local.set({ [PAIRING_REQUIRED_KEY]: false });
  if (chrome.action) await chrome.action.setBadgeText({ text: '' });
}

function inferBrowser() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('chrome/')) return 'chrome';
  return 'unknown';
}
