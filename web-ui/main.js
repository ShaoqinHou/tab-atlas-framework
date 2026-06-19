import { getJson } from './api.js';
import { initConversation } from './conversation.js';
import { initInspector } from './inspector.js';
import { initShell, refreshStatus, setViewOptions } from './shell.js';
import { setState, state, subscribe } from './state.js';
import { initViewWorkspace, refreshViewWorkspace } from './viewWorkspace.js';

let views = [];

async function refreshViews(preferredViewId = state.activeViewId) {
  try {
    views = await getJson('/api/views');
    setViewOptions(views);
    if (!preferredViewId && views[0]) {
      setState({ activeViewId: views[0].id });
    }
    if (state.activeViewId) await refreshViewWorkspace(state.activeViewId);
    renderAskStage();
  } catch {
    setViewOptions([]);
    renderAskStage();
  }
}

function renderAskStage() {
  const stage = document.getElementById('askWorkspace');
  if (!stage) return;
  const active = views.find(view => view.id === state.activeViewId);
  if (!active) {
    stage.className = 'stage stage-empty';
    stage.innerHTML = `
      <div class="empty-state">
        <p class="kicker">No active view</p>
        <h3>Ask for a view or open an existing one.</h3>
      </div>
    `;
    return;
  }
  stage.className = 'stage';
  stage.innerHTML = `
    <div class="workspace-summary">
      <p class="kicker">Active view</p>
      <h3>${escapeHtml(active.name || active.id)}</h3>
      <p class="muted">${escapeHtml(active.description || active.status || '')}</p>
      <button type="button" id="openActiveViewButton">Open workspace</button>
    </div>
  `;
  document.getElementById('openActiveViewButton')?.addEventListener('click', () => setState({ page: 'views' }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

initShell({
  onRefresh: async () => {
    await refreshStatus();
    await refreshViews();
  },
  onViewChange: async () => {
    await refreshViewWorkspace();
    renderAskStage();
  },
});

initInspector();
initViewWorkspace();
initConversation({ onRefreshViews: refreshViews });
subscribe(renderAskStage);
await refreshViews();
