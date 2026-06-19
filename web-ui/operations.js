import { getJson, postJson, saveToken } from './api.js';
import { escapeHtml } from './shell.js';
import { state } from './state.js';

let refreshViews = null;
let refreshWorkspace = null;

export function initOperations({ onRefreshViews, onRefreshWorkspace } = {}) {
  refreshViews = onRefreshViews;
  refreshWorkspace = onRefreshWorkspace;
  document.getElementById('importButton')?.addEventListener('click', importSnapshotFile);
  document.getElementById('createPairingButton')?.addEventListener('click', createPairingChallenge);
  document.getElementById('runExtractionButton')?.addEventListener('click', runExtraction);
  document.getElementById('createExtractionJobButton')?.addEventListener('click', () => createJob('/api/jobs/extraction'));
  document.getElementById('createScanJobButton')?.addEventListener('click', () => createJob('/api/jobs/codex-scan'));
  document.getElementById('refreshJobsButton')?.addEventListener('click', refreshJobs);
  document.getElementById('acceptViewButton')?.addEventListener('click', acceptActiveView);
  document.getElementById('refineViewButton')?.addEventListener('click', refineActiveView);
  document.getElementById('jobsList')?.addEventListener('click', handleJobAction);
  document.getElementById('settings-security')?.addEventListener('click', handleSecurityAction);
  refreshOperations();
}

export async function refreshOperations() {
  await Promise.allSettled([
    refreshCaptureStatus(),
    refreshJobs(),
    refreshSecurity(),
    refreshViewOps(),
  ]);
}

async function importSnapshotFile() {
  const file = document.getElementById('capturePath')?.value.trim() ?? '';
  const result = await postJson('/api/import-file', { file });
  writeJson('captureStatus', result);
  await refreshViews?.();
}

async function createPairingChallenge() {
  const browser = document.getElementById('pairingBrowser')?.value || 'chrome';
  const result = await postJson('/api/security/pairing-codes', { browser, label: `${browser} extension` });
  writeJson('captureStatus', result);
  await refreshSecurity();
}

async function runExtraction() {
  const result = await postJson('/api/extract/run', {});
  writeJson('captureStatus', result);
  await refreshCaptureStatus();
}

async function createJob(path) {
  const result = await postJson(path, {});
  writeJson('captureStatus', result);
  await refreshJobs();
}

async function acceptActiveView() {
  if (!state.activeViewId) return writeText('viewOpsStatus', 'Choose a view first.');
  const result = await postJson(`/api/views/${encodeURIComponent(state.activeViewId)}/apply`, { mode: 'accepted' });
  writeJson('viewOpsStatus', result);
  await refreshViews?.(state.activeViewId);
  await refreshWorkspace?.(state.activeViewId);
}

async function refineActiveView() {
  const text = document.getElementById('refineText')?.value.trim() ?? '';
  if (!state.activeViewId || !text) return writeText('viewOpsStatus', 'Choose a view and enter a refinement.');
  const result = await postJson('/api/agent/refine', { viewId: state.activeViewId, text });
  writeJson('viewOpsStatus', result);
  await refreshViews?.(state.activeViewId);
  await refreshWorkspace?.(state.activeViewId);
}

async function refreshCaptureStatus() {
  try {
    const [security, status] = await Promise.all([
      getJson('/api/security/status'),
      getJson('/api/status'),
    ]);
    const roots = (security.captureRoots ?? []).map(root => `<li>${escapeHtml(root)}</li>`).join('') || '<li>No capture roots configured.</li>';
    const recent = (security.recentCaptureFiles ?? []).map(file => `<li>${escapeHtml(file)}</li>`).join('') || '<li>No recent capture files.</li>';
    document.getElementById('captureStatus').innerHTML = `
      <div class="ops-grid">
        <div><strong>${status.resources}</strong><span>resources</span></div>
        <div><strong>${status.codexScanArtifacts}</strong><span>scan artifacts</span></div>
        <div><strong>${status.atomicItems}</strong><span>atomic items</span></div>
      </div>
      <h4>Capture roots</h4><ul>${roots}</ul>
      <h4>Recent files</h4><ul>${recent}</ul>
    `;
  } catch (error) {
    writeText('captureStatus', `Capture status unavailable: ${error.message}`);
  }
}

