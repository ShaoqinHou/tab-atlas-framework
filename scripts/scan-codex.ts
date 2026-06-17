import { Command } from 'commander';
import { runCodexResourceScan } from '../src/agent/scanService.js';
import { openDatabase } from '../src/db/index.js';
import { CodexSdkProvider, type CodexSdkProviderConfig } from '../src/llm/CodexSdkProvider.js';

const program = new Command();
program.option('-d, --db <path>', 'SQLite database path');
program.option('--limit <number>', 'Maximum resources to scan', parseInteger, 100);
program.option('--batch-size <number>', 'Resources per Codex batch', parseInteger, 20);
program.option('--resource-id <id...>', 'Specific resource id(s) to scan');
program.option('--reasoning-effort <effort>', 'minimal, low, medium, high, or xhigh', 'medium');
program.option('--force', 'Rescan even when codex_resource_analysis.v1 already exists', false);
program.parse(process.argv);

const opts = program.opts<{
  db?: string;
  limit: number;
  batchSize: number;
  resourceId?: string[];
  reasoningEffort: string;
  force: boolean;
}>();

const reasoningEffort = readReasoningEffort(opts.reasoningEffort);
const db = openDatabase(opts.db);
const provider = new CodexSdkProvider({
  reasoningEffort,
  reuseThread: true,
  workingDirectory: process.cwd(),
});

const result = await runCodexResourceScan(db, provider, {
  limit: opts.limit,
  batchSize: opts.batchSize,
  resourceIds: opts.resourceId ?? [],
  reasoningEffort,
  force: opts.force,
});

console.log(JSON.stringify(result, null, 2));

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected positive integer, got ${value}`);
  return parsed;
}

function readReasoningEffort(value: string): CodexSdkProviderConfig['reasoningEffort'] {
  if (value === 'minimal' || value === 'low' || value === 'high' || value === 'xhigh') return value;
  return 'medium';
}
