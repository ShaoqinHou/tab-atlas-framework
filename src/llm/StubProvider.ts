import type { LlmProvider, LlmResult } from './types.js';

export class StubProvider implements LlmProvider {
  constructor(private readonly response: unknown) {}
  async complete(): Promise<LlmResult> {
    return { text: JSON.stringify(this.response), usage: { quotaTurns: 0 } };
  }
}