async function refreshJobs() {
  try {
    const jobs = await getJson('/api/jobs');
    const rows = Array.isArray(jobs) ? jobs : jobs.jobs ?? [];
    document.getElementById('jobsList').innerHTML = rows.map(job => `
      <article class="ops-row">
        <strong>${escapeHtml(job.kind || job.id)}</strong>
        <span>${escapeHtml(job.status)} · ${job.progress?.completed ?? 0}/${job.progress?.total ?? job.progress?.pending ?? 0}</span>
        <div class="action-row">
          <button type="button" data-job-action="resume" data-job-id="${escapeHtml(job.id)}">Resume</button>
          <button type="button" data-job-action="retry" data-job-id="${escapeHtml(job.id)}">Retry failed</button>
          <button type="button" data-job-action="cancel" data-job-id="${escapeHtml(job.id)}">Cancel</button>
        </div>
      </article>
    `).join('') || '<p class="muted">No jobs.</p>';
  } catch (error) {
    writeText('jobsList', `Jobs unavailable: ${error.message}`);
  }
}

async function refreshSecurity() {
  try {
    const security = await getJson('/api/security/status');
    const panel = document.getElementById('settings-security');
    const existing = panel.querySelector('#securityStatus') ?? document.createElement('div');
    existing.id = 'securityStatus';
    existing.className = 'list-surface';
    existing.innerHTML = `
      <p class="muted">Prompt privacy: URLs and sensitive text are redacted before provider prompts where supported.</p>
      <h4>Capabilities</h4>
      ${(security.capabilities ?? []).map(capability => `
        <article class="ops-row">
          <strong>${escapeHtml(capability.label || capability.kind)}</strong>
          <span>${escapeHtml(capability.status)} · ${escapeHtml(capability.kind)} · ${capability.scopes.map(escapeHtml).join(', ')}</span>
          <div class="action-row">
            <button type="button" data-capability-action="rotate" data-capability-id="${escapeHtml(capability.id)}" data-capability-kind="${escapeHtml(capability.kind)}">Rotate</button>
            <button type="button" data-capability-action="revoke" data-capability-id="${escapeHtml(capability.id)}">Revoke</button>
          </div>
        </article>
      `).join('') || '<p class="muted">No capabilities.</p>'}
      <div id="securityRotationResult" class="rotation-result"></div>
      <h4>Extension trust</h4>
      <p class="muted">${(security.pairingChallenges ?? []).length} active or historical pairing challenges.</p>
    `;
    panel.appendChild(existing);
  } catch {
    // Security panel can stay minimal before authentication.
  }
}

async function refreshViewOps() {
  if (!state.activeViewId) return writeText('viewOpsStatus', 'Choose a view to inspect revisions.');
  try {
    const [preview, revisions] = await Promise.all([
      getJson(`/api/views/${encodeURIComponent(state.activeViewId)}/preview`),
      getJson(`/api/views/${encodeURIComponent(state.activeViewId)}/revisions`),
    ]);
    document.getElementById('viewOpsStatus').innerHTML = `
      <p><strong>${escapeHtml(preview.name)}</strong> · ${escapeHtml(preview.status)}</p>
      <h4>Revisions</h4>
      ${revisions.map(revision => `
        <article class="ops-row">
          <strong>Revision ${revision.revisionNumber}</strong>
          <span>${escapeHtml(revision.status)}</span>
          <div class="action-row">
            <button type="button" data-revision-accept="${escapeHtml(revision.id)}">Accept</button>
            <button type="button" data-revision-reject="${escapeHtml(revision.id)}">Reject</button>
          </div>
        </article>
      `).join('') || '<p class="muted">No revisions.</p>'}
    `;
    document.getElementById('viewOpsStatus').querySelectorAll('[data-revision-accept]').forEach(button => {
      button.addEventListener('click', () => updateRevision(button.dataset.revisionAccept, 'accept'));
    });
    document.getElementById('viewOpsStatus').querySelectorAll('[data-revision-reject]').forEach(button => {
      button.addEventListener('click', () => updateRevision(button.dataset.revisionReject, 'reject'));
    });
  } catch (error) {
    writeText('viewOpsStatus', `View operations unavailable: ${error.message}`);
  }
}

