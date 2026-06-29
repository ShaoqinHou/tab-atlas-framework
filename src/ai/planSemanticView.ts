import { SemanticViewPlan, type ResourceBrief } from '../shared/schemas.js';
import type { LlmProvider } from '../llm/types.js';
import { runStructured } from '../llm/runStructured.js';
import { projectResourceBriefsForPrompt, redactSensitiveText } from '../security/urlPrivacy.js';
import fs from 'node:fs/promises';
import { repairSemanticViewPlanCandidate, semanticViewPlanJsonContract } from './semanticViewPlanRepair.js';

export interface PlanSemanticViewOptions {
  maxViews?: number;
  allowWeakMatches?: boolean;
  askReviewForAmbiguous?: boolean;
}

export async function planSemanticView(
  provider: LlmProvider,
  commandText: string,
  briefs: ResourceBrief[],
  options: PlanSemanticViewOptions = {},
) {
  const system = await fs.readFile(new URL('../../knowledge/prompts/semantic-view-planner.system.md', import.meta.url), 'utf8');
  const prompt = [
    'Plan semantic TabAtlas views for this user command. Use only the supplied resource briefs.',
    '',
    `Command: ${redactSensitiveText(commandText)}`,
    '',
    'Options:',
    JSON.stringify({
      maxViews: options.maxViews ?? 4,
      allowWeakMatches: options.allowWeakMatches ?? true,
      askReviewForAmbiguous: options.askReviewForAmbiguous ?? true,
    }, null, 2),
    '',
    semanticViewPlanJsonContract(),
    '',
    'Resource briefs. User annotations are primary evidence:',
    JSON.stringify({ resources: projectResourceBriefsForPrompt(briefs) }, null, 2),
  ].join('\n');

  const targetIds = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const brief of briefs) {
    targetIds.add(brief.resourceId);
    for (const item of brief.atomicItems ?? []) targetIds.add(item.itemId);
    for (const ev of brief.evidence ?? []) evidenceIds.add(ev.id);
    for (const ann of brief.userAnnotations ?? []) {
      if (ann.id) evidenceIds.add(`user_annotation:${ann.id}`);
      evidenceIds.add(`user_annotation:${brief.resourceId}`);
    }
  }

  return runStructured(provider, prompt, SemanticViewPlan, {
    system,
    maxRetries: 2,
    repair: value => repairSemanticViewPlanCandidate(commandText, value),
    semanticValidate: (value) => {
      const errors: string[] = [];
      if (value.commandText.trim().length === 0) errors.push('commandText is empty');
      for (const view of value.views) {
        if (view.inclusionRules.length === 0) errors.push(`view ${view.name} has no inclusionRules`);
        for (const m of view.memberships) {
          if (!targetIds.has(m.targetId)) errors.push(`membership references unknown targetId ${m.targetId}`);
          if (m.state !== 'exclude' && m.evidenceRefs.length === 0) {
            errors.push(`membership for ${m.targetId} has no evidenceRefs`);
          }
          for (const ref of m.evidenceRefs) {
            // Permit planner-level synthetic refs but catch obvious typos when refs look like artifact IDs.
            if ((ref.startsWith('ev_') || ref.startsWith('user_annotation:')) && !evidenceIds.has(ref)) {
              errors.push(`membership for ${m.targetId} references unknown evidence ${ref}`);
            }
          }
        }
      }
      for (const queue of value.reviewQueues) {
        for (const targetId of queue.targetIds) {
          if (!targetIds.has(targetId)) errors.push(`review queue ${queue.queueName} references unknown targetId ${targetId}`);
        }
      }
      return errors;
    },
  });
}
