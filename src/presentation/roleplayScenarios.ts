import { z } from 'zod';

export const RoleplayPersona = z.object({
  id: z.string(),
  name: z.string(),
  mindset: z.string(),
  patience: z.enum(['low', 'medium', 'high']),
  visualPreference: z.enum(['visual_first', 'balanced', 'text_first']),
  trustLevel: z.enum(['skeptical', 'neutral', 'trusting']),
});
export type RoleplayPersona = z.infer<typeof RoleplayPersona>;

export const RoleplayStep = z.object({
  userIntent: z.string(),
  userAction: z.string(),
  expectedVisibleResult: z.string(),
  successSignals: z.array(z.string()),
  failureSignals: z.array(z.string()),
  maxPrimaryClicks: z.number().int().min(0).max(12),
});
export type RoleplayStep = z.infer<typeof RoleplayStep>;

export const WorkspaceRoleplayScenario = z.object({
  id: z.string(),
  title: z.string(),
  persona: RoleplayPersona,
  startingState: z.string(),
  steps: z.array(RoleplayStep).min(1),
  completionQuestion: z.string(),
});
export type WorkspaceRoleplayScenario = z.infer<typeof WorkspaceRoleplayScenario>;

export const workspaceRoleplayScenarios: WorkspaceRoleplayScenario[] = [
  {
    id: 'creative-collector',
    title: 'Find inspiration without reading a giant list',
    persona: {
      id: 'creative-collector',
      name: 'Creative collector',
      mindset: 'I saved these links for a feeling or future idea, not because I remember their titles.',
      patience: 'low',
      visualPreference: 'visual_first',
      trustLevel: 'neutral',
    },
    startingState: '210 resources, many YouTube links, a few user notes, no active view.',
    steps: [
      {
        userIntent: 'Create a loose inspiration space.',
        userAction: 'Ask: Make a loose inspiration board, mainly game inspiration, but include everything I personally marked as inspiration.',
        expectedVisibleResult: 'A board with visual sections, thumbnails, summaries, strong/weak/review counts, and a separate cross-domain section.',
        successSignals: [
          'Result appears beside the conversation, not as raw JSON.',
          'User-marked resources are visually distinguished.',
          'No more than one screen of text is required to understand the view.',
        ],
        failureSignals: [
          'Only a list of titles is shown.',
          'The user must open every item to know why it belongs.',
          'Weak and strong matches look identical.',
        ],
        maxPrimaryClicks: 2,
      },
      {
        userIntent: 'Browse by feeling.',
        userAction: 'Say: Show this as a gallery and focus on visual references.',
        expectedVisibleResult: 'The same view changes presentation without creating a new taxonomy or mutating memberships.',
        successSignals: ['Layout changes immediately.', 'Filters are visible and reversible.'],
        failureSignals: ['A new permanent category is created.', 'The agent explains implementation details instead of changing the presentation.'],
        maxPrimaryClicks: 1,
      },
    ],
    completionQuestion: 'Can I identify five promising links without reading a long list or opening each tab?',
  },
  {
    id: 'project-builder',
    title: 'Build a cross-domain project research space',
    persona: {
      id: 'project-builder',
      name: 'Project builder',
      mindset: 'I need a working set spanning code, UX, privacy, extraction, and installation.',
      patience: 'medium',
      visualPreference: 'balanced',
      trustLevel: 'neutral',
    },
    startingState: 'The library contains browser extension, Codex, SQLite, UI, transcript, and security resources.',
    steps: [
      {
        userIntent: 'Gather project material.',
        userAction: 'Ask: Build a workspace for the tab-manager project and separate architecture, extraction, UX, safety, and packaging.',
        expectedVisibleResult: 'A sectioned project board with mixed resource types and atomic items.',
        successSignals: ['Sections reflect purpose, not domains only.', 'Atomic items can appear independently.', 'Coverage summary explains what was found.'],
        failureSignals: ['Only title-keyword matches appear.', 'All YouTube videos are treated as one undifferentiated type.'],
        maxPrimaryClicks: 2,
      },
      {
        userIntent: 'Inspect one decision deeply.',
        userAction: 'Open a surprising card and inspect Why, Evidence, Notes, and Related.',
        expectedVisibleResult: 'A detail drawer opens without losing board position.',
        successSignals: ['User note is shown before generated analysis.', 'Evidence provenance is understandable.', 'Back/close returns to the same scroll position.'],
        failureSignals: ['The board is replaced by a raw resource page.', 'Evidence is an opaque list of IDs.'],
        maxPrimaryClicks: 1,
      },
    ],
    completionQuestion: 'Can I use this as a working project desk rather than a bookmark folder?',
  },
  {
    id: 'skeptical-curator',
    title: 'Correct the agent and see the consequence',
    persona: {
      id: 'skeptical-curator',
      name: 'Skeptical curator',
      mindset: 'The AI will be wrong sometimes. I need fast correction and visible consequences.',
      patience: 'medium',
      visualPreference: 'balanced',
      trustLevel: 'skeptical',
    },
    startingState: 'A proposed view contains strong, weak, conflicting, and excluded memberships.',
    steps: [
      {
        userIntent: 'Understand a questionable inclusion.',
        userAction: 'Ask Why on one weak or surprising card.',
        expectedVisibleResult: 'A concise evidence trail and confidence explanation.',
        successSignals: ['The UI distinguishes title-only from user or transcript evidence.', 'The explanation is accessible from the card.'],
        failureSignals: ['The explanation is generic.', 'The user cannot tell what evidence was used.'],
        maxPrimaryClicks: 1,
      },
      {
        userIntent: 'Correct it.',
        userAction: 'Pin exclude with a short reason, then ask the agent to refresh the view.',
        expectedVisibleResult: 'The card moves or becomes a visible conflict; the UI explains how the correction will affect future related views.',
        successSignals: ['Correction is granular.', 'Consequence is shown immediately.', 'Unrelated views are not globally changed.'],
        failureSignals: ['The card silently disappears.', 'The correction becomes a universal category rule.'],
        maxPrimaryClicks: 2,
      },
    ],
    completionQuestion: 'Do I feel in control when the agent is wrong?',
  },
  {
    id: 'tab-triage',
    title: 'Quickly review unmarked links',
    persona: {
      id: 'tab-triage',
      name: 'Tab triager',
      mindset: 'I want to process links quickly without learning the app.',
      patience: 'low',
      visualPreference: 'visual_first',
      trustLevel: 'neutral',
    },
    startingState: 'At least 20 unmarked resources are available.',
    steps: [
      {
        userIntent: 'Mark links quickly.',
        userAction: 'Start focused review and process ten resources with keyboard shortcuts.',
        expectedVisibleResult: 'One large resource preview, quick chips, a note field, progress, and three visibly preloaded upcoming cards.',
        successSignals: ['Next card appears immediately.', 'Skip is recoverable.', 'Preview failure does not block annotation.'],
        failureSignals: ['The user sees a dense table.', 'Keyboard action causes accidental navigation.', 'Skipped resources are lost.'],
        maxPrimaryClicks: 1,
      },
    ],
    completionQuestion: 'Can I review a resource in roughly five to ten seconds when the decision is obvious?',
  },
  {
    id: 'returning-user',
    title: 'Resume context after restart',
    persona: {
      id: 'returning-user',
      name: 'Returning user',
      mindset: 'I should not have to reconstruct what I was doing yesterday.',
      patience: 'low',
      visualPreference: 'balanced',
      trustLevel: 'trusting',
    },
    startingState: 'A conversation, proposed view, focused review session, and open inspector already exist.',
    steps: [
      {
        userIntent: 'Continue previous work.',
        userAction: 'Restart TabAtlas and reopen it.',
        expectedVisibleResult: 'The previous conversation and current visual artifact are restored, with review progress available.',
        successSignals: ['The app lands on the last meaningful workspace.', 'A short “since last time” summary is visible.'],
        failureSignals: ['The app lands on diagnostics.', 'The user must find IDs or repeat the command.'],
        maxPrimaryClicks: 1,
      },
    ],
    completionQuestion: 'Does the app feel like a persistent workspace rather than a temporary command runner?',
  },
].map(scenario => WorkspaceRoleplayScenario.parse(scenario));

export function validateRoleplayScenarioCoverage(
  scenarios: WorkspaceRoleplayScenario[] = workspaceRoleplayScenarios,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) errors.push(`duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
    if (!scenario.steps.some(step => step.failureSignals.length > 0)) {
      errors.push(`${scenario.id} has no explicit failure signals`);
    }
  }
  const required = ['creative-collector', 'project-builder', 'skeptical-curator', 'tab-triage', 'returning-user'];
  for (const id of required) {
    if (!ids.has(id)) errors.push(`missing required persona scenario ${id}`);
  }
  return errors;
}
