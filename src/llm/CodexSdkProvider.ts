import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import type { LlmProvider, LlmResult, LlmTurnOptions } from './types.js';

export interface CodexSdkProviderConfig {
  model?: string;
  workingDirectory?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  reuseThread?: boolean;
  timeoutMs?: number;
}

export class CodexSdkProvider implements LlmProvider {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: CodexSdkProviderConfig = {}) {}

  get threadId(): string | null {
    return this.thread?.id ?? null;
  }

  complete(prompt: string, opts?: LlmTurnOptions): Promise<LlmResult> {
    const run = this.chain.then(() => this.doComplete(prompt, opts));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doComplete(prompt: string, opts?: LlmTurnOptions): Promise<LlmResult> {
    this.codex ??= new Codex();
    const threadOptions: ThreadOptions = {
      model: this.cfg.model ?? 'gpt-5.5',
      sandboxMode: 'read-only',
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      webSearchMode: 'disabled',
      modelReasoningEffort: this.cfg.reasoningEffort ?? 'medium',
      ...(this.cfg.workingDirectory ? { workingDirectory: this.cfg.workingDirectory } : {}),
    };

    const thread = this.cfg.reuseThread && this.thread ? this.thread : this.codex.startThread(threadOptions);
    this.thread = thread;

    const fullPrompt = opts?.system ? `${opts.system}\n\n---\n\n${prompt}` : prompt;
    const controller = new AbortController();
    const turn = await withTimeout(
      thread.run(fullPrompt, {
        ...(opts?.outputSchema ? { outputSchema: opts.outputSchema } : {}),
        signal: controller.signal,
      }),
      opts?.timeoutMs ?? this.cfg.timeoutMs ?? 120_000,
      () => controller.abort(),
    );
    return {
      text: turn.finalResponse ?? '',
      usage: {
        inputTokens: turn.usage?.input_tokens,
        outputTokens: turn.usage?.output_tokens,
        quotaTurns: 1,
      },
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Codex turn timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
