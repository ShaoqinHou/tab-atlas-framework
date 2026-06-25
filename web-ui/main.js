import { getJson } from './api.js';
import { initConversation } from './conversation.js';
import { initInspector, openInspector } from './inspector.js';
import { initOperations } from './operations.js';
import { initReviewWorkspace } from './review.js';
import { initShell, refreshStatus, setViewOptions } from './shell.js';
import { setState, state, subscribe } from './state.js';
import { initViewWorkspace, refreshViewWorkspace } from './viewWorkspace.js';

let views = [];
let onboarding = null;

async function refreshViews(preferredViewId = state.activeViewId) {
  try {
    await refreshOnboarding();
    views = await getJson('/api/views');
    setViewOptions(views);
    if (!preferredViewId && views[0]) {
      setState({ activeViewId: views[0].id });
    }
    if (state.activeViewId) await refreshViewWorkspace(state.activeViewId);
    await restoreInspectorSelection();
    renderAskStage();
  } catch {
    setViewOptions([]);
    renderAskStage();
  }
}

async function refreshOnboarding() {
  try {
    onboarding = await getJson('/api/onboarding');
  } catch {
    onboarding = null;
  }
}

async function restoreInspectorSelection() {
  if (!state.selectedTargetKind || !state.selectedTargetId || !state.activeViewId) return;
  try {
    await openInspector(state.selectedTargetKind, state.selectedTargetId, {
      viewId: state.activeViewId,
      tab: state.inspectorTab || 'overview',
    });
  } catch {
    setState({ selectedTargetKind: '', selectedTargetId: '' });
  }
}

function renderAskStage() {
  const stage = document.getElementById('askWorkspace');
  if (!stage) return;
  const active = views.find(view => view.id === state.activeViewId);
  const setup = renderSetupPrompt();
  if (!active) {
    stage.className = 'stage stage-empty';
    stage.innerHTML = `
      ${setup}
      <div class="empty-state">
        <p class="kicker">No active view</p>
        <h3>Ask for a view or open an existing one.</h3>
      </div>
    `;
    return;
  }
  stage.className = 'stage';
  stage.innerHTML = `
    ${setup}
    <div class="workspace-summary">
      <p class="kicker">Active view</p>
      <h3>${escapeHtml(active.name || active.id)}</h3>
      <p class="muted">${escapeHtml(active.description || active.status || '')}</p>
      <button type="button" id="openActiveViewButton">Open workspace</button>
    </div>
  `;
  document.getElementById('continueSetupButton')?.addEventListener('click', openSetupPanel);
  document.getElementById('openActiveViewButton')?.addEventListener('click', () => setState({ page: 'views' }));
}

function renderSetupPrompt() {
  const next = onboarding?.nextStepId;
  if (!next) return '';
  return `
    <div class="setup-prompt" role="status">
      <div>
        <p class="kicker">Setup incomplete</p>
        <strong>Next: ${escapeHtml(nextStepLabel(next))}</strong>
      </div>
      <button type="button" id="continueSetupButton">Continue setup</button>
    </div>
  `;
}

function openSetupPanel() {
  const panel = setupPanelFor(onboarding?.nextStepId);
  setState({ page: 'settings', settingsPanel: panel });
}

function setupPanelFor(stepId) {
  if (stepId === 'dashboard_session_ready') return 'security';
  if (stepId === 'browsers_paired' || stepId === 'snapshot_captured') return 'capture';
  if (stepId === 'extraction_ready' || stepId === 'codex_ready') return 'jobs';
  return 'capture';
}

function nextStepLabel(stepId) {
  const labels = {
    receiver_running: 'Start the local receiver',
    dashboard_session_ready: 'Unlock the dashboard',
    browsers_paired: 'Pair a browser',
    snapshot_captured: 'Capture browser tabs',
    extraction_ready: 'Process captured evidence',
    codex_ready: 'Connect Codex planning',
    first_review_completed: 'Review one saved item',
    first_view_created: 'Create a workspace',
  };
  return labels[stepId] ?? 'Continue setup';
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
initReviewWorkspace();
initOperations({ onRefreshViews: refreshViews, onRefreshWorkspace: refreshViewWorkspace });
initConversation({ onRefreshViews: refreshViews });
subscribe(renderAskStage);
await refreshViews();
