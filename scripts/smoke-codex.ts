import { z } from 'zod';
import { CodexSdkProvider } from '../src/llm/CodexSdkProvider.js';
import { runStructured } from '../src/llm/runStructured.js';

const Smoke = z.object({
  ok: z.boolean(),
  label: z.string(),
});

const provider = new CodexSdkProvider({ reasoningEffort: 'low' });
const result = await runStructured(
  provider,
  'Return exactly this JSON with ok true and label "tabatlas-smoke".',
  Smoke,
  {
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, label: { type: 'string' } },
      required: ['ok', 'label'],
      additionalProperties: false,
    },
    semanticValidate: v => v.ok && v.label === 'tabatlas-smoke' ? [] : ['expected ok=true and label=tabatlas-smoke'],
  },
);

console.log(JSON.stringify({ attempts: result.attempts, usage: result.usage, value: result.value }, null, 2));
