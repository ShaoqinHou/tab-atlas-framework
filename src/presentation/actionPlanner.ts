import {
  AgentPresentationPlan,
  assertPresentationActionsNonDestructive,
  type PresentationAction,
  type ViewWorkspaceArtifact,
  type VisualResourceCard,
  type WorkspaceLayout,
} from './contracts.js';
import type { MembershipState } from '../shared/schemas.js';

export interface PresentationActionContext {
  activeViewId?: string;
  workspace?: ViewWorkspaceArtifact;
}

export function planPresentationActionsFromText(
  commandText: string,
  context: PresentationActionContext = {},
): AgentPresentationPlan {
  const command = commandText.trim();
  const normalized = command.toLowerCase();
  const actions: PresentationAction[] = [];
  const workspace = context.workspace;
  const activeViewId = context.activeViewId;

  const layout = requestedLayout(normalized);
  if (layout) actions.push({ kind: 'set_layout', layout });

  const section = workspace ? requestedSection(normalized, workspace) : undefined;
  if (section) actions.push({ kind: 'focus_section', sectionId: section.id });

  const states = requestedStates(normalized);
  if (states.length) actions.push({ kind: 'set_filters', states, tags: [], query: '' });

  if (activeViewId && /\b(review|check|triage)\b/.test(normalized) && /\b(uncertain|weak|conflict|needs review|questionable)\b/.test(normalized)) {
    actions.push({ kind: 'open_review', queue: states.includes('conflict') ? 'conflict' : 'needs_review', sourceViewId: activeViewId });
  }

  const openTarget = workspace ? requestedOpenTarget(normalized, workspace) : undefined;
  if (openTarget) {
    actions.push({
      kind: 'open_resource',
      targetKind: openTarget.targetKind,
      targetId: openTarget.targetId,
      inspectorTab: /\bevidence|why|proof|explain/.test(normalized) ? 'evidence' : 'overview',
    });
  }

  if (activeViewId && /\b(show|open|switch)\b/.test(normalized) && /\bview|workspace\b/.test(normalized) && !actions.some(action => action.kind === 'show_view')) {
    actions.unshift({ kind: 'show_view', viewId: activeViewId });
  }

  assertPresentationActionsNonDestructive(actions);
  return AgentPresentationPlan.parse({
    reply: actions.length ? replyFor(actions, workspace) : 'I need a view or a more specific workspace action.',
    actions,
  });
}

function requestedLayout(command: string): WorkspaceLayout | undefined {
  for (const layout of ['board', 'gallery', 'map', 'compact'] as const) {
    if (new RegExp(`\\b${layout}\\b`).test(command)) return layout;
  }
  if (/\bgrid\b|\bimages\b|\bvisual\b/.test(command)) return 'gallery';
  if (/\bcluster|clusters|source map|hosts?\b/.test(command)) return 'map';
  if (/\blist\b|\bdense\b|\bscan\b/.test(command)) return 'compact';
  return undefined;
}

function requestedStates(command: string): MembershipState[] {
  const states: MembershipState[] = [];
  if (/\bconflicts?\b|\bcontradict/.test(command)) states.push('conflict');
  if (/\bweak\b|\bloose\b|\bmaybe\b|\bpossible\b/.test(command)) states.push('weak_include');
  if (/\bneeds review\b|\buncertain\b|\breview\b/.test(command)) states.push('needs_review');
  if (/\bstrong\b|\bbest\b|\bhigh confidence\b/.test(command)) states.push('strong_include');
  return [...new Set(states)];
}

function requestedSection(command: string, workspace: ViewWorkspaceArtifact): ViewWorkspaceArtifact['sections'][number] | undefined {
  const focusMatch = command.match(/\b(?:focus|open|show)\s+(?:the\s+)?(.+?)(?:\s+section|\s+lane|\s+column|$)/);
  const requested = focusMatch?.[1]?.trim();
  return workspace.sections.find(section => {
    const title = section.title.toLowerCase();
    return command.includes(title) || Boolean(requested && title.includes(requested));
  });
}

function requestedOpenTarget(command: string, workspace: ViewWorkspaceArtifact): VisualResourceCard | undefined {
  const cards = workspace.sections.flatMap(section => section.cards);
  if (!cards.length) return undefined;
  if (/\bstrongest|best|top\b/.test(command)) {
    return cards
      .filter(card => card.state === 'strong_include')
      .sort((left, right) => right.confidence - left.confidence)[0] ?? cards.sort((left, right) => right.confidence - left.confidence)[0];
  }
  if (/\bweakest|uncertain|questionable\b/.test(command)) {
    return cards
      .filter(card => card.state === 'weak_include' || card.state === 'needs_review')
      .sort((left, right) => left.confidence - right.confidence)[0];
  }
  if (/\bconflict\b/.test(command)) return cards.find(card => card.state === 'conflict');
  return cards.find(card => command.includes(card.title.toLowerCase().slice(0, 32)));
}

function replyFor(actions: PresentationAction[], workspace?: ViewWorkspaceArtifact): string {
  const labels = actions.map(action => {
    if (action.kind === 'set_layout') return `switch to ${action.layout}`;
    if (action.kind === 'focus_section') {
      const section = workspace?.sections.find(item => item.id === action.sectionId);
      return `focus ${section?.title ?? action.sectionId}`;
    }
    if (action.kind === 'set_filters') return `filter ${action.states.join(', ')}`;
    if (action.kind === 'open_resource') return `open ${action.targetKind}`;
    if (action.kind === 'open_review') return `open ${action.queue} review`;
    if (action.kind === 'show_view') return 'show the active view';
    return action.kind;
  });
  return labels.length ? `I will ${labels.join(', ')}.` : 'Done.';
}
