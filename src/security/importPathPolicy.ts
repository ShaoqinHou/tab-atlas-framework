import fs from 'node:fs';
import path from 'node:path';

export interface ImportPathPolicy {
  captureRoots: string[];
  maxImportBytes: number;
}

export interface ValidatedImportPath {
  path: string;
  size: number;
}

export function importPathPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ImportPathPolicy {
  return {
    captureRoots: parseCaptureRoots(env.TABATLAS_CAPTURE_ROOTS),
    maxImportBytes: readPositiveInteger(env.TABATLAS_MAX_IMPORT_BYTES, 25 * 1024 * 1024),
  };
}

export function validateImportPath(rawPath: string, policy: ImportPathPolicy): ValidatedImportPath {
  if (!rawPath.trim()) throw new Error('file is required');
  if (!policy.captureRoots.length) throw new Error('no capture roots configured');
  const resolvedRoots = policy.captureRoots.map(root => fs.realpathSync(root));
  const resolvedFile = fs.realpathSync(rawPath);
  const root = resolvedRoots.find(candidate => isWithinRoot(resolvedFile, candidate));
  if (!root) throw new Error('import path is outside configured capture roots');
  const stat = fs.statSync(resolvedFile);
  if (!stat.isFile()) throw new Error('import path must be a regular file');
  if (path.extname(resolvedFile).toLowerCase() !== '.json') throw new Error('import path must be a JSON file');
  if (stat.size > policy.maxImportBytes) throw new Error('import file exceeds maximum size');
  return { path: resolvedFile, size: stat.size };
}

export function listCaptureRoots(policy: ImportPathPolicy): string[] {
  return policy.captureRoots.flatMap(root => {
    try {
      return [fs.realpathSync(root)];
    } catch {
      return [];
    }
  });
}

export function listRecentCaptureFiles(policy: ImportPathPolicy, limit = 20): Array<{ path: string; size: number; modifiedAt: string }> {
  const files: Array<{ path: string; size: number; modifiedAt: string }> = [];
  for (const root of listCaptureRoots(policy)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
      const filePath = path.join(root, entry.name);
      const stat = fs.statSync(filePath);
      if (stat.size > policy.maxImportBytes) continue;
      files.push({ path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)).slice(0, limit);
}

function parseCaptureRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isWithinRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
