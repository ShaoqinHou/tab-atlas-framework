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
    const conversation = read('web-ui/conversation.js');
    const actions = read('web-ui/presentationActions.js');

    expect(review).toContain('/api/review-sessions');
    expect(review).toContain('REVIEW_SESSION_STORAGE_KEY');
    expect(review).toContain('data-review-decision');
    expect(review).toContain('openReviewSessionSnapshot');
    expect(review).toContain('data-review-visual');
    expect(review).toContain('youtube-nocookie.com/embed');
    expect(review).toContain('review-next-card');
    expect(review).toContain("state.remoteMedia !== 'off'");
    expect(conversation).toContain('handleCompletedActionResults');
    expect(conversation).toContain("kind === 'start_review'");
    expect(conversation).toContain("kind === 'explain_membership'");
    expect(conversation).toContain("kind === 'add_annotation'");
    expect(conversation).toContain("kind === 'scan_resources'");
    expect(conversation).toContain("kind === 'accept_view'");
    expect(actions).toContain('startReviewSession');
    expect(actions).toContain('show_explanation');
    expect(actions).toContain('compare_revisions');
    expect(actions).toContain('resolveRevisionComparison');
  });

  it('guards review shortcuts while editing notes', () => {
    const review = read('web-ui/review.js');

    expect(review).toContain('isEditableTarget(event.target)');
    expect(review).toContain("tag === 'textarea'");
    expect(review).toContain("key === 'enter'");
    expect(review).toContain("key === 'p'");
    expect(review).toContain('data-review-pause');
    expect(review).toContain('Open externally');
    expect(review).toContain('shortcut-legend');
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
    expect(operations).toContain('securityRotationResult');
    expect(operations).toContain('data-save-rotated-token');
    expect(operations).toContain('data-extension-repair');
    expect(operations).toContain('data-ack-rotated-token');
    expect(operations).toContain('Extension rotation requires re-pairing');
    expect(inspector).toContain('/api/membership-feedback');
    expect(inspector).toContain('/api/membership-feedback/${encodeURIComponent(undo.dataset.correctionUndo)}/undo');
    expect(inspector).toContain('pin_include');
    expect(inspector).toContain('pin_exclude');
    expect(inspector).toContain('data-correction-decision="correct"');
    expect(inspector).toContain('correctionMeaning');
    expect(inspector).toContain('correctionSection');
    expect(inspector).toContain('refreshAfterCorrection');
    expect(inspector).toContain('Scope:');
  });

  it('renders view layouts and filters through workspace modules', () => {
    const html = read('web-ui/index.html');
    const workspace = read('web-ui/viewWorkspace.js');
    const state = read('web-ui/state.js');

    expect(html).toContain('data-layout="board"');
    expect(html).toContain('data-layout="gallery"');
    expect(html).toContain('data-layout="map"');
    expect(workspace).toContain('workspaceSearch');
    expect(workspace).toContain('/sections/');
    expect(workspace).toContain('data-map-section');
    expect(workspace).toContain('data-focus-section');
    expect(workspace).toContain('semantic-region');
    expect(workspace).toContain('hostSummary(section.visibleCards)');
    expect(workspace).toContain('persistSectionPageCounts');
    expect(workspace).toContain('restoreWorkspaceScroll');
    expect(state).toContain('workspaceStateFilters');
    expect(state).toContain('workspaceQueryFilter');
    expect(state).toContain('workspaceScrollTop');
    expect(state).toContain('assistantPanel');
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
    expect(workspace).toContain('restore-summary');
    expect(inspector).toContain('data-close-inspector');
    expect(inspector).toContain('role="tab"');
    expect(inspector).toContain('role="tabpanel"');
    expect(inspector).toContain('data-related-view');
    expect(inspector).toContain('data-parent-resource');
    expect(inspector).toContain('selectedTargetKind');
    expect(inspector).toContain('inspectorTab');
    expect(inspector).toContain('showPanel(state.assistantPanel');
  });

  it('ships the role-play workspace UX evaluation gate', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const evalScript = read('scripts/eval-workspace-ux.ts');

    expect(pkg.scripts['eval:workspace-ux']).toBe('tsx scripts/eval-workspace-ux.ts');
    expect(evalScript).toContain('workspaceRoleplayScenarios');
    expect(evalScript).toContain("roleplay('creative-collector')");
    expect(evalScript).toContain("roleplay('project-builder')");
    expect(evalScript).toContain("roleplay('skeptical-curator')");
    expect(evalScript).toContain("roleplay('tab-triage')");
    expect(evalScript).toContain("roleplay('returning-user')");
    expect(evalScript).toContain('TABATLAS_FAKE_CODEX_PROVIDER');
    expect(evalScript).toContain('large-workspace-${size}');
    expect(evalScript).toContain('axeAccessibilityCheck');
    expect(evalScript).toContain("axeAccessibilityCheck(page, 'ask-conversation')");
    expect(evalScript).toContain("axeAccessibilityCheck(page, 'board-gallery-map')");
    expect(evalScript).toContain("axeAccessibilityCheck(page, 'inspector')");
    expect(evalScript).toContain("axeAccessibilityCheck(page, 'review')");
    expect(evalScript).toContain("axeAccessibilityCheck(page, 'operations')");
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
