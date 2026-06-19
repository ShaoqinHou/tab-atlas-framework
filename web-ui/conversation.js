import { getJson, postJson } from './api.js';
import { executePresentationPlan } from './presentationActions.js';
import { setState, state } from './state.js';
import { escapeHtml } from './shell.js';

let snapshot = null;
let refreshViewsCallback = null;
let lastExecutedPresentationMessageId = '';

export async function initConversation({ onRefreshViews } = {}) {
  refreshViewsCallback = onRefreshViews;
  const form = document.getElementById('conversationForm');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.getElementById('conversationInput');
    const text = input?.value.trim() ?? '';
    if (!text) return;
    input.value = '';
    await ensureThread();
    await sendMessage(text);
  });

  await ensureThread();
  renderConversation();
}

export function appendMessage(role, content) {
  if (!snapshot) return;
  snapshot = {
    ...snapshot,
    messages: [...snapshot.messages, {
      id: `local_${Date.now()}`,
      threadId: snapshot.thread.id,
      role,
      content,
      createdAt: new Date().toISOString(),
    }],
  };
  renderConversation();
}

async function ensureThread() {
  if (snapshot?.thread?.id) return snapshot;
  if (state.activeThreadId) {
    try {
      snapshot = await getJson(`/api/conversations/${encodeURIComponent(state.activeThreadId)}`);
      renderConversation();
      return snapshot;
    } catch {
      setState({ activeThreadId: '' });
    }
  }
  snapshot = await postJson('/api/conversations', { title: 'Visual workspace' });
  setState({ activeThreadId: snapshot.thread.id });
  renderConversation();
  return snapshot;
}

async function sendMessage(content) {
  appendMessage('user', content);
  try {
    snapshot = await postJson(`/api/conversations/${encodeURIComponent(state.activeThreadId)}/messages`, {
      content,
      activeViewId: state.activeViewId || undefined,
    });
    renderConversation();
    await executeLatestPresentationPlan();
    await openLatestViewResult();
  } catch (error) {
    appendMessage('assistant', `I could not run that request: ${error.message}`);
  }
}

function renderConversation() {
  const target = document.getElementById('conversationThread');
  if (!target) return;
  const messages = snapshot?.messages ?? [];
  const actions = snapshot?.actions ?? [];
  target.innerHTML = [
    ...messages.map(message => renderMessage(message)),
    ...actions.map(action => renderActionCard(action)),
  ].join('') || `
    <article class="message assistant">
      <div class="role">assistant</div>
      <div>Ready.</div>
    </article>
  `;
  target.querySelectorAll('[data-agent-confirm]').forEach(button => {
    button.addEventListener('click', () => confirmAction(button.dataset.agentConfirm));
  });
  target.querySelectorAll('[data-agent-cancel]').forEach(button => {
    button.addEventListener('click', () => cancelAction(button.dataset.agentCancel));
  });
  target.scrollTop = target.scrollHeight;
}

function renderMessage(message) {
  return `
    <article class="message ${escapeHtml(message.role)}" data-message-id="${escapeHtml(message.id)}">
      <div class="role">${escapeHtml(message.role)}</div>
      <div>${escapeHtml(message.content)}</div>
    </article>
  `;
}

function renderActionCard(action) {
  const status = humanStatus(action.status);
  const canConfirm = action.approval === 'confirm' && action.status === 'proposed';
  const canCancel = action.status === 'proposed' || action.status === 'approved';
  return `
    <article class="message assistant action-card" data-action-id="${escapeHtml(action.id)}">
      <div class="role">action</div>
      <strong>${escapeHtml(actionLabel(action))}</strong>
      <p>${escapeHtml(action.action?.rationale || status)}</p>
      <div class="chip-row">
        <span>${escapeHtml(status)}</span>
        <span>${escapeHtml(approvalLabel(action.approval))}</span>
      </div>
      ${canConfirm || canCancel ? `
        <div class="action-row">
          ${canConfirm ? `<button type="button" data-agent-confirm="${escapeHtml(action.id)}">Confirm</button>` : ''}
          ${canCancel ? `<button type="button" data-agent-cancel="${escapeHtml(action.id)}">Cancel</button>` : ''}
        </div>
      ` : ''}
    </article>
  `;
}

async function confirmAction(actionId) {
  if (!actionId) return;
  await postJson(`/api/agent-actions/${encodeURIComponent(actionId)}/confirm`, {});
  snapshot = await getJson(`/api/conversations/${encodeURIComponent(state.activeThreadId)}`);
  renderConversation();
  await openLatestViewResult();
}

async function cancelAction(actionId) {
  if (!actionId) return;
  await postJson(`/api/agent-actions/${encodeURIComponent(actionId)}/cancel`, {});
  snapshot = await getJson(`/api/conversations/${encodeURIComponent(state.activeThreadId)}`);
  renderConversation();
}

async function executeLatestPresentationPlan() {
  const assistantMessages = [...(snapshot?.messages ?? [])].reverse()
    .filter(message => message.role === 'assistant');
  const message = assistantMessages.find(item => item.context?.presentationPlan?.actions?.length);
  if (!message || message.id === lastExecutedPresentationMessageId) return;
  lastExecutedPresentationMessageId = message.id;
  await executePresentationPlan(message.context.presentationPlan);
}

async function openLatestViewResult() {
  const actions = [...(snapshot?.actions ?? [])].reverse();
  const completed = actions.find(action => action.status === 'succeeded' && action.result);
  const viewId = firstViewId(completed?.result);
  if (!viewId) return;
  setState({ activeViewId: viewId, page: 'views' });
  await refreshViewsCallback?.(viewId);
}

function firstViewId(result) {
  if (Array.isArray(result?.viewIds) && result.viewIds[0]) return result.viewIds[0];
  if (Array.isArray(result?.createdViewIds) && result.createdViewIds[0]) return result.createdViewIds[0];
  if (typeof result?.viewId === 'string') return result.viewId;
  return '';
}

function actionLabel(action) {
  const labels = {
    plan_view: 'Preview a new view',
    refine_view: 'Refine this view',
    start_review: 'Open review queue',
    scan_resources: 'Scan resources',
    add_annotation: 'Add a note',
    explain_membership: 'Explain why this belongs',
    accept_view: 'Accept view',
  };
  return labels[action.kind] ?? 'Agent action';
}

function humanStatus(status) {
  const labels = {
    proposed: 'Needs confirmation',
    approved: 'Approved',
    running: 'Running',
    succeeded: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return labels[status] ?? status;
}

function approvalLabel(approval) {
  if (approval === 'confirm') return 'Confirm first';
  if (approval === 'preview') return 'Preview';
  return 'Automatic';
}
