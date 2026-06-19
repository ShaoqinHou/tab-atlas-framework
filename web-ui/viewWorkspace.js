import { getJson } from './api.js';
import { openInspector } from './inspector.js';
import { escapeHtml } from './shell.js';
import { setState, state, subscribe } from './state.js';

let workspace = null;
let sectionPages = new Map();
let stateFilters = csvList(state.workspaceStateFilters) || ['visible'];
let tagFilters = csvList(state.workspaceTagFilters);
let queryFilter = (state.workspaceQueryFilter || '').toLowerCase();
let lastRenderSignature = renderSignature(state);

export function initViewWorkspace() {
  renderFilters();
  const remoteToggle = document.getElementById('remoteMediaToggle');
  if (remoteToggle) {
    remoteToggle.checked = state.remoteMedia !== 'off';
    remoteToggle.addEventListener('change', () => setState({ remoteMedia: remoteToggle.checked ? 'on' : 'off' }));
  }
  document.getElementById('viewFilters')?.addEventListener('click', event => {
    const button = event.target.closest('[data-state-filter]');
    if (!button) return;
    const value = button.dataset.stateFilter;
    stateFilters = value === 'visible' ? ['visible'] : [value];
    persistWorkspaceFilters();
    renderFilters();
    renderWorkspace();
  });

  document.getElementById('viewFilters')?.addEventListener('input', event => {
    if (event.target.id === 'workspaceSearch') {
      queryFilter = event.target.value.trim().toLowerCase();
      persistWorkspaceFilters();
      renderWorkspace();
    }
  });

  document.getElementById('viewWorkspace')?.addEventListener('click', async event => {
    const focusSection = event.target.closest('[data-focus-section]');
    if (focusSection) {
      focusWorkspaceSection(focusSection.dataset.focusSection);
      return;
    }
    const cardButton = event.target.closest('[data-target-kind][data-target-id]');
    if (cardButton) {
      await openInspector(cardButton.dataset.targetKind, cardButton.dataset.targetId, {
        viewId: state.activeViewId,
        origin: cardButton,
      });
      return;
    }
    const loadMore = event.target.closest('[data-load-section]');
    if (loadMore) await loadMoreSection(loadMore.dataset.loadSection);
    const prompt = event.target.closest('[data-suggested-prompt]');
    if (prompt) {
      const input = document.getElementById('conversationInput');
      input.value = prompt.dataset.suggestedPrompt;
      document.getElementById('conversationForm')?.requestSubmit();
    }
  });

  document.getElementById('viewWorkspace')?.addEventListener('scroll', event => {
    setState({ workspaceScrollTop: String(event.currentTarget.scrollTop) });
  });

  subscribe(current => {
    const nextSignature = renderSignature(current);
    if (!workspace || nextSignature === lastRenderSignature) return;
    lastRenderSignature = nextSignature;
    renderWorkspace();
  });
}

export async function refreshViewWorkspace(viewId = state.activeViewId) {
  if (!viewId) {
    workspace = null;
    sectionPages = new Map();
    renderWorkspace();
    return;
  }
  workspace = await getJson(`/api/views/${encodeURIComponent(viewId)}/workspace?limit=24`);
  sectionPages = new Map(workspace.sections.map(section => [section.id, section.cards.slice()]));
  await restoreSectionPages();
  renderWorkspace();
}

export function getCurrentWorkspace() {
  return workspace;
}

export function focusWorkspaceSection(sectionId) {
  setState({ focusedSectionId: sectionId });
}

export function setWorkspaceFilter(filter) {
  if (typeof filter === 'string') {
    stateFilters = [filter || 'visible'];
    tagFilters = [];
    queryFilter = '';
  } else {
    stateFilters = filter.states?.length ? filter.states : ['visible'];
    tagFilters = filter.tags ?? [];
    queryFilter = filter.query?.toLowerCase() ?? '';
  }
  persistWorkspaceFilters();
  renderFilters();
  renderWorkspace();
}

export function showWorkspaceNotice(message) {
  const target = document.getElementById('viewWorkspace');
  if (!target) return;
  target.insertAdjacentHTML('afterbegin', `<div class="notice">${escapeHtml(message)}</div>`);
}

