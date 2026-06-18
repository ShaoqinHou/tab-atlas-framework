const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');
const receiverEl = document.getElementById('receiver');
const challengeIdEl = document.getElementById('challengeId');
const secretEl = document.getElementById('secret');

document.getElementById('pair').addEventListener('click', () => pair().catch(showError));
document.getElementById('exportNow').addEventListener('click', () => exportNow().catch(showError));
document.getElementById('unpair').addEventListener('click', () => unpair().catch(showError));
receiverEl.addEventListener('change', () => refreshStatus().catch(showError));

refreshStatus().catch(showError);

async function refreshStatus() {
  const status = await sendMessage({
    type: 'tabatlas:status',
    receiver: receiverEl.value.trim(),
  });
  if (status.receiver) receiverEl.value = status.receiver;
  renderStatus(status);
}

async function pair() {
  setMessage('Pairing...');
  const result = await sendMessage({
    type: 'tabatlas:pair',
    receiver: receiverEl.value.trim(),
    challengeId: challengeIdEl.value.trim(),
    secret: secretEl.value.trim(),
  });
  if (!result.ok) throw new Error(result.error || 'Pairing failed');
  secretEl.value = '';
  setMessage(result.exportedAt ? `Paired and exported at ${result.exportedAt}` : 'Paired.');
  await refreshStatus();
}

async function exportNow() {
  setMessage('Exporting...');
  const result = await sendMessage({
    type: 'tabatlas:export-now',
    receiver: receiverEl.value.trim(),
  });
  if (!result.ok) throw new Error(result.error || 'Export failed');
  setMessage(`Exported ${result.tabCount} tabs at ${result.exportedAt}`);
  await refreshStatus();
}

async function unpair() {
  const result = await sendMessage({ type: 'tabatlas:unpair' });
  if (!result.ok) throw new Error(result.error || 'Unpair failed');
  setMessage('Unpaired locally.');
  await refreshStatus();
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function renderStatus(status) {
  const receiver = status.receiverReachable ? 'reachable' : 'unreachable';
  const paired = status.paired ? 'paired' : 'unpaired';
  statusEl.innerHTML = `
    <span class="badge">${escapeHtml(paired)}</span>
    <div>Receiver: ${escapeHtml(receiver)}</div>
    <div>Browser: ${escapeHtml(status.browser || 'unknown')}</div>
    <div class="muted">Capability: ${escapeHtml(status.capabilityId || '(none)')}</div>
    <div class="muted">Last export: ${escapeHtml(status.lastExportAt || '(never)')}</div>
    ${status.lastError ? `<div class="muted error">${escapeHtml(status.lastError)}</div>` : ''}
  `;
}

function setMessage(message) {
  messageEl.className = 'muted';
  messageEl.textContent = message;
}

function showError(error) {
  messageEl.className = 'muted error';
  messageEl.textContent = error.message || String(error);
  refreshStatus().catch(() => undefined);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
