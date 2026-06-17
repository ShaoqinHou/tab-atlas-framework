import type { ZodType } from 'zod';
import type { LlmProvider, LlmTurnOptions, LlmUsage } from './types.js';

export interface RunStructuredOptions<T> extends LlmTurnOptions {
  maxRetries?: number;
  semanticValidate?: (value: T) => string[];
}

export interface RunStructuredResult<T> {
  value: T;
  usage: LlmUsage;
  attempts: number;
}

export class StructuredOutputError extends Error {
  constructor(message: string, public readonly attempts: { raw: string; errors: string[] }[]) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

export async function runStructured<T>(
  provider: LlmProvider,
  prompt: string,
  schema: ZodType<T>,
  opts: RunStructuredOptions<T> = {},
): Promise<RunStructuredResult<T>> {
  const maxRetries = opts.maxRetries ?? 2;
  const attempts: { raw: string; errors: string[] }[] = [];
  const usage: LlmUsage = {};
  let currentPrompt = prompt;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await provider.complete(currentPrompt, opts);
    accumulateUsage(usage, result.usage);
    const raw = result.text;
    const json = extractJson(raw);
    if (json === null) {
      const errors = ['no JSON object found in response'];
      attempts.push({ raw, errors });
      currentPrompt = reaskPrompt(prompt, raw, errors);
      continue;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const errors = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
      attempts.push({ raw, errors });
      currentPrompt = reaskPrompt(prompt, raw, errors);
      continue;
    }
    const semanticErrors = opts.semanticValidate?.(parsed.data) ?? [];
    if (semanticErrors.length) {
      attempts.push({ raw, errors: semanticErrors });
      currentPrompt = reaskPrompt(prompt, raw, semanticErrors);
      continue;
    }
    return { value: parsed.data, usage, attempts: attempts.length + 1 };
  }
  throw new StructuredOutputError(`structured output failed after ${maxRetries + 1} attempts`, attempts);
}

export function extractJson(text: string): unknown | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  candidates.push(text);
  for (const c of candidates) {
    try { return JSON.parse(c.trim()); } catch { /* continue */ }
  }
  return null;
}

function reaskPrompt(original: string, lastRaw: string, errors: string[]): string {
  return [
    original,
    '',
    '--- Your previous response failed validation. ---',
    'Previous response:',
    lastRaw.slice(0, 4000),
    '',
    'Validation errors:',
    ...errors.map(e => `- ${e}`),
    '',
    'Respond again with ONLY corrected JSON.',
  ].join('\n');
}

function accumulateUsage(into: LlmUsage, add: LlmUsage): void {
  if (add.inputTokens) into.inputTokens = (into.inputTokens ?? 0) + add.inputTokens;
  if (add.outputTokens) into.outputTokens = (into.outputTokens ?? 0) + add.outputTokens;
  if (add.quotaTurns) into.quotaTurns = (into.quotaTurns ?? 0) + add.quotaTurns;
}
