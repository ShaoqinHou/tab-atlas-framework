export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  quotaTurns?: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

export interface LlmTurnOptions {
  system?: string;
  outputSchema?: unknown;
  timeoutMs?: number;
}

export interface LlmProvider {
  complete(prompt: string, opts?: LlmTurnOptions): Promise<LlmResult>;
}