export function showRevisionComparison(comparison) {
  const target = document.getElementById('viewWorkspace');
  if (!target) return;
  if (!comparison?.comparable) {
    showWorkspaceNotice(comparison?.unavailableReason || 'Revision comparison is unavailable.');
    return;
  }
  const changes = comparison.changes ?? {};
  target.insertAdjacentHTML('afterbegin', `
    <section class="revision-comparison" role="region" aria-label="Revision comparison">
      <header>
        <p class="kicker">Revision comparison</p>
        <h3>Revision ${escapeHtml(comparison.left?.revisionNumber)} vs ${escapeHtml(comparison.right?.revisionNumber)}</h3>
        <p class="muted">${comparison.summary?.added ?? 0} added · ${comparison.summary?.removed ?? 0} removed · ${comparison.summary?.changed ?? 0} changed</p>
      </header>
      ${renderGoalChange(changes.goalChange)}
      ${renderRuleChanges(changes.ruleChanges ?? [])}
      ${renderComparisonList('Added targets', changes.addedTargets ?? [])}
      ${renderComparisonList('Removed targets', changes.removedTargets ?? [])}
      ${renderMembershipChanges(changes.membershipChanges ?? [])}
    </section>
  `);
}

function renderWorkspace() {
  const target = document.getElementById('viewWorkspace');
  if (!target) return;
  if (!workspace) {
    target.innerHTML = `
      <div class="empty-state">
        <p class="kicker">No view selected</p>
        <h3>Choose a view from the selector.</h3>
      </div>
    `;
    return;
  }
  target.className = `stage workspace-layout workspace-layout-${state.layout}`;
  target.innerHTML = `
    <header class="workspace-hero">
      <div>
        <p class="kicker">${escapeHtml(workspace.viewName)}</p>
        <h3>${escapeHtml(workspace.headline)}</h3>
        <p class="muted">${escapeHtml(workspace.subhead)}</p>
      </div>
      <div class="stats-row">
        ${workspace.stats.map(stat => `<div class="stat-pill ${stat.tone}"><span>${escapeHtml(stat.label)}</span><strong>${stat.value}</strong></div>`).join('')}
      </div>
    </header>
    ${state.activeThreadId ? '<p class="restore-summary">Since last time: conversation, workspace, and inspector state are available.</p>' : ''}
    ${workspace.hiddenExcludedCount ? `<details class="excluded-notice"><summary>${workspace.hiddenExcludedCount} excluded hidden</summary><p>Excluded items stay out of the main workspace until explicitly requested.</p></details>` : ''}
    ${renderByLayout(state.layout)}
    <footer class="prompt-row">
      ${workspace.suggestedPrompts.map(prompt => `<button type="button" data-suggested-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`).join('')}
    </footer>
  `;
  restoreWorkspaceScroll(target);
}

function renderGoalChange(change) {
  if (!change) return '';
  return `
    <section>
      <h4>Goal</h4>
      <p><span>Before</span> ${escapeHtml(change.from || '(none)')}</p>
      <p><span>After</span> ${escapeHtml(change.to || '(none)')}</p>
    </section>
  `;
}

function renderRuleChanges(changes) {
  if (!changes.length) return '';
  return `
    <section>
      <h4>Rules</h4>
      ${changes.map(change => `<p><span>${escapeHtml(change.kind)}</span> ${escapeHtml(change.rule)}</p>`).join('')}
    </section>
  `;
}

function renderComparisonList(title, items) {
  if (!items.length) return '';
  return `
    <section>
      <h4>${escapeHtml(title)}</h4>
      ${items.map(item => `
        <article class="comparison-row">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.targetKind)} · ${escapeHtml(item.host)} · ${escapeHtml(item.state || '')} · ${escapeHtml(item.section || 'Unsectioned')} · ${Math.round((item.confidence ?? 0) * 100)}%</span>
        </article>
      `).join('')}
    </section>
  `;
}

function renderMembershipChanges(items) {
  if (!items.length) return '';
  return `
    <section>
      <h4>Membership changes</h4>
      ${items.map(item => `
        <article class="comparison-row">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.before.state)} → ${escapeHtml(item.after.state)} · ${escapeHtml(item.before.section || 'Unsectioned')} → ${escapeHtml(item.after.section || 'Unsectioned')} · ${Math.round((item.before.confidence ?? 0) * 100)}% → ${Math.round((item.after.confidence ?? 0) * 100)}%</span>
        </article>
      `).join('')}
    </section>
  `;
}

function renderFilters() {
  const target = document.getElementById('viewFilters');
  if (!target) return;
  const filters = [
    ['visible', 'Visible'],
    ['strong_include', 'Strong'],
    ['weak_include', 'Weak'],
    ['conflict', 'Conflicts'],
    ['needs_review', 'Review'],
  ];
  target.innerHTML = `
    <input id="workspaceSearch" class="workspace-search" type="search" placeholder="Filter" value="${escapeHtml(queryFilter)}">
    ${filters.map(([id, label]) => `<button type="button" class="${stateFilters.includes(id) ? 'active' : ''}" data-state-filter="${id}">${label}</button>`).join('')}
  `;
}

