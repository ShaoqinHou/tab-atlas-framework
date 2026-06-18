import { SemanticViewPlan, type MembershipState, type ResourceBrief } from '../shared/schemas.js';

type EvidenceChoice = {
  refs: string[];
  source: 'user' | 'system' | 'none';
};

export function planSemanticViewHeuristic(commandText: string, briefs: ResourceBrief[]) {
  const command = commandText.toLowerCase();
  const loose = /\bloose\b|\bwelcome\b|cross-domain|all .*inspiration|mostly/.test(command);
  const game = /\bgame\b|gameplay|mechanic|level design|modding/.test(command);
  const art = !game && /\bart\b|visual|moodboard|illustration|composition/.test(command);
  const viewName = loose
    ? 'Loose inspiration'
    : game
      ? 'Game inspiration'
      : art
        ? 'Art inspiration'
        : 'Semantic view';

  const memberships = briefs.map(brief => classifyBrief(brief, { loose, game, art }));
  const needsReview = memberships
    .filter(membership => membership.state === 'needs_review')
    .map(membership => membership.targetId);

  return SemanticViewPlan.parse({
    commandText,
    views: [{
      name: viewName,
      goal: goalFor({ loose, game, art }),
      description: 'Local deterministic preview used for tests and offline fallback before Codex planning.',
      inclusionRules: inclusionRulesFor({ loose, game, art }),
      exclusionRules: exclusionRulesFor({ loose, game, art }),
      sections: loose ? ['Game-centered inspiration', 'Cross-domain inspiration', 'Needs review'] : [],
      sortPolicy: 'user annotations first, then confidence',
      confidence: 0.7,
      memberships,
    }],
    reviewQueues: needsReview.length
      ? [{
        queueName: 'project_specific',
        reason: 'Some resources have ambiguous evidence for this command.',
        targetIds: needsReview,
      }]
      : [],
    explanation: 'This deterministic preview prioritizes user notes/tags over title and URL evidence.',
  });
}

function classifyBrief(brief: ResourceBrief, intent: { loose: boolean; game: boolean; art: boolean }) {
  const user = userEvidenceText(brief);
  const system = systemEvidenceText(brief);
  const feedback = feedbackEvidenceText(brief);
  const feedbackRefs = feedbackEvidenceRefs(brief);
  const userRefs = userEvidenceRefs(brief);
  const systemRefs = brief.evidence.map(item => item.id);
  const userMentionsInspiration = has(user, ['inspiration', 'moodboard', 'reference', 'idea']);
  const userMentionsGame = has(user, ['game', 'gameplay', 'level', 'mechanic', 'inventory', 'combat', 'modding', 'ui']);
  const userMentionsArt = has(user, ['art', 'visual', 'watercolor', 'moodboard', 'illustration', 'style', 'composition']);
  const systemMentionsGame = has(system, ['game', 'gameplay', 'level design', 'mechanic', 'inventory', 'modding']);
  const systemMentionsArt = has(system, ['art', 'visual', 'watercolor', 'illustration', 'composition', 'environment']);
  const evidence = chooseEvidence(userRefs, systemRefs, userMentionsInspiration || userMentionsGame || userMentionsArt);

  let state: MembershipState = 'exclude';
  let confidence = 0.25;
  let section: string | undefined;
  let reason = 'No evidence connects this resource to the requested view.';
  let conflict: string | undefined;

  if (intent.loose) {
    if (userMentionsInspiration) {
      state = 'strong_include';
      confidence = userMentionsGame || userMentionsArt ? 0.94 : 0.88;
      section = userMentionsGame || systemMentionsGame ? 'Game-centered inspiration' : 'Cross-domain inspiration';
      reason = 'User annotation marks this as inspiration, which loose inspiration welcomes across domains.';
    } else if (systemMentionsGame) {
      state = 'weak_include';
      confidence = 0.68;
      section = 'Game-centered inspiration';
      reason = 'Title or extracted evidence appears game-related, but there is no user annotation yet.';
    } else {
      state = 'needs_review';
      confidence = 0.35;
      section = 'Needs review';
      reason = 'Loose inspiration allows broad matches, but this resource has no user inspiration clue.';
    }
  } else if (intent.game) {
    if (userMentionsGame) {
      state = 'strong_include';
      confidence = 0.96;
      reason = 'User annotation connects this resource to game ideas.';
    } else if (systemMentionsGame) {
      state = 'strong_include';
      confidence = 0.78;
      reason = 'Stored title or extracted evidence is game-related.';
    } else if (systemMentionsArt || userMentionsArt || userMentionsInspiration) {
      state = 'exclude';
      confidence = 0.72;
      reason = 'Strict game inspiration excludes art/design inspiration unless user evidence connects it to games.';
      conflict = userMentionsInspiration ? 'User marked inspiration, but not game-specific inspiration.' : undefined;
    }
  } else if (intent.art) {
    if (userMentionsArt || systemMentionsArt) {
      state = 'strong_include';
      confidence = userMentionsArt ? 0.94 : 0.76;
      reason = userMentionsArt
        ? 'User annotation connects this resource to visual/art inspiration.'
        : 'Title or extracted evidence is art-related.';
    } else if (systemMentionsGame && !userMentionsArt) {
      state = 'exclude';
      confidence = 0.68;
      reason = 'Game-only evidence is excluded from art inspiration without a visual/style user clue.';
    }
  }

  if (feedback.includes('pin include')) {
    state = 'strong_include';
    confidence = 0.98;
    reason = 'User previously pinned this target into a semantic view.';
    conflict = undefined;
  } else if (feedback.includes('pin exclude') || feedback.includes('user reject')) {
    const previousReason = reason;
    state = state === 'strong_include' || state === 'weak_include' ? 'conflict' : 'exclude';
    confidence = 0.96;
    reason = 'User previous feedback says this target should not be included for a similar semantic view.';
    conflict = state === 'conflict' ? previousReason : undefined;
  }

  return {
    targetKind: 'resource' as const,
    targetId: brief.resourceId,
    section,
    state,
    confidence,
    reason,
    evidenceRefs: feedbackRefs.length && (state === 'strong_include' || state === 'conflict' || confidence >= 0.9)
      ? feedbackRefs
      : state === 'exclude' && evidence.source === 'none' ? [] : evidence.refs,
    conflict,
  };
}

