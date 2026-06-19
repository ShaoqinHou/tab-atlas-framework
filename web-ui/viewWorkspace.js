import { getJson } from './api.js';
import { openInspector } from './inspector.js';
import { escapeHtml } from './shell.js';
import { setState, state, subscribe } from './state.js';

let workspace = null;
let sectionPages = new Map();
let stateFilter = 'visible';
let queryFilter = '';

export function initViewWorkspace() {
  document.getElementById('viewFilters')?.addEventListener('click', event => {
    const button = event.target.closest('[data-state-filter]');
    if (!button) return;
    stateFilter = button.dataset.stateFilter;
    renderWorkspace();
  });

  document.getElementById('viewFilters')?.addEventListener('input', event => {
    if (event.target.id === 'workspaceSearch') {
      queryFilter = event.target.value.trim().toLowerCase();
      renderWorkspace();
    }
  });

  document.getElementById('viewWorkspace')?.addEventListener('click', async event => {
    const cardButton = event.target.closest('[data-target-kind][data-target-id]');
    if (cardButton) {
      await openInspector(cardButton.dataset.targetKind, cardButton.dataset.targetId, { viewId: state.activeViewId });
      return;
    }
    const loadMore = event.target.closest('[data-load-section]');
    if (loadMore) await loadMoreSection(loadMore.dataset.loadSection);
  });

  subscribe(() => {
    if (workspace) renderWorkspace();
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
  renderWorkspace();
}

export function getCurrentWorkspace() {
  return workspace;
}

export function focusWorkspaceSection(sectionId) {
  setState({ focusedSectionId: sectionId });
}

export function setWorkspaceFilter(filter) {
  stateFilter = filter || 'visible';
  renderWorkspace();
}

function renderWorkspace() {
  renderFilters();
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
    ${workspace.hiddenExcludedCount ? `<details class="excluded-notice"><summary>${workspace.hiddenExcludedCount} excluded hidden</summary><p>Excluded items stay out of the main workspace until explicitly requested.</p></details>` : ''}
    ${renderByLayout(state.layout)}
    <footer class="prompt-row">
      ${workspace.suggestedPrompts.map(prompt => `<button type="button" data-suggested-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`).join('')}
    </footer>
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
    ${filters.map(([id, label]) => `<button type="button" class="${stateFilter === id ? 'active' : ''}" data-state-filter="${id}">${label}</button>`).join('')}
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
  const hosts = new Map();
  for (const section of visibleSections()) {
    for (const card of section.visibleCards) {
      const host = card.host || 'local';
      if (!hosts.has(host)) hosts.set(host, []);
      hosts.get(host).push(card);
    }
  }
  return `
    <div class="map-layout" data-testid="workspace-map">
      ${[...hosts.entries()].map(([host, cards], index) => `
        <section class="map-cluster" style="--cluster-index:${index}">
          <header>
            <span class="map-node"></span>
            <div>
              <h4>${escapeHtml(host)}</h4>
              <p class="muted">${cards.length} item${cards.length === 1 ? '' : 's'}</p>
            </div>
          </header>
          <div class="map-items">
            ${cards.slice(0, 8).map(card => renderCard(card, 'map')).join('')}
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
  const thumbnail = card.media?.thumbnailUrl
    ? `<img src="${escapeHtml(card.media.thumbnailUrl)}" alt="">`
    : `<div class="media-fallback">${iconFor(card.visualKind)}</div>`;
  return `
    <button type="button" class="resource-card ${variant} attention-${escapeHtml(card.attention)}" data-target-kind="${escapeHtml(card.targetKind)}" data-target-id="${escapeHtml(card.targetId)}">
      <div class="card-media">${thumbnail}</div>
      <div class="card-body">
        <div class="card-title-row">
          <strong>${escapeHtml(card.title)}</strong>
          <span>${Math.round(card.confidence * 100)}%</span>
        </div>
        <p>${escapeHtml(card.summary || card.reason)}</p>
        <div class="chip-row">
          <span>${escapeHtml(card.state)}</span>
          <span>${escapeHtml(card.evidenceStrength)}</span>
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
        const stateMatches = stateFilter === 'visible' ? card.state !== 'exclude' : card.state === stateFilter;
        const queryMatches = !queryFilter || `${card.title} ${card.host} ${card.summary ?? ''} ${card.reason}`.toLowerCase().includes(queryFilter);
        return stateMatches && queryMatches;
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
