// Options page — configure destination, auto-sync, and manual token.

const $ = (id) => document.getElementById(id);

const SAMPLE_PAYLOAD = {
  source: 'chrome-extension',
  version: '1.0.0',
  synced_at: '2025-02-19T14:30:00.000Z',
  email: 'you@example.com',
  date: '2025-02-19',
  total_usd: 1.234567,
  allocation_count: 12,
  device_count: 3,
  balance_usd: 4.825001,
  lifetime_usd: 152.834012,
  devices: [
    { license_id: 'abc123-def456', amount_usd: 0.456000, allocation_count: 4 },
    { license_id: 'xyz789-ghi012', amount_usd: 0.778567, allocation_count: 8 }
  ],
  allocations: [
    { id: '...', license_id: 'abc123-def456', amount_usd: 0.123, completed_at: '2025-02-19T12:34:56.789Z' }
  ]
};

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!res?.ok) return;
  const { settings, hasAutoToken, hasManualToken } = res;

  $('destinationUrl').value = settings.destinationUrl || '';
  $('authHeaderName').value = settings.authHeaderName || 'Authorization';
  $('authHeaderValue').value = settings.authHeaderValue || '';
  $('autoSync').checked = !!settings.autoSync;
  $('autoSyncMinutes').value = String(settings.autoSyncMinutes || 60);
  $('manualToken').value = settings.manualToken || '';

  // Token status
  const ts = $('token-status');
  if (hasManualToken) {
    ts.className = 'token-status manual';
    ts.textContent = `Using manual token override${settings.detectedEmail ? ' (' + settings.detectedEmail + ')' : ''}.`;
  } else if (hasAutoToken) {
    ts.className = 'token-status auto';
    ts.textContent = `Auto-detected token from manage.unitynodes.io${settings.detectedEmail ? ' — signed in as ' + settings.detectedEmail : ''}.`;
  } else {
    ts.className = 'token-status missing';
    ts.textContent = 'No token found. Open https://manage.unitynodes.io and sign in, or paste a token below.';
  }
}

async function save() {
  const saveMsg = $('save-msg');
  const btn = $('save-btn');
  btn.disabled = true;
  saveMsg.className = 'save-msg';
  saveMsg.textContent = 'Saving…';

  const patch = {
    destinationUrl: $('destinationUrl').value.trim(),
    authHeaderName: $('authHeaderName').value.trim() || 'Authorization',
    authHeaderValue: $('authHeaderValue').value.trim(),
    autoSync: $('autoSync').checked,
    autoSyncMinutes: parseInt($('autoSyncMinutes').value, 10) || 60,
    manualToken: $('manualToken').value.trim()
  };

  await chrome.storage.local.set(patch);
  await chrome.runtime.sendMessage({ type: 'RESCHEDULE_ALARM' });

  btn.disabled = false;
  saveMsg.className = 'save-msg saved';
  saveMsg.textContent = 'Saved ✓';
  setTimeout(() => { saveMsg.textContent = ''; saveMsg.className = 'save-msg'; }, 2500);

  await loadSettings();
}

async function testPing() {
  const btn = $('test-btn');
  const status = $('test-status');

  // Save destination first so test uses current values
  await chrome.storage.local.set({
    destinationUrl: $('destinationUrl').value.trim(),
    authHeaderName: $('authHeaderName').value.trim() || 'Authorization',
    authHeaderValue: $('authHeaderValue').value.trim()
  });

  btn.disabled = true;
  status.className = 'test-status';
  status.textContent = 'Sending…';

  const res = await chrome.runtime.sendMessage({ type: 'TEST_DESTINATION' });
  btn.disabled = false;

  if (res?.ok) {
    status.className = 'test-status ok';
    status.textContent = `✓ Received ${res.result?.status || 200}`;
  } else {
    status.className = 'test-status err';
    status.textContent = `✕ ${res?.error || 'Failed'}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('sample-payload').textContent = JSON.stringify(SAMPLE_PAYLOAD, null, 2);
  loadSettings();

  $('save-btn').addEventListener('click', save);
  $('test-btn').addEventListener('click', testPing);

  // Auto-refresh token status when the options tab regains focus
  window.addEventListener('focus', loadSettings);
});
