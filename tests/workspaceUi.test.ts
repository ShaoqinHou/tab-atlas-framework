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

    expect(pages).toEqual(['ask', 'views', 'review', 'settings']);
    for (const page of pages) {
      expect(document.querySelector(`#page-${page}`)).toBeTruthy();
    }
    expect(document.querySelector('[data-testid="secondary-nav"]')).toBeTruthy();
    expect(document.querySelectorAll('[data-settings-panel]')).toHaveLength(4);
  });

  it('keeps first-run onboarding and trusted agent landing wired', () => {
    const html = read('web-ui/index.html');
    const shell = read('web-ui/shell.js');

    expect(html).toContain('id="settings-onboarding"');
    expect(html).toContain('id="conversationForm"');
    expect(shell).toContain('/api/onboarding/bootstrap');
  });

  it('uses persistent review sessions and links agent actions into the workspace', () => {
    const review = read('web-ui/review.js');
    const actions = read('web-ui/presentationActions.js');

    expect(review).toContain('/api/review-sessions');
    expect(review).toContain('REVIEW_SESSION_STORAGE_KEY');
    expect(review).toContain('data-review-decision');
    expect(actions).toContain('startReviewSession');
  });

  it('renders view layouts and filters through workspace modules', () => {
    const html = read('web-ui/index.html');
    const workspace = read('web-ui/viewWorkspace.js');

    expect(html).toContain('data-layout="board"');
    expect(html).toContain('data-layout="gallery"');
    expect(html).toContain('data-layout="map"');
    expect(workspace).toContain('workspaceSearch');
    expect(workspace).toContain('/sections/');
  });

  it('does not ship machine-specific local paths in shared docs or UI', () => {
    const sharedFiles = [
      'web-ui/index.html',
      'web-ui/review.js',
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
