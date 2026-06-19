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
    expect(document.querySelectorAll('[data-settings-panel]')).toHaveLength(5);
  });

  it('keeps first-run onboarding and trusted agent landing wired', () => {
    const html = read('web-ui/index.html');
    const shell = read('web-ui/shell.js');
    const conversation = read('web-ui/conversation.js');

    expect(html).toContain('id="settings-onboarding"');
    expect(html).toContain('id="conversationForm"');
    expect(shell).toContain('/api/onboarding/bootstrap');
    expect(conversation).toContain('/api/conversations');
    expect(conversation).toContain('/messages');
    expect(conversation).toContain('content,');
    expect(conversation).not.toContain('/api/agent/command');
    expect(conversation).not.toContain("mode: 'heuristic'");
  });

  it('uses persistent review sessions and links agent actions into the workspace', () => {
    const review = read('web-ui/review.js');
    const actions = read('web-ui/presentationActions.js');

    expect(review).toContain('/api/review-sessions');
    expect(review).toContain('REVIEW_SESSION_STORAGE_KEY');
    expect(review).toContain('data-review-decision');
    expect(actions).toContain('startReviewSession');
  });

  it('restores secondary operations and correction controls', () => {
    const html = read('web-ui/index.html');
    const operations = read('web-ui/operations.js');
    const inspector = read('web-ui/inspector.js');

    expect(html).toContain('id="createPairingButton"');
    expect(html).toContain('id="runExtractionButton"');
    expect(html).toContain('id="createScanJobButton"');
    expect(html).toContain('id="acceptViewButton"');
    expect(operations).toContain('/api/security/pairing-codes');
    expect(operations).toContain('/api/import-file');
    expect(operations).toContain('/api/extract/run');
    expect(operations).toContain('/api/jobs/codex-scan');
    expect(operations).toContain('/api/jobs/${encodeURIComponent(jobId)}/retry-failed');
    expect(operations).toContain('/api/views/${encodeURIComponent(state.activeViewId)}/apply');
    expect(inspector).toContain('/api/membership-feedback');
    expect(inspector).toContain('pin_include');
    expect(inspector).toContain('pin_exclude');
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

  it('renders human workspace cards and inspector controls', () => {
    const workspace = read('web-ui/viewWorkspace.js');
    const inspector = read('web-ui/inspector.js');

    expect(workspace).toContain('user-signal');
    expect(workspace).toContain('why-line');
    expect(workspace).toContain('User note');
    expect(workspace).toContain('referrerpolicy="no-referrer"');
    expect(workspace).toContain('data-suggested-prompt');
    expect(workspace).toContain('requestSubmit');
    expect(inspector).toContain('data-close-inspector');
    expect(inspector).toContain('role="tab"');
    expect(inspector).toContain('role="tabpanel"');
    expect(inspector).toContain('data-related-view');
    expect(inspector).toContain('data-parent-resource');
  });

  it('ships the role-play workspace UX evaluation gate', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const evalScript = read('scripts/eval-workspace-ux.ts');

    expect(pkg.scripts['eval:workspace-ux']).toBe('tsx scripts/eval-workspace-ux.ts');
    expect(evalScript).toContain('workspaceRoleplayScenarios');
    expect(evalScript).toContain('large_workspace_budget');
    expect(evalScript).toContain('lightweightAccessibilityCheck');
  });

  it('does not ship machine-specific local paths in shared docs or UI', () => {
    const sharedFiles = [
      'web-ui/index.html',
      'web-ui/review.js',
      'web-ui/operations.js',
      'scripts/eval-workspace-ux.ts',
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
