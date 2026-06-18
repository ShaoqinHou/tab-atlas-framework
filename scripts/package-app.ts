import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'release', 'tabatlas-app');
const zipPath = path.join(root, 'release', 'tabatlas-app.zip');
const entries = [
  'src',
  'knowledge',
  'web-ui',
  'extension',
  'docs',
  'scripts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'eslint.config.js',
  'README.md',
  'AGENTS.md',
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const entry of entries) {
  const from = path.join(root, entry);
  const to = path.join(outDir, entry);
  if (!fs.existsSync(from)) continue;
  const stat = fs.statSync(from);
  if (stat.isDirectory()) fs.cpSync(from, to, { recursive: true, filter: releaseFilter });
  else fs.copyFileSync(from, to);
}
fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'data', '.gitkeep'), '');
writeZip(outDir, zipPath);
console.log(`App package: ${outDir}`);
if (fs.existsSync(zipPath)) console.log(`App zip: ${zipPath}`);

function releaseFilter(source: string): boolean {
  const normalized = source.replace(/\\/g, '/');
  return !normalized.includes('/node_modules/')
    && !normalized.includes('/data/')
    && !normalized.includes('/release/')
    && !normalized.includes('/.local/');
}

function writeZip(sourceDir: string, targetZip: string): void {
  fs.rmSync(targetZip, { force: true });
  if (process.platform !== 'win32') return;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Compress-Archive -Path ${quote(path.join(sourceDir, '*'))} -DestinationPath ${quote(targetZip)} -Force`,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Compress-Archive failed: ${result.stderr || result.stdout}`);
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
