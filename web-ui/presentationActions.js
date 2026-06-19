import { getJson, postJson } from './api.js';
import { openInspector } from './inspector.js';
import { startReviewSession } from './review.js';
import { focusWorkspaceSection, getCurrentWorkspace, refreshViewWorkspace, setWorkspaceFilter, showRevisionComparison, showWorkspaceNotice } from './viewWorkspace.js';
import { setState, state } from './state.js';

export async function requestPresentationPlan(command) {
  return postJson('/api/presentation/actions', {
    command,
    activeViewId: state.activeViewId,
  });
}

export async function executePresentationPlan(plan) {
  if (!plan?.actions?.length) return false;
  for (const action of plan.actions) {
    if (action.kind === 'show_view') {
      setState({ activeViewId: action.viewId, page: 'views' });
      await refreshViewWorkspace(action.viewId);
    } else if (action.kind === 'set_layout') {
      setState({ layout: action.layout, page: 'views' });
    } else if (action.kind === 'focus_section') {
      focusWorkspaceSection(action.sectionId);
      setState({ page: 'views' });
    } else if (action.kind === 'set_filters') {
      setWorkspaceFilter({ states: action.states ?? [], tags: action.tags ?? [], query: action.query ?? '' });
      setState({ page: 'views' });
    } else if (action.kind === 'open_resource') {
      await openInspector(action.targetKind, action.targetId, {
        tab: action.inspectorTab,
        viewId: state.activeViewId,
      });
    } else if (action.kind === 'open_review') {
      await startReviewSession(action.queue, { sourceViewId: action.sourceViewId });
    } else if (action.kind === 'show_explanation') {
      await openInspector(action.targetKind, action.targetId, {
        tab: 'evidence',
        viewId: action.viewId,
      });
      if (action.targetKind === 'resource') {
        const result = await getJson(`/api/resources/${encodeURIComponent(action.targetId)}/explain?viewId=${encodeURIComponent(action.viewId)}`);
        showWorkspaceNotice(result.explanation ?? 'Explanation opened in the inspector.');
      } else {
        showWorkspaceNotice('Atomic item evidence opened in the inspector.');
      }
    } else if (action.kind === 'compare_revisions') {
      const comparison = await resolveRevisionComparison(action);
      if (typeof comparison === 'string') showWorkspaceNotice(comparison);
      else showRevisionComparison(comparison);
    }
  }
  return true;
}

async function resolveRevisionComparison(action) {
  const revisions = await getJson(`/api/views/${encodeURIComponent(action.viewId)}/revisions`);
  const left = action.leftRevisionId === 'latest' ? revisions[0]?.id : action.leftRevisionId;
  const right = action.rightRevisionId === 'previous' ? revisions[1]?.id : action.rightRevisionId;
  if (!left || !right) return 'Revision comparison is unavailable until this view has at least two revisions.';
  return getJson(`/api/views/${encodeURIComponent(action.viewId)}/revisions/${encodeURIComponent(left)}/compare?otherRevisionId=${encodeURIComponent(right)}`);
}

export function hasActiveWorkspace() {
  return Boolean(getCurrentWorkspace() && state.activeViewId);
}
