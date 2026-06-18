import fs from 'node:fs';
import { runPrivateLibraryCommand, type PrivateLibraryMode } from './private-library-acceptance-common.js';

const args = parseArgs(process.argv.slice(2));
if (!args.commandId || !args.resultFile) {
  console.error('Usage: tsx scripts/private-library-command-worker.ts --command <id> --mode <codex|heuristic> --result-file <path>');
  process.exit(1);
}

try {
  const smoke = await runPrivateLibraryCommand(args.commandId, args.mode);
  fs.writeFileSync(args.resultFile, JSON.stringify(smoke, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}

function parseArgs(raw: string[]): {
  commandId?: string;
  resultFile?: string;
  mode: PrivateLibraryMode;
} {
  const parsed: { commandId?: string; resultFile?: string; mode: PrivateLibraryMode } = { mode: 'codex' };
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index];
    if (arg === '--command') parsed.commandId = raw[++index];
    else if (arg === '--result-file') parsed.resultFile = raw[++index];
    else if (arg === '--mode') {
      const value = raw[++index];
      if (value !== 'codex' && value !== 'heuristic') throw new Error(`Unsupported mode: ${value}`);
      parsed.mode = value;
    }
  }
  return parsed;
}
