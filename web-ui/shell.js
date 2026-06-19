import { api, getSavedToken, saveToken } from './api.js';
import { setState, state, subscribe } from './state.js';

const pageTitles = {
  ask: ['Ask', 'Agent workspace'],
  views: ['Views', 'Visual workspace'],
  review: ['Review', 'Focused review'],
  settings: ['Operations', 'Local settings'],
};

export function initShell({ onRefresh, onViewChange } = {}) {
  document.querySelectorAll('[data-nav]').forEach(button => {
    button.addEventListener('click', () => {
      const page = button.dataset.nav;
      setState({ page, settingsPanel: button.dataset.settingsPanel ?? state.settingsPanel });
    });
  });

  document.querySelectorAll('[data-layout]').forEach(button => {
    button.addEventListener('click', () => setState({ layout: button.dataset.layout }));
  });

  document.getElementById('refreshButton')?.addEventListener('click', () => onRefresh?.());
  document.getElementById('activeViewSelect')?.addEventListener('change', event => {
    const viewId = event.currentTarget.value;
    setState({ activeViewId: viewId, page: viewId ? 'views' : state.page });
    onViewChange?.(viewId);
  });

  const tokenInput = document.getElementById('localToken');
  if (tokenInput) tokenInput.value = getSavedToken();
  document.getElementById('saveTokenButton')?.addEventListener('click', () => {
    saveToken(tokenInput?.value ?? '');
    refreshStatus();
  });
  document.getElementById('clearTokenButton')?.addEventListener('click', () => {
    if (tokenInput) tokenInput.value = '';
    saveToken('');
    refreshStatus();
  });
  document.getElementById('bootstrapButton')?.addEventListener('click', async () => {
    const secret = document.getElementById('bootstrapSecret')?.value ?? '';
    const session = await api('/api/onboarding/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ secret }),
    });
    if (session?.token) saveToken(session.token);
    if (tokenInput) tokenInput.value = getSavedToken();
    await refreshStatus();
  });

  subscribe(renderShellState);
  renderShellState(state);
  refreshStatus();
}

export function renderShellState(current) {
  document.querySelectorAll('.workspace-page').forEach(page => {
    page.classList.toggle('active', page.dataset.page === current.page);
  });
  document.querySelectorAll('[data-nav]').forEach(button => {
    button.classList.toggle('active', button.dataset.nav === current.page);
  });
  document.querySelectorAll('[data-layout]').forEach(button => {
    button.classList.toggle('active', button.dataset.layout === current.layout);
  });

  const [kicker, title] = pageTitles[current.page] ?? pageTitles.ask;
  setText('workspaceKicker', kicker);
  setText('workspaceTitle', title);

  if (current.page === 'settings' && current.settingsPanel) {
    document.getElementById(`settings-${current.settingsPanel}`)?.scrollIntoView({ block: 'start' });
  }
}

export async function refreshStatus() {
  try {
    const health = await api('/health');
    setText('receiverStatus', health.ok ? 'Receiver ready' : 'Receiver unavailable');
  } catch {
    setText('receiverStatus', 'Receiver unavailable');
  }

  try {
    const status = await api('/api/status');
    const diagnostics = document.getElementById('diagnosticsOutput');
    if (diagnostics) diagnostics.textContent = JSON.stringify(status, null, 2);
  } catch (error) {
    const diagnostics = document.getElementById('diagnosticsOutput');
    if (diagnostics) diagnostics.textContent = `API locked: ${error.message}`;
  }
}

export function setViewOptions(views) {
  const select = document.getElementById('activeViewSelect');
  if (!select) return;
  const current = state.activeViewId;
  select.innerHTML = [
    '<option value="">Choose view</option>',
    ...views.map(view => `<option value="${escapeHtml(view.id)}">${escapeHtml(view.name || view.id)}</option>`),
  ].join('');
  select.value = current;
}

export function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}
