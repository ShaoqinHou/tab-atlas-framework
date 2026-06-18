import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('workspace dashboard shell', () => {
  it('exposes primary and secondary workspace navigation', () => {
    const html = read('web-ui/index.html');
    const dom = new JSDOM(html);
    const document = dom.window.document;

    const pages = [...document.querySelectorAll('[data-page]')].map(element => element.getAttribute('data-page'));

    expect(pages).toEqual([
      'inbox',
      'ask',
      'views',
      'capture',
      'jobs',
      'security',
      'diagnostics',
    ]);
    for (const page of ['onboarding', ...pages]) {
      expect(document.querySelector(`#page-${page}`)).toBeTruthy();
    }
  });

  it('keeps first-run onboarding and trusted agent landing wired', () => {
    const html = read('web-ui/index.html');

    expect(html).toContain('id="page-onboarding"');
    expect(html).toContain("showPage('ask')");
    expect(html).toContain('/api/onboarding/bootstrap');
  });

  it('uses persistent review sessions and links agent actions into the workspace', () => {
    const html = read('web-ui/index.html');

    expect(html).toContain('/api/review-sessions');
    expect(html).toContain('REVIEW_SESSION_STORAGE_KEY');
    expect(html).toContain('Open review session');
    expect(html).toContain('loadViewPreview');
  });

  it('paginates and filters views client-side', () => {
    const html = read('web-ui/index.html');

    expect(html).toContain('const VIEWS_PER_PAGE = 12');
    expect(html).toContain('id="viewsSearch"');
    expect(html).toContain('id="viewsPrevButton"');
    expect(html).toContain('id="viewsNextButton"');
  });

  it('does not ship machine-specific local paths in shared docs or UI', () => {
    const sharedFiles = [
      'web-ui/index.html',
      'docs/12-implementation-plan.md',
      'docs/24-codex-scan-implementation-report.md',
    ];

    for (const file of sharedFiles) {
      expect(read(file)).not.toMatch(/C:\\Users\\|Downloads\\tab-atlas-framework/);
    }
  });
});

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}
