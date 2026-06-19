import { getJson, postJson } from './api.js';
import { openInspector } from './inspector.js';
import { escapeHtml } from './shell.js';
import { setState, state, subscribe } from './state.js';
import { getCurrentWorkspace } from './viewWorkspace.js';

const REVIEW_SESSION_STORAGE_KEY = 'tabatlas.workspace.reviewSessionId';
let snapshot = null;
let busy = false;

export function initReviewWorkspace() {
  document.getElementById('reviewWorkspace')?.addEventListener('click', async event => {
    const start = event.target.closest('[data-review-start]');
    if (start) {
      await startReviewSession(start.dataset.reviewStart);
      return;
    }
    const decision = event.target.closest('[data-review-decision]');
    if (decision) {
      await submitDecision(decision.dataset.reviewDecision);
      return;
    }
    const inspect = event.target.closest('[data-review-inspect]');
    if (inspect) await openInspector('resource', inspect.dataset.reviewInspect, { viewId: state.activeViewId });
  });

  document.addEventListener('keydown', async event => {
    if (state.page !== 'review' || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 's') await submitDecision('skip');
    if (key === 'i') await submitDecision('ignore');
    if (key === '1') await submitDecision('important');
    if (key === '2') await submitDecision('watch_later');
    if (key === '3') await submitDecision('project_reference');
    if (key === '4') await submitDecision('inspiration');
  });

  subscribe(async current => {
    if (current.page === 'review' && !snapshot) await restoreReviewSession();
  });
  renderReview();
}

export async function startReviewSession(queue = 'unmarked') {
  if (busy) return;
  busy = true;
  try {
    const resourceIds = resourceIdsForQueue(queue);
    snapshot = await postJson('/api/review-sessions', {
      type: reviewTypeForQueue(queue),
      title: titleForQueue(queue),
      commandText: queue,
      resourceIds: resourceIds.length ? resourceIds : undefined,
      preload: 5,
    });
    localStorage.setItem(REVIEW_SESSION_STORAGE_KEY, snapshot.session.id);
    setState({ page: 'review' });
    renderReview();
  } finally {
    busy = false;
  }
}

async function restoreReviewSession() {
  const id = localStorage.getItem(REVIEW_SESSION_STORAGE_KEY);
  if (!id) {
    renderReview();
    return;
  }
  try {
    snapshot = await getJson(`/api/review-sessions/${encodeURIComponent(id)}`);
  } catch {
    localStorage.removeItem(REVIEW_SESSION_STORAGE_KEY);
    snapshot = null;
  }
  renderReview();
}

async function submitDecision(decision) {
  if (!snapshot?.current || busy) return;
  busy = true;
  try {
    const note = document.getElementById('reviewNote')?.value.trim() ?? '';
    const payload = decisionPayload(snapshot.current.resourceId, decision, note);
    snapshot = await postJson(`/api/review-sessions/${encodeURIComponent(snapshot.session.id)}/decisions`, payload);
    renderReview();
  } finally {
    busy = false;
  }
}

function renderReview() {
  const target = document.getElementById('reviewWorkspace');
  if (!target) return;
  if (!snapshot) {
    target.innerHTML = `
      <div class="review-start">
        <div>
          <p class="kicker">Queue</p>
          <h3>Start focused review</h3>
        </div>
        <div class="review-start-grid">
          <button type="button" data-review-start="unmarked">Unmarked</button>
          <button type="button" data-review-start="weak">Weak matches</button>
          <button type="button" data-review-start="conflict">Conflicts</button>
          <button type="button" data-review-start="extraction_failure">Extraction failures</button>
        </div>
      </div>
    `;
    return;
  }
  const current = snapshot.current;
  if (!current) {
    target.innerHTML = `
      <div class="empty-state">
        <p class="kicker">${escapeHtml(snapshot.session.title || 'Review')}</p>
        <h3>Queue complete.</h3>
      </div>
    `;
    return;
  }
  target.innerHTML = `
    <div class="review-layout">
      <section class="review-current">
        <header class="review-current-header">
          <div>
            <p class="kicker">${escapeHtml(snapshot.session.title || snapshot.session.type)}</p>
            <h3>${escapeHtml(current.title || current.canonicalUrl)}</h3>
            <p class="muted">${escapeHtml(current.host)} · ${escapeHtml(current.urlKind)}</p>
          </div>
          <button type="button" data-review-inspect="${escapeHtml(current.resourceId)}">Inspect</button>
        </header>
        <div class="review-preview">
          ${current.summary ? `<p>${escapeHtml(current.summary)}</p>` : `<p>${escapeHtml(current.redactedUrl || current.canonicalUrl)}</p>`}
        </div>
        <textarea id="reviewNote" placeholder="Note"></textarea>
        <div class="decision-grid">
          <button type="button" data-review-decision="important">Important</button>
          <button type="button" data-review-decision="watch_later">Watch later</button>
          <button type="button" data-review-decision="project_reference">Project reference</button>
          <button type="button" data-review-decision="inspiration">Inspiration</button>
          <button type="button" data-review-decision="skip">Skip</button>
          <button type="button" data-review-decision="ignore">Ignore</button>
        </div>
      </section>
      <aside class="review-side">
        <div class="progress-block">
          <span>${snapshot.progress.completed} done</span>
          <strong>${snapshot.progress.pending} pending</strong>
          <progress value="${snapshot.progress.completed}" max="${Math.max(1, snapshot.session.totalItems)}"></progress>
        </div>
        <section>
          <h4>Next</h4>
          <div class="next-list">
            ${snapshot.next.slice(0, 3).map(item => `
              <button type="button" data-review-inspect="${escapeHtml(item.resourceId)}">
                <strong>${escapeHtml(item.title || item.canonicalUrl)}</strong>
                <span>${escapeHtml(item.host)}</span>
              </button>
            `).join('') || '<p class="muted">No more queued items.</p>'}
          </div>
        </section>
        <section>
          <h4>Tags</h4>
          <div class="tag-cloud">
            ${snapshot.frequentTags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('') || '<span>new</span>'}
          </div>
        </section>
      </aside>
    </div>
  `;
}

function decisionPayload(resourceId, decision, note) {
  if (decision === 'skip') return { resourceId, action: 'skip', decision: 'none', tags: [], description: note || undefined };
  if (decision === 'ignore') return { resourceId, action: 'mark_ignore', decision: 'ignore', tags: ['ignore'], description: note || undefined };
  return {
    resourceId,
    action: 'save_and_next',
    decision,
    tags: [decision.replace(/_/g, '-')],
    description: note || undefined,
  };
}

function resourceIdsForQueue(queue) {
  const workspace = getCurrentWorkspace();
  if (!workspace) return [];
  const cards = queue === 'unmarked'
    ? workspace.sections.flatMap(section => section.cards)
    : workspace.reviewLane;
  return cards
    .filter(card => card.targetKind === 'resource')
    .filter(card => {
      if (queue === 'weak') return card.state === 'weak_include' || card.state === 'needs_review';
      if (queue === 'conflict') return card.state === 'conflict';
      return true;
    })
    .map(card => card.targetId);
}

function reviewTypeForQueue(queue) {
  if (queue === 'weak' || queue === 'needs_review') return 'weak_matches';
  if (queue === 'conflict') return 'conflicts';
  if (queue === 'extraction_failure') return 'extraction_failures';
  return 'unmarked';
}

function titleForQueue(queue) {
  if (queue === 'weak' || queue === 'needs_review') return 'Weak match review';
  if (queue === 'conflict') return 'Conflict review';
  if (queue === 'extraction_failure') return 'Extraction failure review';
  return 'Unmarked review';
}
