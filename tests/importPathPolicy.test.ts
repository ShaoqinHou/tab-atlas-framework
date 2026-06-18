import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importPathPolicyFromEnv, listRecentCaptureFiles, validateImportPath } from '../src/security/importPathPolicy.js';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabatlas-import-policy-'));
  const root = path.join(base, 'captures');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const allowed = path.join(root, 'latest-all.json');
  const tooLarge = path.join(root, 'too-large.json');
  const text = path.join(root, 'notes.txt');
  const outsideJson = path.join(outside, 'secret.json');
  fs.writeFileSync(allowed, '{"tabs":[]}');
  fs.writeFileSync(tooLarge, '{"padding":"' + 'x'.repeat(64) + '"}');
  fs.writeFileSync(text, 'not json');
  fs.writeFileSync(outsideJson, '{"secret":true}');
  return { base, root, outsideJson, allowed, tooLarge, text };
}

describe('import path policy', () => {
  it('allows regular JSON files under configured roots', () => {
    const fx = fixture();
    const policy = { captureRoots: [fx.root], maxImportBytes: 1024 };

    const result = validateImportPath(fx.allowed, policy);

    expect(result.path).toBe(fs.realpathSync(fx.allowed));
    expect(result.size).toBeGreaterThan(0);
    fs.rmSync(fx.base, { recursive: true, force: true });
  });

  it('denies outside roots, non-json files, and oversized files', () => {
    const fx = fixture();
    const policy = { captureRoots: [fx.root], maxImportBytes: 20 };

    expect(() => validateImportPath(fx.outsideJson, policy)).toThrow(/outside configured capture roots/);
    expect(() => validateImportPath(fx.text, { ...policy, maxImportBytes: 1024 })).toThrow(/JSON/);
    expect(() => validateImportPath(fx.tooLarge, policy)).toThrow(/maximum size/);
    fs.rmSync(fx.base, { recursive: true, force: true });
  });

  it('denies symlink escape when symlinks are available', () => {
    const fx = fixture();
    const link = path.join(fx.root, 'linked-secret.json');
    try {
      fs.symlinkSync(fx.outsideJson, link, 'file');
    } catch {
      fs.rmSync(fx.base, { recursive: true, force: true });
      return;
    }

    expect(() => validateImportPath(link, { captureRoots: [fx.root], maxImportBytes: 1024 })).toThrow(/outside configured capture roots/);
    fs.rmSync(fx.base, { recursive: true, force: true });
  });

  it('lists roots and recent capture files from environment policy', () => {
    const fx = fixture();
    const policy = importPathPolicyFromEnv({
      TABATLAS_CAPTURE_ROOTS: fx.root,
      TABATLAS_MAX_IMPORT_BYTES: '1024',
    } as NodeJS.ProcessEnv);

    expect(policy.captureRoots).toEqual([fx.root]);
    expect(listRecentCaptureFiles(policy).map(file => path.basename(file.path))).toContain('latest-all.json');
    fs.rmSync(fx.base, { recursive: true, force: true });
  });
});
