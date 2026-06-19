import {
  type MembershipState,
  type ResourceBrief,
  type SemanticViewPlan,
} from '../shared/schemas.js';
import {
  CardVisualKind,
  EvidenceStrength,
  PresentationMedia,
  ViewWorkspaceArtifact,
  VisualResourceCard,
  type ViewWorkspaceArtifact as ViewWorkspaceArtifactType,
  type VisualResourceCard as VisualResourceCardType,
} from './contracts.js';

export interface WorkspaceProjectionOptions {
  viewIndex?: number;
  maxCardsPerSection?: number;
  mediaByTarget?: Record<string, PresentationMedia>;
  generatedAt?: string;
}

export function projectSemanticViewWorkspace(
  plan: SemanticViewPlan,
  briefs: ResourceBrief[],
  options: WorkspaceProjectionOptions = {},
): ViewWorkspaceArtifactType {
  const view = plan.views[options.viewIndex ?? 0];
  if (!view) throw new Error('Semantic view plan has no requested view');

  const briefByResource = new Map(briefs.map(brief => [brief.resourceId, brief]));
  const atomicIndex = new Map<string, { brief: ResourceBrief; item: ResourceBrief['atomicItems'][number] }>();
  for (const brief of briefs) {
    for (const item of brief.atomicItems) atomicIndex.set(item.itemId, { brief, item });
  }

  const cards = view.memberships.map(membership => {
    if (membership.targetKind === 'resource') {
      const brief = briefByResource.get(membership.targetId);
      if (!brief) throw new Error(`Missing ResourceBrief for ${membership.targetId}`);
      return resourceCard(brief, membership, options.mediaByTarget?.[membership.targetId]);
    }
    const indexed = atomicIndex.get(membership.targetId);
    if (!indexed) throw new Error(`Missing atomic item ${membership.targetId}`);
    return atomicCard(indexed.brief, indexed.item, membership, options.mediaByTarget?.[membership.targetId]);
  });

  const sectionOrder = [
    ...view.sections,
    ...cards.map(card => card.section).filter(section => !view.sections.includes(section)),
  ].filter((value, index, values) => value && values.indexOf(value) === index);

  const maxCards = options.maxCardsPerSection ?? 24;
  const sections = sectionOrder
    .map(section => {
      const sectionCards = cards
        .filter(card => card.section === section && card.state !== 'exclude')
        .sort(compareCards);
      return {
        id: slug(section),
        title: section,
        totalCount: sectionCards.length,
        visibleCount: Math.min(sectionCards.length, maxCards),
        collapsedByDefault: false,
        cards: sectionCards.slice(0, maxCards),
      };
    })
    .filter(section => section.totalCount > 0);

  const reviewLane = cards
    .filter(card => card.state === 'weak_include' || card.state === 'conflict' || card.state === 'needs_review')
    .sort(compareCards)
    .slice(0, 40);

  const counts = countStates(cards);
  const included = counts.strong_include + counts.weak_include;
  const crossSectionCount = sections.length;

  return ViewWorkspaceArtifact.parse({
    kind: 'semantic_view_workspace',
    viewName: view.name,
    goal: view.goal,
    commandText: plan.commandText,
    layout: 'board',
    headline: `${included} useful matches across ${crossSectionCount} ${crossSectionCount === 1 ? 'section' : 'sections'}`,
    subhead: summarySentence(counts),
    stats: [
      { id: 'strong', label: 'Strong matches', value: counts.strong_include, tone: 'positive' },
      { id: 'weak', label: 'Weak matches', value: counts.weak_include, tone: 'warning' },
      { id: 'conflict', label: 'Conflicts', value: counts.conflict, tone: counts.conflict ? 'danger' : 'neutral' },
      { id: 'review', label: 'Needs review', value: counts.needs_review, tone: counts.needs_review ? 'warning' : 'neutral' },
    ],
    sections,
    reviewLane,
    hiddenExcludedCount: counts.exclude,
    suggestedPrompts: suggestedPrompts(view.name, counts),
    availableLayouts: ['board', 'gallery', 'map', 'compact'],
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
}

function resourceCard(
  brief: ResourceBrief,
  membership: SemanticViewPlan['views'][number]['memberships'][number],
  mediaInput?: PresentationMedia,
): VisualResourceCardType {
  const firstAnnotation = brief.userAnnotations[0];
  const media = mediaInput ?? deriveMedia(brief);
  return VisualResourceCard.parse({
    targetKind: 'resource',
    targetId: brief.resourceId,
    title: brief.title || '(untitled)',
    host: brief.host,
    urlKind: brief.urlKind,
    openUrl: brief.redactedUrl ?? brief.canonicalUrl,
    visualKind: visualKindFor(brief.urlKind),
    media,
    summary: brief.summary,
    userSignal: firstAnnotation?.description || firstAnnotation?.tags.join(', ') || undefined,
    chips: unique([
      ...brief.userAnnotations.flatMap(annotation => annotation.tags),
      ...brief.browserGroupTitles,
      ...brief.systemTags,
    ]).slice(0, 8),
    state: membership.state,
    section: membership.section || defaultSection(membership.state),
    confidence: membership.confidence,
    reason: membership.reason,
    evidenceStrength: evidenceStrengthFor(membership.evidenceRefs, brief),
    evidenceRefs: membership.evidenceRefs,
    extractionStatus: brief.extractionStatus,
    attention: attentionFor(membership.state),
    atomicItemCount: brief.atomicItems.length,
  });
}

function atomicCard(
  brief: ResourceBrief,
  item: ResourceBrief['atomicItems'][number],
  membership: SemanticViewPlan['views'][number]['memberships'][number],
  mediaInput?: PresentationMedia,
): VisualResourceCardType {
  return VisualResourceCard.parse({
    targetKind: 'atomic_item',
    targetId: item.itemId,
    parentResourceId: brief.resourceId,
    title: item.name,
    host: brief.host,
    urlKind: brief.urlKind,
    openUrl: brief.redactedUrl ?? brief.canonicalUrl,
    visualKind: 'atomic_item',
    media: mediaInput ?? deriveMedia(brief),
    summary: item.summary,
    userSignal: brief.userAnnotations[0]?.description,
    chips: unique([
      item.itemKind,
      ...brief.userAnnotations.flatMap(annotation => annotation.tags),
      ...brief.browserGroupTitles,
    ]).slice(0, 8),
    state: membership.state,
    section: membership.section || defaultSection(membership.state),
    confidence: membership.confidence,
    reason: membership.reason,
    evidenceStrength: evidenceStrengthFor(membership.evidenceRefs, brief),
    evidenceRefs: membership.evidenceRefs,
    extractionStatus: brief.extractionStatus,
    attention: attentionFor(membership.state),
    atomicItemCount: 0,
  });
}

function evidenceStrengthFor(refs: string[], brief: ResourceBrief): EvidenceStrength {
  if (refs.some(ref => ref.startsWith('user_annotation:'))) return 'user_direct';
  if (refs.some(ref => ref.startsWith('feedback:'))) return 'user_feedback';

  const referenced = brief.evidence.filter(evidence => refs.includes(evidence.id));
  if (referenced.some(evidence => /(transcript|description|metadata|article|chapter|manual)/i.test(`${evidence.kind} ${evidence.provenance}`))) {
    return 'verified_content';
  }
  if (refs.some(ref => /codex|analysis|planner/i.test(ref))
      || referenced.some(evidence => /codex|analysis/i.test(`${evidence.kind} ${evidence.provenance}`))) {
    return 'generated_analysis';
  }
  return 'title_only';
}

function visualKindFor(urlKind: ResourceBrief['urlKind']): CardVisualKind {
  if (urlKind.startsWith('youtube_')) return 'video';
  if (urlKind.startsWith('github_')) return 'repository';
  if (urlKind === 'docs' || urlKind === 'pdf') return 'document';
  if (urlKind === 'search') return 'search';
  if (urlKind === 'web_page') return 'article';
  return 'unknown';
}

function deriveMedia(brief: ResourceBrief): PresentationMedia | undefined {
  const videoId = youtubeVideoId(brief.canonicalUrl);
  if (!videoId) return undefined;
  return PresentationMedia.parse({
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
    aspectRatio: 16 / 9,
    source: 'youtube',
  });
}

function youtubeVideoId(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.hostname === 'youtu.be') return sanitizeVideoId(url.pathname.slice(1));
    if (url.hostname.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return sanitizeVideoId(url.searchParams.get('v') ?? '');
      const match = url.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
      return sanitizeVideoId(match?.[1] ?? '');
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function sanitizeVideoId(value: string): string | undefined {
  return /^[A-Za-z0-9_-]{6,20}$/.test(value) ? value : undefined;
}

function attentionFor(state: MembershipState): VisualResourceCardType['attention'] {
  if (state === 'conflict') return 'conflict';
  if (state === 'needs_review') return 'review';
  if (state === 'weak_include') return 'weak';
  return 'none';
}

function defaultSection(state: MembershipState): string {
  if (state === 'weak_include') return 'Possible matches';
  if (state === 'conflict') return 'Conflicts';
  if (state === 'needs_review') return 'Needs review';
  if (state === 'exclude') return 'Excluded';
  return 'Main matches';
}

function countStates(cards: VisualResourceCardType[]): Record<MembershipState, number> {
  const counts: Record<MembershipState, number> = {
    strong_include: 0,
    weak_include: 0,
    conflict: 0,
    exclude: 0,
    needs_review: 0,
  };
  for (const card of cards) counts[card.state] += 1;
  return counts;
}

function summarySentence(counts: Record<MembershipState, number>): string {
  const parts = [
    counts.weak_include ? `${counts.weak_include} weak` : '',
    counts.conflict ? `${counts.conflict} conflicting` : '',
    counts.needs_review ? `${counts.needs_review} needing review` : '',
  ].filter(Boolean);
  return parts.length
    ? `${parts.join(', ')}. Excluded resources stay hidden until requested.`
    : 'All visible matches have strong supporting evidence.';
}

function suggestedPrompts(viewName: string, counts: Record<MembershipState, number>): string[] {
  return [
    counts.weak_include ? 'Hide weak matches.' : '',
    counts.conflict ? 'Show only conflicts and explain them.' : '',
    counts.needs_review ? 'Start a quick review of uncertain items.' : '',
    `Split ${viewName} into practical and inspirational sections.`,
    'Show this as a visual gallery.',
  ].filter(Boolean);
}

function compareCards(left: VisualResourceCardType, right: VisualResourceCardType): number {
  return stateRank(left.state) - stateRank(right.state)
    || right.confidence - left.confidence
    || left.title.localeCompare(right.title);
}

function stateRank(state: MembershipState): number {
  switch (state) {
    case 'strong_include': return 0;
    case 'weak_include': return 1;
    case 'conflict': return 2;
    case 'needs_review': return 3;
    case 'exclude': return 4;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'section';
}
