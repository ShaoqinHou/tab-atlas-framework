import { getJson, postJson } from './api.js';
import { openInspector } from './inspector.js';
import { escapeHtml } from './shell.js';
import { setState, state, subscribe } from './state.js';

const REVIEW_SESSION_STORAGE_KEY = 'tabatlas.workspace.reviewSessionId';
let snapshot = null;
let busy = false;
let selectedDecision = 'important';

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
    const pause = event.target.closest('[data-review-pause]');
    if (pause) await pauseReview();
    const resume = event.target.closest('[data-review-resume]');
    if (resume) await resumeReview();
    const tag = event.target.closest('[data-review-tag]');
    if (tag) addCustomTag(tag.dataset.reviewTag);
  });

  document.addEventListener('keydown', async event => {
    if (state.page !== 'review' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'enter') await submitDecision(selectedDecision);
    if (key === 's') await submitDecision('skip');
    if (key === 'i') await submitDecision('ignore');
    if (key === '1') { selectedDecision = 'important'; await submitDecision('important'); }
    if (key === '2') { selectedDecision = 'watch_later'; await submitDecision('watch_later'); }
    if (key === '3') { selectedDecision = 'project_reference'; await submitDecision('project_reference'); }
    if (key === '4') { selectedDecision = 'inspiration'; await submitDecision('inspiration'); }
    if (key === 'p') await (snapshot?.session.status === 'paused' ? resumeReview() : pauseReview());
    if (key === 'escape') await pauseReview();
  });

  subscribe(async current => {
    if (current.page === 'review' && !snapshot) await restoreReviewSession();
  });
  renderReview();
}

export async function startReviewSession(queue = 'unmarked', options = {}) {
  if (busy) return;
  busy = true;
  try {
    const sourceViewId = options.sourceViewId || sourceViewIdForQueue(queue);
    snapshot = await postJson('/api/review-sessions', {
      type: reviewTypeForQueue(queue),
      title: titleForQueue(queue),
      commandText: queue,
      sourceViewId,
      preload: 5,
    });
    localStorage.setItem(REVIEW_SESSION_STORAGE_KEY, snapshot.session.id);
    setState({ page: 'review' });
    renderReview();
  } finally {
    busy = false;
  }
}

