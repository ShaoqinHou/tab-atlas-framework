import fs from 'node:fs';
import { Command } from 'commander';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';

const program = new Command();
program.requiredOption('-f, --file <path>', 'Path to latest-all.json');
program.option('-d, --db <path>', 'SQLite database path');
program.parse(process.argv);

const opts = program.opts<{ file: string; db?: string }>();
const json = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
const db = openDatabase(opts.db);
const result = importSnapshot(db, json, 'manual_import');
console.log(JSON.stringify(result, null, 2));
