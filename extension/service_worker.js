const RECEIVERS = ['http://127.0.0.1:9787', 'http://127.0.0.1:9786'];
let timer = null;

chrome.runtime.onInstalled.addListener(() => scheduleExport());
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
      const snapshot = await buildSnapshot();
      await fetch(`${base}/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
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

function inferBrowser() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('chrome/')) return 'chrome';
  return 'unknown';
}
