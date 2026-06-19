import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import type { LlmProvider, LlmResult, LlmTurnOptions } from './types.js';

export interface CodexSdkProviderConfig {
  model?: string;
  workingDirectory?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  reuseThread?: boolean;
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
    const turn = await thread.run(fullPrompt, opts?.outputSchema ? { outputSchema: opts.outputSchema } : undefined);
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
