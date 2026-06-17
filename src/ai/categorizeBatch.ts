import { CategorizeBatchOutput, type ResourceBrief } from '../shared/schemas.js';
import type { LlmProvider } from '../llm/types.js';
import { runStructured } from '../llm/runStructured.js';
import fs from 'node:fs/promises';

export async function categorizeBatch(provider: LlmProvider, briefs: ResourceBrief[]) {
  const system = await fs.readFile(new URL('../../knowledge/prompts/categorize-batch.system.md', import.meta.url), 'utf8');
  const prompt = [
    'Categorize these TabAtlas resources. Use evidence IDs. Output JSON only.',
    '',
    JSON.stringify({ resources: briefs }, null, 2),
  ].join('\n');

  return runStructured(provider, prompt, CategorizeBatchOutput, {
    system,
    maxRetries: 2,
    semanticValidate: (value) => {
      const ids = new Set(briefs.map(b => b.resourceId));
      const errors: string[] = [];
      for (const m of value.memberships) {
        if (!ids.has(m.resourceId)) errors.push(`membership references unknown resourceId ${m.resourceId}`);
        if (m.evidenceRefs.length === 0) errors.push(`membership for ${m.resourceId} has no evidenceRefs`);
      }
      return errors;
    },
  });
}