function userEvidenceText(brief: ResourceBrief): string {
  return brief.userAnnotations
    .flatMap(annotation => [...annotation.tags, annotation.description ?? '', annotation.decision])
    .join(' ')
    .toLowerCase();
}

function systemEvidenceText(brief: ResourceBrief): string {
  return [
    brief.title ?? '',
    brief.canonicalUrl,
    ...brief.browserGroupTitles,
    ...brief.systemTags,
    ...brief.evidence.map(item => item.text),
  ].join(' ').toLowerCase();
}

function feedbackEvidenceText(brief: ResourceBrief): string {
  return brief.evidence
    .filter(item => item.kind === 'membership_feedback')
    .map(item => item.text)
    .join(' ')
    .toLowerCase();
}

function feedbackEvidenceRefs(brief: ResourceBrief): string[] {
  return brief.evidence
    .filter(item => item.kind === 'membership_feedback')
    .map(item => item.id);
}

function userEvidenceRefs(brief: ResourceBrief): string[] {
  return brief.userAnnotations.flatMap(annotation => annotation.id ? [`user_annotation:${annotation.id}`] : [`user_annotation:${brief.resourceId}`]);
}

function chooseEvidence(userRefs: string[], systemRefs: string[], preferUser: boolean): EvidenceChoice {
  if (preferUser && userRefs.length) return { refs: userRefs, source: 'user' };
  if (systemRefs.length) return { refs: systemRefs.slice(0, 2), source: 'system' };
  return { refs: [], source: 'none' };
}

function has(text: string, needles: string[]): boolean {
  return needles.some(needle => text.includes(needle));
}

function goalFor(intent: { loose: boolean; game: boolean; art: boolean }): string {
  if (intent.loose) return 'Collect game-centered inspiration while welcoming user-marked inspiration from other domains.';
  if (intent.game) return 'Collect resources useful for game ideas, mechanics, UI, modding, level design, or game art direction.';
  if (intent.art) return 'Collect resources useful for visual, art, style, illustration, or moodboard inspiration.';
  return 'Create a flexible semantic lens over the selected resources.';
}

function inclusionRulesFor(intent: { loose: boolean; game: boolean; art: boolean }): string[] {
  if (intent.loose) {
    return [
      'Include all user-marked inspiration.',
      'Prefer game-related inspiration first.',
      'Section non-game inspiration separately as cross-domain inspiration.',
    ];
  }
  if (intent.game) {
    return [
      'Include user notes or tags that connect the resource to games.',
      'Include stored evidence about gameplay, mechanics, UI, modding, level design, or game art direction.',
    ];
  }
  if (intent.art) {
    return [
      'Include user notes or tags that connect the resource to visual/art inspiration.',
      'Include stored evidence about art, visual design, illustration, style, mood, or composition.',
    ];
  }
  return ['Include resources with evidence matching the command.'];
}

function exclusionRulesFor(intent: { loose: boolean; game: boolean; art: boolean }): string[] {
  if (intent.game && !intent.loose) {
    return ['Exclude pure art/design resources unless user evidence connects them to games.'];
  }
  if (intent.art) {
    return ['Exclude game-only resources unless user evidence connects them to visual/style/art inspiration.'];
  }
  return ['Exclude resources without command-relevant evidence unless marked needs_review.'];
}
