import { postJson } from './api.js';
import { openInspector } from './inspector.js';
import { focusWorkspaceSection, getCurrentWorkspace, refreshViewWorkspace, setWorkspaceFilter } from './viewWorkspace.js';
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
      setWorkspaceFilter(action.states?.[0] ?? 'visible');
      setState({ page: 'views' });
    } else if (action.kind === 'open_resource') {
      await openInspector(action.targetKind, action.targetId, {
        tab: action.inspectorTab,
        viewId: state.activeViewId,
      });
    } else if (action.kind === 'open_review') {
      setState({ page: 'review' });
    }
  }
  return true;
}

export function hasActiveWorkspace() {
  return Boolean(getCurrentWorkspace() && state.activeViewId);
}
