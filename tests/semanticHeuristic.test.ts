import { describe, expect, it } from 'vitest';
import { planSemanticViewHeuristic } from '../src/ai/heuristicSemanticView.js';
import type { ResourceBrief } from '../src/shared/schemas.js';

function brief(overrides: Partial<ResourceBrief> & Pick<ResourceBrief, 'resourceId' | 'title'>): ResourceBrief {
  return {
    resourceId: overrides.resourceId,
    canonicalUrl: overrides.canonicalUrl ?? `https://example.com/${overrides.resourceId}`,
    redactedUrl: overrides.redactedUrl ?? `https://example.com/${overrides.resourceId}`,
    urlKind: overrides.urlKind ?? 'web_page',
    host: overrides.host ?? 'example.com',
    title: overrides.title,
    browserGroupTitles: overrides.browserGroupTitles ?? [],
    userAnnotations: overrides.userAnnotations ?? [],
    systemTags: overrides.systemTags ?? [],
    summary: overrides.summary,
    atomicItems: overrides.atomicItems ?? [],
    extractionStatus: overrides.extractionStatus ?? 'metadata_only',
    evidence: overrides.evidence ?? [{
      id: `ev_${overrides.resourceId}`,
      kind: 'title',
      text: overrides.title ?? '',
      provenance: 'fixture',
      confidence: 0.45,
    }],
  };
}

describe('semantic view heuristic', () => {
  it('lets a user note make a misleading-title resource match game inspiration', () => {
    const plan = planSemanticViewHeuristic('Make a strict game inspiration group', [
      brief({
        resourceId: 'res_watercolor',
        title: 'Beautiful watercolor environments',
        userAnnotations: [{
          id: 'ann_1',
          targetKind: 'resource',
          targetId: 'res_watercolor',
          tags: ['inspiration'],
          description: 'Forest level moodboard for game art direction.',
          decision: 'inspiration',
          source: 'focused_review',
          createdAt: '2026-06-17T00:00:00.000Z',
        }],
      }),
    ]);

    const membership = plan.views[0].memberships[0];
    expect(membership.state).toBe('strong_include');
    expect(membership.evidenceRefs).toContain('user_annotation:ann_1');
  });

  it('excludes unrelated art from strict game inspiration without user game evidence', () => {
    const plan = planSemanticViewHeuristic('Make a strict game inspiration group', [
      brief({
        resourceId: 'res_art',
        title: 'Beautiful watercolor environments',
        userAnnotations: [{
          id: 'ann_art',
          targetKind: 'resource',
          targetId: 'res_art',
          tags: ['inspiration'],
          description: 'Pretty art study.',
          decision: 'inspiration',
          source: 'focused_review',
          createdAt: '2026-06-17T00:00:00.000Z',
        }],
      }),
    ]);

    expect(plan.views[0].memberships[0].state).toBe('exclude');
    expect(plan.views[0].memberships[0].reason).toContain('Strict game inspiration excludes');
  });

  it('includes cross-domain user-marked inspiration in loose inspiration', () => {
    const plan = planSemanticViewHeuristic('Make a loose group mainly game inspiration but welcome all other inspiration', [
      brief({
        resourceId: 'res_music',
        title: 'Ambient album for concentration',
        userAnnotations: [{
          id: 'ann_music',
          targetKind: 'resource',
          targetId: 'res_music',
          tags: ['inspiration', 'music'],
          description: 'Atmosphere idea for later.',
          decision: 'inspiration',
          source: 'focused_review',
          createdAt: '2026-06-17T00:00:00.000Z',
        }],
      }),
    ]);

    const membership = plan.views[0].memberships[0];
    expect(membership.state).toBe('strong_include');
    expect(membership.section).toBe('Cross-domain inspiration');
  });
});
