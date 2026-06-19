import { getJson, postJson } from './api.js';
import { setState, state } from './state.js';
import { escapeHtml } from './shell.js';

let currentInspector = null;
let activeTab = 'overview';
let returnFocusElement = null;

export function initInspector() {
  document.getElementById('conversationTab')?.addEventListener('click', () => showPanel('conversation'));
  document.getElementById('inspectorTab')?.addEventListener('click', () => showPanel('inspector'));
  document.getElementById('inspectorContent')?.addEventListener('click', handleInspectorAction);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('inspectorSurface')?.classList.contains('active')) {
      closeInspector();
    }
  });
}

export async function openInspector(targetKind, targetId, options = {}) {
  activeTab = options.tab ?? activeTab;
  returnFocusElement = options.origin ?? returnFocusElement;
  showPanel('inspector');
  const viewId = options.viewId ?? state.activeViewId;
  const params = viewId ? `?viewId=${encodeURIComponent(viewId)}` : '';
  currentInspector = await getJson(`/api/targets/${encodeURIComponent(targetKind)}/${encodeURIComponent(targetId)}/inspector${params}`);
  renderInspector();
}

export function renderInspector() {
  const empty = document.getElementById('inspectorEmpty');
  const content = document.getElementById('inspectorContent');
  if (!empty || !content) return;
  if (!currentInspector) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  const tabs = ['overview', 'evidence', 'notes', 'related'];
  content.innerHTML = `
    <div class="inspector-header">
      <button type="button" class="icon-button inspector-close" data-close-inspector aria-label="Close inspector">×</button>
      <p class="kicker">${escapeHtml(currentInspector.targetKind)}</p>
      <h3>${escapeHtml(currentInspector.title)}</h3>
      <p class="muted">${escapeHtml(currentInspector.host || currentInspector.urlKind)}</p>
    </div>
    <div class="inspector-tabs" role="tablist">
      ${tabs.map(tab => `<button type="button" role="tab" aria-selected="${tab === activeTab}" class="${tab === activeTab ? 'active' : ''}" data-inspector-tab="${tab}">${label(tab)}</button>`).join('')}
    </div>
    <div class="inspector-body" role="tabpanel">${renderInspectorTab(currentInspector, activeTab)}</div>
  `;
  content.querySelectorAll('[data-inspector-tab]').forEach(button => {
    button.addEventListener('click', () => {
      activeTab = button.dataset.inspectorTab;
      renderInspector();
    });
  });
}

function renderInspectorTab(item, tab) {
  if (tab === 'evidence') {
    return `
      <div class="inspector-stack">
        ${item.evidence.map(evidence => `
          <article class="evidence-row">
            <strong>${escapeHtml(evidence.label)}</strong>
            <p>${escapeHtml(evidence.text)}</p>
            <span>${escapeHtml(evidence.kind)} · ${escapeHtml(evidence.provenance)} · ${Math.round(evidence.confidence * 100)}%</span>
          </article>
        `).join('') || '<p class="muted">No evidence surfaced.</p>'}
        ${item.technicalEvidenceRefs.length ? `<details><summary>Technical refs</summary><code>${escapeHtml(item.technicalEvidenceRefs.join(', '))}</code></details>` : ''}
      </div>
    `;
  }
  if (tab === 'notes') {
    return `
      <div class="inspector-stack">
        ${item.userNotes.map(note => `
          <article class="note-row">
            <strong>${escapeHtml(note.decision)}</strong>
            <p>${escapeHtml(note.description || note.tags.join(', ') || note.source)}</p>
            <span>${escapeHtml(note.createdAt)}</span>
          </article>
        `).join('') || '<p class="muted">No user notes yet.</p>'}
      </div>
    `;
  }
  if (tab === 'related') {
    return `
      <div class="inspector-stack">
        <section>
          <h4>Views</h4>
          ${item.relatedViews.map(view => `
            <button type="button" class="related-row" data-related-view="${escapeHtml(view.viewId)}">
              <strong>${escapeHtml(view.name)}</strong>
              <span>${escapeHtml(view.state)}${view.section ? ` · ${escapeHtml(view.section)}` : ''}</span>
            </button>
          `).join('') || '<p class="muted">No related views.</p>'}
        </section>
        <section>
          <h4>Resources</h4>
          ${item.relatedResources.map(resource => `
            <div class="related-row">
              <strong>${escapeHtml(resource.title)}</strong>
              <span>${escapeHtml(resource.host)}</span>
            </div>
          `).join('') || '<p class="muted">No related resources.</p>'}
        </section>
      </div>
    `;
  }
  const membership = item.currentViewMembership;
  return `
    <div class="inspector-stack">
      ${item.safeOpenUrl ? `<a class="button-link" href="${escapeHtml(item.safeOpenUrl)}" target="_blank" rel="noreferrer">Open</a>` : ''}
      <div class="metadata-grid">
        <div><span>State</span><strong>${escapeHtml(membership?.state ?? 'not in current view')}</strong></div>
        <div><span>Section</span><strong>${escapeHtml(membership?.section ?? '-')}</strong></div>
        <div><span>Evidence</span><strong>${escapeHtml(membership?.evidenceStrength ?? 'none')}</strong></div>
        <div><span>Extraction</span><strong>${escapeHtml(item.extractionStatus)}</strong></div>
      </div>
      <p>${escapeHtml(item.summary || membership?.reason || 'No summary available.')}</p>
      ${membership ? `
        <div class="correction-panel">
          <h4>Correct this view</h4>
          <div class="action-row">
            <button type="button" data-explain-membership="${escapeHtml(item.targetId)}">Explain</button>
            <button type="button" data-correction-decision="pin_include">Pin include</button>
            <button type="button" data-correction-decision="pin_exclude">Pin exclude</button>
            <button type="button" data-correction-decision="reject">Reject</button>
          </div>
          <textarea id="correctionReason" rows="2" placeholder="Correction note"></textarea>
          <div id="correctionResult" class="muted"></div>
        </div>
      ` : ''}
      ${item.atomicItems.length ? `
        <section>
          <h4>Atomic items</h4>
          ${item.atomicItems.map(atomic => `
            <div class="related-row">
              <strong>${escapeHtml(atomic.name)}</strong>
              <span>${escapeHtml(atomic.itemKind)} · ${Math.round(atomic.confidence * 100)}%</span>
            </div>
          `).join('')}
        </section>
      ` : ''}
      ${item.parentResourceId ? `<button type="button" data-parent-resource="${escapeHtml(item.parentResourceId)}">Open parent resource</button>` : ''}
    </div>
  `;
}