function renderByLayout(layout) {
  if (layout === 'gallery') return renderGallery();
  if (layout === 'map') return renderMap();
  if (layout === 'compact') return renderCompact();
  return renderBoard();
}

function renderBoard() {
  return `
    <div class="board-grid" data-testid="workspace-board">
      ${visibleSections().map(section => `
        <section class="board-column ${state.focusedSectionId === section.id ? 'focused' : ''}" data-section-id="${escapeHtml(section.id)}">
          <header>
            <h4>${escapeHtml(section.title)}</h4>
            <span>${section.visibleCards.length}/${section.totalCount}</span>
          </header>
          <div class="card-stack">
            ${section.visibleCards.map(card => renderCard(card, 'board')).join('')}
          </div>
          ${loadMoreButton(section)}
        </section>
      `).join('')}
    </div>
  `;
}

function renderGallery() {
  const cards = visibleSections().flatMap(section => section.visibleCards.map(card => ({ ...card, sectionTitle: section.title })));
  return `
    <div class="gallery-grid" data-testid="workspace-gallery">
      ${cards.map(card => renderCard(card, 'gallery')).join('')}
    </div>
  `;
}

function renderMap() {
  const sections = visibleSections();
  return `
    <div class="map-layout" data-testid="workspace-map">
      ${sections.map((section, index) => `
        <section class="map-cluster semantic-region" style="--cluster-index:${index}" data-map-section="${escapeHtml(section.id)}">
          <header>
            <button type="button" class="map-node" data-focus-section="${escapeHtml(section.id)}" aria-label="Focus ${escapeHtml(section.title)}"></button>
            <div>
              <h4>${escapeHtml(section.title)}</h4>
              <p class="muted">${section.visibleCards.length} item${section.visibleCards.length === 1 ? '' : 's'} · ${hostSummary(section.visibleCards)}</p>
            </div>
          </header>
          <div class="map-region-stats">
            ${stateSummary(section.visibleCards).map(([label, count]) => `<span>${escapeHtml(label)} ${count}</span>`).join('')}
          </div>
          <div class="map-items">
            ${section.visibleCards.slice(0, 8).map(card => renderCard(card, 'map')).join('')}
          </div>
        </section>
      `).join('')}
    </div>
  `;
}

function renderCompact() {
  const cards = visibleSections().flatMap(section => section.visibleCards.map(card => ({ ...card, sectionTitle: section.title })));
  return `
    <div class="compact-list" data-testid="workspace-compact">
      ${cards.map(card => `
        <button type="button" class="compact-row" data-target-kind="${escapeHtml(card.targetKind)}" data-target-id="${escapeHtml(card.targetId)}">
          <strong>${escapeHtml(card.title)}</strong>
          <span>${escapeHtml(card.sectionTitle)} · ${escapeHtml(card.host)} · ${Math.round(card.confidence * 100)}%</span>
          <em>${escapeHtml(card.state)}</em>
        </button>
      `).join('')}
    </div>
  `;
}

function renderCard(card, variant) {
  const thumbnail = card.media?.thumbnailUrl && state.remoteMedia !== 'off'
    ? `<img src="${escapeHtml(card.media.thumbnailUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="media-fallback">${iconFor(card.visualKind)}</div>`;
  return `
    <button type="button" class="resource-card ${variant} attention-${escapeHtml(card.attention)}" data-target-kind="${escapeHtml(card.targetKind)}" data-target-id="${escapeHtml(card.targetId)}">
      <div class="card-media">${thumbnail}</div>
      <div class="card-body">
        <div class="card-meta">${escapeHtml(card.host)} · ${escapeHtml(humanKind(card.visualKind))} · ${escapeHtml(card.section)}</div>
        <div class="card-title-row">
          <strong>${escapeHtml(card.title)}</strong>
          <span>${Math.round(card.confidence * 100)}%</span>
        </div>
        ${card.userSignal ? `<p class="user-signal">${escapeHtml(card.userSignal)}</p>` : ''}
        ${card.summary ? `<p>${escapeHtml(card.summary)}</p>` : ''}
        <p class="why-line">${escapeHtml(card.reason)}</p>
        <div class="chip-row">
          <span>${escapeHtml(humanState(card.state))}</span>
          <span>${escapeHtml(humanEvidence(card.evidenceStrength))}</span>
          <span>${escapeHtml(card.extractionStatus)}</span>
          ${card.atomicItemCount ? `<span>${card.atomicItemCount} items</span>` : ''}
        </div>
      </div>
    </button>
  `;
}

