import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import type { LlmUsage } from '../llm/types.js';

export interface AgentRunInput {
  provider: string;
  purpose: string;
  input: unknown;
  output?: unknown;
  schemaId?: string;
  validationStatus: 'passed' | 'failed' | 'error';
  usage?: LlmUsage;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export function logAgentRun(db: Database.Database, input: AgentRunInput): string {
  const id = `run_${nanoid()}`;
  db.prepare(`
    INSERT INTO agent_runs
      (id, provider, purpose, input_json, output_json, schema_id, validation_status, usage_json, error, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.provider,
    input.purpose,
    JSON.stringify(input.input),
    input.output === undefined ? null : JSON.stringify(input.output),
    input.schemaId ?? null,
    input.validationStatus,
    input.usage ? JSON.stringify(input.usage) : null,
    input.error ?? null,
    input.startedAt,
    input.finishedAt ?? null,
  );
  return id;
}
