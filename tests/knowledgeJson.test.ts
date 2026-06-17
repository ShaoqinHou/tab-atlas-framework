import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function listJsonFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsonFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.json') ? [fullPath] : [];
  });
}

describe('knowledge JSON files', () => {
  it('parse as valid JSON', () => {
    const files = listJsonFiles(path.join(process.cwd(), 'knowledge'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(() => JSON.parse(fs.readFileSync(file, 'utf8')), file).not.toThrow();
    }
  });
});
