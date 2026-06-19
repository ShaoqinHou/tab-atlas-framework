import { postJson } from './api.js';
import { executePresentationPlan, hasActiveWorkspace, requestPresentationPlan } from './presentationActions.js';
import { setState, state } from './state.js';
import { escapeHtml } from './shell.js';

let transcript = [];

export function initConversation({ onRefreshViews } = {}) {
  const form = document.getElementById('conversationForm');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.getElementById('conversationInput');
    const text = input?.value.trim() ?? '';
    if (!text) return;
    input.value = '';
    appendMessage('user', text);
    try {
      if (hasActiveWorkspace()) {
        const presentationPlan = await requestPresentationPlan(text);
        if (presentationPlan.actions?.length) {
          appendMessage('assistant', presentationPlan.reply);
          await executePresentationPlan(presentationPlan);
          return;
        }
      }
      const result = await postJson('/api/agent/command', {
        command: text,
        mode: 'heuristic',
      });
      const viewId = firstViewId(result);
      appendMessage('assistant', summarizeCommandResult(result, viewId));
      if (viewId) {
        setState({ activeViewId: viewId, page: 'views' });
        await onRefreshViews?.(viewId);
      } else {
        await onRefreshViews?.();
      }
    } catch (error) {
      appendMessage('assistant', `I could not run that request: ${error.message}`);
    }
  });

  appendMessage('assistant', 'Ready.');
}

export function appendMessage(role, content) {
  transcript = [...transcript, { role, content, at: new Date().toISOString() }].slice(-80);
  renderTranscript();
}

function renderTranscript() {
  const target = document.getElementById('conversationThread');
  if (!target) return;
  target.innerHTML = transcript.map(message => `
    <article class="message ${message.role}">
      <div class="role">${escapeHtml(message.role)}</div>
      <div>${escapeHtml(message.content)}</div>
    </article>
  `).join('');
  target.scrollTop = target.scrollHeight;
}

function firstViewId(result) {
  if (Array.isArray(result?.viewIds) && result.viewIds[0]) return result.viewIds[0];
  if (Array.isArray(result?.createdViewIds) && result.createdViewIds[0]) return result.createdViewIds[0];
  if (typeof result?.viewId === 'string') return result.viewId;
  return state.activeViewId;
}

function summarizeCommandResult(result, viewId) {
  if (viewId) return `Opened view ${viewId}.`;
  if (result?.summary) return String(result.summary);
  if (result?.ok === false) return result.error ?? 'The request did not complete.';
  return 'Done.';
}
