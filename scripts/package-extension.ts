import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'release', 'tabatlas-extension');
const zipPath = path.join(root, 'release', 'tabatlas-extension.zip');
const files = ['manifest.json', 'service_worker.js', 'popup.html', 'popup.js'];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const file of files) {
  fs.copyFileSync(path.join(root, 'extension', file), path.join(outDir, file));
}
writeZip(outDir, zipPath);
console.log(`Extension package: ${outDir}`);
if (fs.existsSync(zipPath)) console.log(`Extension zip: ${zipPath}`);

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
