import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const releaseDir = path.join(root, 'release');
const manifestPath = path.join(releaseDir, 'release-manifest.json');

fs.mkdirSync(releaseDir, { recursive: true });
const packages = [
  packageInfo('app', path.join(releaseDir, 'tabatlas-app.zip')),
  packageInfo('extension', path.join(releaseDir, 'tabatlas-extension.zip')),
];

const manifest = {
  schemaVersion: 'tabatlas-release-manifest-v1',
  generatedAt: new Date().toISOString(),
  gitSha: git(['rev-parse', 'HEAD']),
  requirements: {
    node: '20+',
    npm: 'bundled with Node.js',
    codex: 'required for Codex-backed agent and scan features',
    defaultPort: 9787,
  },
  contents: {
    appPackage: 'release/tabatlas-app.zip',
    extensionPackage: 'release/tabatlas-extension.zip',
    installDocs: 'docs/32-release-candidate.md',
    utilityScripts: [
      'scripts/start-tabatlas.ps1',
      'scripts/check-tabatlas.ps1',
      'scripts/backup-tabatlas.ps1',
      'scripts/restore-tabatlas.ps1',
    ],
  },
  packages,
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Release manifest: ${manifestPath}`);

function packageInfo(label: string, filePath: string): {
  label: string;
  path: string;
  exists: boolean;
  sha256?: string;
  bytes?: number;
} {
  if (!fs.existsSync(filePath)) return { label, path: relative(filePath), exists: false };
  const stat = fs.statSync(filePath);
  return {
    label,
    path: relative(filePath),
    exists: true,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    bytes: stat.size,
  };
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function relative(filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, '/');
}
