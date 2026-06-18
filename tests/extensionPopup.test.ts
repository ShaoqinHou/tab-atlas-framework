import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('browser extension popup pairing surface', () => {
  it('exposes the popup through the manifest action', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')) as {
      action?: { default_popup?: string };
      permissions?: string[];
    };

    expect(manifest.action?.default_popup).toBe('popup.html');
    expect(manifest.permissions).toEqual(expect.arrayContaining(['tabs', 'tabGroups', 'storage']));
  });

  it('wires popup controls to service-worker messages', () => {
    const popupHtml = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
    const popupJs = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
    const worker = fs.readFileSync(path.join(root, 'extension', 'service_worker.js'), 'utf8');

    expect(popupHtml).toContain('id="challengeId"');
    expect(popupHtml).toContain('id="secret"');
    for (const message of ['tabatlas:status', 'tabatlas:pair', 'tabatlas:export-now', 'tabatlas:unpair']) {
      expect(popupJs).toContain(message);
      expect(worker).toContain(message);
    }
  });

  it('keeps tokens out of snapshot JSON and sends them only as headers', () => {
    const worker = fs.readFileSync(path.join(root, 'extension', 'service_worker.js'), 'utf8');

    expect(worker).toContain("'x-tab-atlas-token': token");
    expect(worker).not.toContain('token,\\n        browser');
    expect(worker).not.toContain('token: token');
  });
});