function visibleSections() {
  if (!workspace) return [];
  return workspace.sections
    .filter(section => !state.focusedSectionId || section.id === state.focusedSectionId)
    .map(section => {
      const cards = sectionPages.get(section.id) ?? section.cards;
      const visibleCards = cards.filter(card => {
        const stateMatches = stateFilters.includes('visible') ? card.state !== 'exclude' : stateFilters.includes(card.state);
        const tagMatches = !tagFilters.length || tagFilters.some(tag => card.chips.map(chip => chip.toLowerCase()).includes(tag.toLowerCase()));
        const queryMatches = !queryFilter || `${card.title} ${card.host} ${card.summary ?? ''} ${card.reason}`.toLowerCase().includes(queryFilter);
        return stateMatches && tagMatches && queryMatches;
      });
      return { ...section, visibleCards };
    })
    .filter(section => section.visibleCards.length || state.focusedSectionId === section.id);
}

async function loadMoreSection(sectionId) {
  if (!workspace || !sectionId) return;
  const current = sectionPages.get(sectionId) ?? [];
  const page = await getJson(`/api/views/${encodeURIComponent(state.activeViewId)}/sections/${encodeURIComponent(sectionId)}?cursor=${current.length}&limit=24`);
  sectionPages.set(sectionId, [...current, ...page.cards]);
  persistSectionPageCounts();
  renderWorkspace();
}

function loadMoreButton(section) {
  const currentCount = (sectionPages.get(section.id) ?? section.cards).length;
  if (currentCount >= section.totalCount) return '';
  return `<button type="button" data-load-section="${escapeHtml(section.id)}">Load more</button>`;
}

function iconFor(kind) {
  const labels = {
    video: '▶',
    article: 'A',
    repository: '{}',
    document: 'Doc',
    search: 'Q',
    atomic_item: '•',
    unknown: '?',
  };
  return escapeHtml(labels[kind] ?? '?');
}

function humanEvidence(value) {
  const labels = {
    user_direct: 'User note',
    user_feedback: 'Prior correction',
    verified_content: 'Verified content',
    generated_analysis: 'AI analysis',
    title_only: 'Title only',
  };
  return labels[value] ?? value;
}

function humanState(value) {
  const labels = {
    strong_include: 'Strong match',
    weak_include: 'Weak match',
    conflict: 'Conflict',
    needs_review: 'Needs review',
    exclude: 'Excluded',
  };
  return labels[value] ?? value;
}

function humanKind(value) {
  const labels = {
    video: 'Video',
    article: 'Article',
    repository: 'Repository',
    document: 'Document',
    search: 'Search',
    atomic_item: 'Atomic item',
    unknown: 'Resource',
  };
  return labels[value] ?? value;
}

function persistWorkspaceFilters() {
  setState({
    workspaceStateFilters: stateFilters.join(','),
    workspaceTagFilters: tagFilters.join(','),
    workspaceQueryFilter: queryFilter,
  });
}

function csvList(value) {
  const items = String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  return items.length ? items : [];
}

function persistSectionPageCounts() {
  const counts = Object.fromEntries([...sectionPages.entries()].map(([sectionId, cards]) => [sectionId, cards.length]));
  setState({ sectionPageCounts: JSON.stringify(counts) });
}

async function restoreSectionPages() {
  if (!workspace) return;
  const counts = parseRecord(state.sectionPageCounts);
  for (const section of workspace.sections) {
    const targetCount = typeof counts[section.id] === 'number' ? counts[section.id] : 0;
    let current = sectionPages.get(section.id) ?? [];
    while (current.length < targetCount && current.length < section.totalCount) {
      const page = await getJson(`/api/views/${encodeURIComponent(state.activeViewId)}/sections/${encodeURIComponent(section.id)}?cursor=${current.length}&limit=24`);
      current = [...current, ...page.cards];
      sectionPages.set(section.id, current);
      if (!page.nextCursor) break;
    }
  }
}

function parseRecord(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function restoreWorkspaceScroll(target) {
  const top = Number(state.workspaceScrollTop || 0);
  if (!Number.isFinite(top) || top <= 0) return;
  requestAnimationFrame(() => { target.scrollTop = top; });
}

function hostSummary(cards) {
  const hosts = [...new Set(cards.map(card => card.host).filter(Boolean))];
  if (!hosts.length) return 'local';
  if (hosts.length === 1) return hosts[0];
  return `${hosts.slice(0, 2).join(', ')} +${hosts.length - 2}`;
}

function stateSummary(cards) {
  const counts = new Map();
  for (const card of cards) counts.set(humanState(card.state), (counts.get(humanState(card.state)) ?? 0) + 1);
  return [...counts.entries()];
}

function renderSignature(current) {
  return [
    current.page,
    current.layout,
    current.focusedSectionId,
    current.remoteMedia,
    current.workspaceStateFilters,
    current.workspaceTagFilters,
    current.workspaceQueryFilter,
  ].join('|');
}
