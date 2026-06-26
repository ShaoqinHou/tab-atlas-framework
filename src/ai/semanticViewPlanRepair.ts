const SEMANTIC_VIEW_PLAN_JSON_CONTRACT = `Return exactly one JSON object with this shape:
{
  "commandText": string,
  "views": [{
    "name": string,
    "goal": string,
    "description": string optional,
    "inclusionRules": string[],
    "exclusionRules": string[],
    "sections": string[],
    "sortPolicy": string optional,
    "confidence": number between 0 and 1,
    "memberships": [{
      "targetKind": "resource" | "atomic_item",
      "targetId": string,
      "section": string optional, never null,
      "state": "strong_include" | "weak_include" | "conflict" | "exclude" | "needs_review",
      "confidence": number between 0 and 1,
      "reason": string,
      "evidenceRefs": string[],
      "conflict": string optional
    }]
  }],
  "reviewQueues": [{"queueName": string, "reason": string, "targetIds": string[]}],
  "explanation": string
}
Use name, not title or viewId. Use sections as an array of strings, not objects. Use evidenceRefs, not evidenceIds.`;

export function semanticViewPlanJsonContract(): string {
  return SEMANTIC_VIEW_PLAN_JSON_CONTRACT;
}

export function repairSemanticViewPlanCandidate(commandText: string, candidate: unknown): unknown {
  if (!isRecord(candidate)) return candidate;
  const repaired: Record<string, unknown> = { ...candidate };
  if (!readString(repaired.commandText)) repaired.commandText = commandText;
  if (!readString(repaired.explanation)) {
    repaired.explanation = 'Planner used the supplied evidence to create the requested semantic view plan.';
  }

  const rawViews = Array.isArray(repaired.views)
    ? repaired.views
    : Array.isArray(repaired.viewSpecs)
      ? repaired.viewSpecs
      : Array.isArray(repaired.semanticViews)
        ? repaired.semanticViews
        : undefined;
  if (rawViews) repaired.views = rawViews.map(view => repairView(commandText, view));

  const rawReviewQueues = Array.isArray(repaired.reviewQueues)
    ? repaired.reviewQueues
    : Array.isArray(repaired.reviewQueue)
      ? repaired.reviewQueue
      : undefined;
  if (rawReviewQueues) {
    repaired.reviewQueues = rawReviewQueues
      .map(repairReviewQueue)
      .filter((queue): queue is Record<string, unknown> => Boolean(queue));
  }

  return repaired;
}

function repairView(commandText: string, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const repaired: Record<string, unknown> = { ...value };
  const name = readString(repaired.name)
    ?? readString(repaired.title)
    ?? readString(repaired.viewName)
    ?? readString(repaired.viewId)
    ?? 'Semantic view';
  repaired.name = name;
  if (!readString(repaired.goal)) {
    repaired.goal = readString(repaired.description) ?? `Satisfy the user command: ${commandText}`;
  }
  const inclusionRules = readStringArray(repaired.inclusionRules)
    ?? readStringArray(readRecord(repaired.rules)?.include)
    ?? readStringArray(readRecord(repaired.rules)?.inclusion)
    ?? [`Include resources matching: ${commandText}`];
  repaired.inclusionRules = inclusionRules.length ? inclusionRules : [`Include resources matching: ${commandText}`];
  const exclusionRules = readStringArray(repaired.exclusionRules)
    ?? readStringArray(readRecord(repaired.rules)?.exclude)
    ?? readStringArray(readRecord(repaired.rules)?.exclusion)
    ?? [];
  repaired.exclusionRules = exclusionRules;
  repaired.sections = repairSections(repaired.sections);
  repaired.confidence = readConfidence(repaired.confidence) ?? 0.5;
  if (Array.isArray(repaired.memberships)) {
    repaired.memberships = repaired.memberships.map(repairMembership);
  }
  return repaired;
}

function repairMembership(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const repaired: Record<string, unknown> = { ...value };
  const targetId = readString(repaired.targetId)
    ?? readString(repaired.resourceId)
    ?? readString(repaired.itemId)
    ?? readString(repaired.id);
  if (targetId) repaired.targetId = targetId;

  const targetKind = readString(repaired.targetKind);
  if (targetKind !== 'resource' && targetKind !== 'atomic_item') {
    repaired.targetKind = readString(repaired.itemId) ? 'atomic_item' : 'resource';
  }

  const section = readString(repaired.section)
    ?? readString(readRecord(repaired.section)?.name)
    ?? readString(readRecord(repaired.section)?.title);
  if (section) repaired.section = section;
  else delete repaired.section;

  const state = normalizeMembershipState(readString(repaired.state));
  if (state) repaired.state = state;

  repaired.confidence = readConfidence(repaired.confidence) ?? 0.5;
  repaired.reason = readString(repaired.reason) ?? readString(repaired.rationale) ?? '';

  const evidenceRefs = readStringArray(repaired.evidenceRefs)
    ?? readStringArray(repaired.evidenceIds)
    ?? readStringArray(repaired.evidence_refs)
    ?? [];
  repaired.evidenceRefs = evidenceRefs;
  return repaired;
}

function repairReviewQueue(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const targetIds = readStringArray(value.targetIds)
    ?? readStringArray(value.resourceIds)
    ?? readStringArray(value.ids)
    ?? [];
  return {
    ...value,
    queueName: readString(value.queueName) ?? readString(value.name) ?? 'needs_review',
    reason: readString(value.reason) ?? readString(value.question) ?? 'Review ambiguous targets before accepting.',
    targetIds,
  };
}

function repairSections(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .map(section => {
      if (typeof section === 'string') return section;
      if (!isRecord(section)) return undefined;
      return readString(section.name)
        ?? readString(section.title)
        ?? readString(section.sectionId)
        ?? readString(section.id);
    })
    .filter((section): section is string => Boolean(section)));
}

function normalizeMembershipState(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (['strong_include', 'weak_include', 'conflict', 'exclude', 'needs_review'].includes(normalized)) {
    return normalized;
  }
  if (normalized === 'include' || normalized === 'included' || normalized === 'strong') return 'strong_include';
  if (normalized === 'weak' || normalized === 'maybe') return 'weak_include';
  if (normalized === 'excluded') return 'exclude';
  if (normalized === 'review' || normalized === 'needsreview' || normalized === 'ambiguous') return 'needs_review';
  return value;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return [value];
  if (!Array.isArray(value)) return undefined;
  return uniqueStrings(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0));
}

function readConfidence(value: unknown): number | undefined {
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(numberValue) ? Math.min(1, Math.max(0, numberValue)) : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
