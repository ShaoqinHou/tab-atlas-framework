import { getJson, postJson } from './api.js';
import { executePresentationPlan } from './presentationActions.js';
import { openInspector } from './inspector.js';
import { openReviewSessionSnapshot } from './review.js';
import { setState, state } from './state.js';
import { escapeHtml } from './shell.js';
import { refreshViewWorkspace, showWorkspaceNotice } from './viewWorkspace.js';

let snapshot = null;
let refreshViewsCallback = null;
const executedPresentationMessageIds = new Set();
const handledActionIds = new Set();

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
  const priorActionStates = actionStateSnapshot();
  const priorMessageIds = messageIdSnapshot();
  appendMessage('user', content);
  try {
    snapshot = await postJson(`/api/conversations/${encodeURIComponent(state.activeThreadId)}/messages`, {
      content,
      activeViewId: state.activeViewId || undefined,
      currentLayout: state.layout,
      currentFilters: {
        states: state.workspaceStateFilters,
        tags: state.workspaceTagFilters,
        query: state.workspaceQueryFilter,
      },
    });
    renderConversation();
    await executeNewPresentationPlans(priorMessageIds);
    await handleCompletedActionResults(priorActionStates);
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
  target.querySelectorAll('[data-agent-retry]').forEach(button => {
    button.addEventListener('click', () => retryAction(button.dataset.agentRetry));
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
  const canRetry = action.status === 'failed';
  return `
    <article class="message assistant action-card" data-action-id="${escapeHtml(action.id)}">
      <div class="role">action</div>
      <strong>${escapeHtml(actionLabel(action))}</strong>
      <p>${escapeHtml(action.action?.rationale || status)}</p>
      <div class="chip-row">
        <span>${escapeHtml(status)}</span>
        <span>${escapeHtml(approvalLabel(action.approval))}</span>
      </div>
      ${canConfirm || canCancel || canRetry ? `
        <div class="action-row">
          ${canConfirm ? `<button type="button" data-agent-confirm="${escapeHtml(action.id)}">Confirm</button>` : ''}
          ${canCancel ? `<button type="button" data-agent-cancel="${escapeHtml(action.id)}">Cancel</button>` : ''}
          ${canRetry ? `<button type="button" data-agent-retry="${escapeHtml(action.id)}">Retry</button>` : ''}
        </div>
      ` : ''}
    </article>
  `;
}

async function confirmAction(actionId) {
  if (!actionId) return;
  const priorActionStates = actionStateSnapshot();
  await postJson(`/api/agent-actions/${encodeURIComponent(actionId)}/confirm`, {});
  snapshot = await getJson(`/api/conversations/${encodeURIComponent(state.activeThreadId)}`);
  renderConversation();
  await handleCompletedActionResults(priorActionStates);
}

async function cancelAction(actionId) {
  if (!actionId) return;
  await postJson(`/api/agent-actions/${encodeURIComponent(actionId)}/cancel`, {});
  snapshot = await getJson(`/api/conversations/${encodeURIComponent(state.activeThreadId)}`);
  renderConversation();
}

async function retryAction(actionId) {
  if (!actionId) return;
  const priorActionStates = actionStateSnapshot();
  await postJson(`/api/agent-actions/${encodeURIComponent(actionId)}/retry`, {});
  snapshot = await getJson(`/api/conversations/${encodeURIComponent(state.activeThreadId)}`);
  renderConversation();
  await handleCompletedActionResults(priorActionStates);
}

async function executeNewPresentationPlans(previousMessageIds = new Set()) {
  const assistantMessages = (snapshot?.messages ?? [])
    .filter(message => message.role === 'assistant'
      && !previousMessageIds.has(message.id)
      && message.context?.presentationPlan?.actions?.length);
  for (const message of assistantMessages) {
    if (executedPresentationMessageIds.has(message.id)) continue;
    executedPresentationMessageIds.add(message.id);
    await executePresentationPlan(message.context.presentationPlan);
  }
}

function actionStateSnapshot() {
  return new Map((snapshot?.actions ?? []).map(action => [action.id, action.status]));
}

function messageIdSnapshot() {
  return new Set((snapshot?.messages ?? []).map(message => message.id));
}

async function handleCompletedActionResults(previousStates = new Map()) {
  const actions = snapshot?.actions ?? [];
  for (const action of actions) {
    const previousStatus = previousStates.get(action.id);
    const becameSucceeded = action.status === 'succeeded'
      && (!previousStates.has(action.id) || previousStatus !== 'succeeded');
    if (!becameSucceeded || !action.result || handledActionIds.has(action.id)) continue;
    handledActionIds.add(action.id);
    await routeActionResult(action);
  }
}

async function routeActionResult(action) {
  const kind = action.kind || action.action?.kind;
  if (kind === 'plan_view' || kind === 'refine_view') {
    const viewId = firstViewId(action.result);
    if (!viewId) return;
    setState({ activeViewId: viewId, page: 'views' });
    await refreshViewsCallback?.(viewId);
    return;
  }
  if (kind === 'start_review') {
    openReviewSessionSnapshot(action.result);
    return;
  }
  if (kind === 'explain_membership') {
    const viewId = action.action?.viewId || state.activeViewId;
    const resourceId = action.action?.resourceId;
    if (resourceId) await openInspector('resource', resourceId, { viewId, tab: 'evidence' });
    showWorkspaceNotice(action.result.explanation || 'Explanation opened in the inspector.');
    return;
  }
  if (kind === 'add_annotation') {
    const resourceId = action.action?.resourceId || action.result.targetId;
    if (resourceId) await openInspector('resource', resourceId, { viewId: state.activeViewId, tab: 'notes' });
    await refreshViewWorkspace(state.activeViewId);
    showWorkspaceNotice('Saved note and refreshed the workspace.');
    return;
  }
  if (kind === 'scan_resources') {
    setState({ page: 'settings', settingsPanel: 'jobs' });
    showWorkspaceNotice('Scan job was queued. Open Operations > Jobs for progress.');
    return;
  }
  if (kind === 'accept_view') {
    const viewId = action.action?.viewId || action.result.viewId || state.activeViewId;
    setState({ activeViewId: viewId, page: 'views' });
    await refreshViewsCallback?.(viewId);
    showWorkspaceNotice('View accepted and workspace status refreshed.');
  }
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
    proposed: 'Waiting for your confirmation',
    approved: 'Approved',
    running: 'Running',
    succeeded: 'Done',
    failed: 'Interrupted or failed — retry available',
    cancelled: 'Cancelled',
  };
  return labels[status] ?? status;
}

function approvalLabel(approval) {
  if (approval === 'confirm') return 'Confirm first';
  if (approval === 'preview') return 'Preview';
  return 'Automatic';
}