async function handleInspectorAction(event) {
  if (event.target.closest('[data-close-inspector]')) {
    closeInspector();
    return;
  }
  const relatedView = event.target.closest('[data-related-view]');
  if (relatedView) {
    setState({ activeViewId: relatedView.dataset.relatedView, page: 'views' });
    closeInspector();
    return;
  }
  const parent = event.target.closest('[data-parent-resource]');
  if (parent) {
    await openInspector('resource', parent.dataset.parentResource, { viewId: state.activeViewId });
    return;
  }
  const explain = event.target.closest('[data-explain-membership]');
  if (explain && currentInspector) {
    const viewId = state.activeViewId;
    const result = await getJson(`/api/resources/${encodeURIComponent(currentInspector.parentResourceId || currentInspector.targetId)}/explain?viewId=${encodeURIComponent(viewId)}`);
    writeCorrectionResult(result.explanation ?? JSON.stringify(result, null, 2));
    return;
  }
  const correction = event.target.closest('[data-correction-decision]');
  if (!correction || !currentInspector?.currentViewMembership) return;
  const reason = document.getElementById('correctionReason')?.value.trim() ?? '';
  const result = await postJson('/api/membership-feedback', {
    viewId: state.activeViewId,
    membershipId: currentInspector.currentViewMembership.membershipId,
    targetKind: currentInspector.targetKind,
    targetId: currentInspector.targetId,
    decision: correction.dataset.correctionDecision,
    reason: reason || undefined,
    scopeMode: 'intent',
  });
  writeCorrectionResult(`Saved ${result.decision}.`);
}

function writeCorrectionResult(value) {
  const target = document.getElementById('correctionResult');
  if (target) target.textContent = value;
}

function closeInspector() {
  showPanel('conversation');
  currentInspector = null;
  renderInspector();
  if (returnFocusElement && typeof returnFocusElement.focus === 'function') {
    returnFocusElement.focus();
  }
}

function showPanel(panel) {
  const conversation = document.getElementById('conversationSurface');
  const inspector = document.getElementById('inspectorSurface');
  const conversationTab = document.getElementById('conversationTab');
  const inspectorTab = document.getElementById('inspectorTab');
  const showInspector = panel === 'inspector';
  conversation?.classList.toggle('active', !showInspector);
  inspector?.classList.toggle('active', showInspector);
  conversationTab?.classList.toggle('active', !showInspector);
  inspectorTab?.classList.toggle('active', showInspector);
  conversationTab?.setAttribute('aria-selected', String(!showInspector));
  inspectorTab?.setAttribute('aria-selected', String(showInspector));
}

function label(tab) {
  return tab.slice(0, 1).toUpperCase() + tab.slice(1);
}