async function updateRevision(revisionId, action) {
  await postJson(`/api/views/${encodeURIComponent(state.activeViewId)}/revisions/${encodeURIComponent(revisionId)}/${action}`, {});
  await refreshViewOps();
  await refreshViews?.(state.activeViewId);
  await refreshWorkspace?.(state.activeViewId);
}

async function handleJobAction(event) {
  const button = event.target.closest('[data-job-action]');
  if (!button) return;
  const action = button.dataset.jobAction;
  const jobId = button.dataset.jobId;
  if (action === 'resume') await postJson(`/api/jobs/${encodeURIComponent(jobId)}/resume`, {});
  if (action === 'retry') await postJson(`/api/jobs/${encodeURIComponent(jobId)}/retry-failed`, {});
  if (action === 'cancel') await postJson(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  await refreshJobs();
}

async function handleSecurityAction(event) {
  const copy = event.target.closest('[data-copy-token]');
  if (copy) {
    await navigator.clipboard?.writeText(copy.dataset.copyToken);
    copy.textContent = 'Copied';
    return;
  }
  const save = event.target.closest('[data-save-rotated-token]');
  if (save) {
    saveToken(save.dataset.saveRotatedToken || '');
    await refreshSecurity();
    writeSecurityRotation('Stored the rotated dashboard token in this browser. Refresh succeeded with the replacement credential.');
    return;
  }
  if (event.target.closest('[data-ack-rotated-token]')) {
    writeSecurityRotation('Rotated token acknowledged. TabAtlas did not store it.');
    return;
  }
  const repair = event.target.closest('[data-extension-repair]');
  if (repair) {
    await postJson(`/api/security/capabilities/${encodeURIComponent(repair.dataset.extensionRepair)}/revoke`, {});
    const result = await postJson('/api/security/pairing-codes', { browser: 'extension', label: 'Re-paired extension' });
    await refreshSecurity();
    writeSecurityRotation(`Extension capability revoked. Re-pair using challenge ${result.challenge?.id || result.challengeId || 'created'}; the old extension token will not work.`);
    return;
  }
  const button = event.target.closest('[data-capability-action]');
  if (!button) return;
  const action = button.dataset.capabilityAction;
  const id = button.dataset.capabilityId;
  const kind = button.dataset.capabilityKind;
  if (action === 'rotate' && kind === 'extension') {
    writeSecurityRotation(`
      <strong>Extension rotation requires re-pairing.</strong>
      <p>TabAtlas cannot push a new token into an installed extension. Revoke this capability and create a new pairing challenge instead.</p>
      <button type="button" data-extension-repair="${escapeHtml(id)}">Revoke and re-pair</button>
    `, true);
    return;
  }
  const result = await postJson(`/api/security/capabilities/${encodeURIComponent(id)}/${action}`, {});
  if (action === 'rotate') {
    writeRotatedCapability(result);
    return;
  }
  await refreshSecurity();
}

function writeRotatedCapability(result) {
  const capability = result.capability ?? {};
  const token = result.token ?? '';
  const dashboardAction = capability.kind === 'ui'
    ? `<button type="button" data-save-rotated-token="${escapeHtml(token)}">Replace stored dashboard token</button>`
    : '';
  writeSecurityRotation(`
    <strong>New ${escapeHtml(capability.kind || 'capability')} token. Save it now.</strong>
    <p>Losing this token can lock out the dashboard or automation that used the old credential.</p>
    <code class="one-time-token">${escapeHtml(token)}</code>
    <div class="action-row">
      <button type="button" data-copy-token="${escapeHtml(token)}">Copy token</button>
      ${dashboardAction}
      <button type="button" data-ack-rotated-token>Acknowledge</button>
    </div>
  `, true);
}

function writeSecurityRotation(value, html = false) {
  const target = document.getElementById('securityRotationResult');
  if (!target) return;
  if (html) target.innerHTML = value;
  else target.textContent = value;
}

function writeJson(id, value) {
  writeText(id, JSON.stringify(value, null, 2));
}

function writeText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}