export function openReviewSessionSnapshot(nextSnapshot) {
  snapshot = nextSnapshot;
  if (snapshot?.session?.id) {
    localStorage.setItem(REVIEW_SESSION_STORAGE_KEY, snapshot.session.id);
  }
  setState({ page: 'review' });
  renderReview();
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
  target.innerHTML = `
    <div class="review-layout">
      <section class="review-current">
        <header class="review-current-header">
          <div>
            <p class="kicker">${escapeHtml(snapshot.session.title || snapshot.session.type)}</p>
            <h3>${escapeHtml(current.title || current.canonicalUrl)}</h3>
            <p class="muted">${escapeHtml(current.host)} · ${escapeHtml(current.urlKind)} · ${escapeHtml(current.extractionStatus)}</p>
          </div>
          <button type="button" data-review-inspect="${escapeHtml(current.resourceId)}">Inspect</button>
        </header>
        ${renderReviewVisual(current, 'current')}
        <div class="review-context">
          <div class="metadata-grid">
            <div><span>Groups</span><strong>${escapeHtml(current.browserGroupTitles?.join(', ') || 'none')}</strong></div>
            <div><span>Transcript</span><strong>${transcriptStatus(current)}</strong></div>
            <div><span>Evidence</span><strong>${current.evidence?.length ?? 0}</strong></div>
            <div><span>Atomic items</span><strong>${current.atomicItems?.length ?? 0}</strong></div>
          </div>
          ${current.summary ? `<p>${escapeHtml(current.summary)}</p>` : `<p>${escapeHtml(current.redactedUrl || current.canonicalUrl)}</p>`}
          ${current.userAnnotations?.length ? `<p class="user-signal">${escapeHtml(current.userAnnotations[0].description || current.userAnnotations[0].tags.join(', '))}</p>` : ''}
          <p class="why-line">${escapeHtml(evidenceSummary(current))}</p>
        </div>
        <div class="action-row">
          <a class="button-link" href="${escapeHtml(current.redactedUrl || current.canonicalUrl)}" target="_blank" rel="noreferrer">Open externally</a>
          ${snapshot.session.status === 'paused'
            ? '<button type="button" data-review-resume>Resume</button>'
            : '<button type="button" data-review-pause>Pause</button>'}
        </div>
        <textarea id="reviewNote" placeholder="Note"></textarea>
        <input id="reviewTags" type="text" placeholder="Custom tags">
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
              <button type="button" class="review-next-card" data-review-inspect="${escapeHtml(item.resourceId)}">
                ${renderReviewVisual(item, 'next')}
                <strong>${escapeHtml(item.title || item.canonicalUrl)}</strong>
                <span>${escapeHtml(item.host)} · ${escapeHtml(item.extractionStatus)}</span>
              </button>
            `).join('') || '<p class="muted">No more queued items.</p>'}
          </div>
        </section>
        <section>
          <h4>Tags</h4>
          <div class="tag-cloud">
            ${snapshot.frequentTags.map(tag => `<button type="button" data-review-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('') || '<span>new</span>'}
          </div>
        </section>
        <section class="shortcut-legend">
          <h4>Shortcuts</h4>
          <p><kbd>Enter</kbd> Save · <kbd>S</kbd> Skip · <kbd>I</kbd> Ignore · <kbd>1</kbd> Important · <kbd>2</kbd> Watch later · <kbd>3</kbd> Project · <kbd>4</kbd> Inspiration · <kbd>P</kbd> Pause</p>
        </section>
      </aside>
    </div>
  `;
}

function decisionPayload(resourceId, decision, note) {
  const customTags = readCustomTags();
  if (decision === 'skip') return { resourceId, action: 'skip', decision: 'none', tags: customTags, description: note || undefined };
  if (decision === 'ignore') return { resourceId, action: 'mark_ignore', decision: 'ignore', tags: [...customTags, 'ignore'], description: note || undefined };
  return {
    resourceId,
    action: 'save_and_next',
    decision,
    tags: [...new Set([...customTags, decision.replace(/_/g, '-')])],
    description: note || undefined,
  };
}

function renderReviewVisual(resource, variant) {
  const media = reviewMedia(resource);
  const placeholder = `<div class="review-media-placeholder">${escapeHtml(iconFor(resource.urlKind))}</div>`;
  const thumbnail = media.thumbnailUrl && state.remoteMedia !== 'off'
    ? `<img src="${escapeHtml(media.thumbnailUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : placeholder;
  const embed = media.embedUrl && state.remoteMedia !== 'off' && variant === 'current'
    ? `<iframe src="${escapeHtml(media.embedUrl)}" title="${escapeHtml(resource.title || 'Video preview')}" loading="lazy" referrerpolicy="no-referrer" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen></iframe>`
    : '';
  return `
    <div class="review-preview review-preview-${variant}" data-review-visual="${variant}">
      ${embed || thumbnail}
    </div>
  `;
}

function reviewMedia(resource) {
  const videoId = youtubeVideoId(resource.canonicalUrl || resource.redactedUrl || '');
  if (videoId) {
    return {
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
    };
  }
  const og = resource.evidence?.find(item => /thumbnail|open[_ -]?graph|image/i.test(`${item.kind} ${item.text}`));
  return og?.text?.startsWith('https://') ? { thumbnailUrl: og.text } : {};
}

function youtubeVideoId(raw) {
  try {
    const url = new URL(raw);
    if (url.hostname === 'youtu.be') return sanitizeVideoId(url.pathname.slice(1));
    if (url.hostname.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return sanitizeVideoId(url.searchParams.get('v') || '');
      const match = url.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
      return sanitizeVideoId(match?.[1] || '');
    }
  } catch {
    return '';
  }
  return '';
}

function sanitizeVideoId(value) {
  return /^[A-Za-z0-9_-]{6,20}$/.test(value) ? value : '';
}

function transcriptStatus(resource) {
  return resource.evidence?.some(item => /transcript/i.test(`${item.kind} ${item.provenance} ${item.text}`))
    ? 'available'
    : resource.urlKind?.startsWith('youtube_') ? 'metadata only' : 'not applicable';
}

function evidenceSummary(resource) {
  const first = resource.evidence?.[0];
  if (!first) return 'No extracted evidence yet; use title, host, and notes.';
  return `${first.kind} from ${first.provenance}: ${first.text}`.slice(0, 220);
}

function iconFor(urlKind) {
  if (urlKind?.startsWith('youtube_')) return '▶';
  if (urlKind?.startsWith('github_')) return '{}';
  if (urlKind === 'pdf' || urlKind === 'docs') return 'Doc';
  if (urlKind === 'search') return 'Q';
  return 'A';
}

async function pauseReview() {
  if (!snapshot?.session?.id || snapshot.session.status === 'paused') return;
  snapshot = await postJson(`/api/review-sessions/${encodeURIComponent(snapshot.session.id)}/pause`, {});
  renderReview();
}

async function resumeReview() {
  if (!snapshot?.session?.id) return;
  snapshot = await postJson(`/api/review-sessions/${encodeURIComponent(snapshot.session.id)}/resume`, {});
  renderReview();
}

function addCustomTag(tag) {
  const input = document.getElementById('reviewTags');
  if (!input || !tag) return;
  const tags = new Set(readCustomTags());
  tags.add(tag);
  input.value = [...tags].join(', ');
}

function readCustomTags() {
  const raw = document.getElementById('reviewTags')?.value ?? '';
  return raw.split(',').map(tag => tag.trim()).filter(Boolean);
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input'
    || tag === 'textarea'
    || tag === 'select'
    || target.isContentEditable
    || Boolean(target.closest('[contenteditable="true"]'));
}

function reviewTypeForQueue(queue) {
  if (queue === 'weak' || queue === 'needs_review') return 'weak_matches';
  if (queue === 'conflict') return 'conflicts';
  if (queue === 'ambiguous') return 'ambiguous';
  if (queue === 'extraction_failure') return 'extraction_failures';
  return 'unmarked';
}

function sourceViewIdForQueue(queue) {
  return ['weak', 'needs_review', 'conflict', 'ambiguous'].includes(queue)
    ? state.activeViewId || undefined
    : undefined;
}

function titleForQueue(queue) {
  if (queue === 'weak' || queue === 'needs_review') return 'Weak match review';
  if (queue === 'conflict') return 'Conflict review';
  if (queue === 'ambiguous') return 'Ambiguous item review';
  if (queue === 'extraction_failure') return 'Extraction failure review';
  return 'Unmarked review';
}
