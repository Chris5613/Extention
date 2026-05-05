// Options page — configure destination, auto-sync (interval or daily-at-time), and manual token.

const $ = (id) => document.getElementById(id);

const SAMPLE_PAYLOAD = {
  source: 'chrome-extension',
  version: '1.1.0',
  synced_at: '2026-02-19T14:30:00.000Z',
  email: 'you@example.com',
  date: '2026-02-19',
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
    { id: '...', license_id: 'abc123-def456', amount_usd: 0.123, completed_at: '2026-02-19T12:34:56.789Z' }
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
  $('autoSyncDailyTime').value = settings.autoSyncDailyTime || '19:20';
  $('autoSyncTimezone').value = settings.autoSyncTimezone || 'America/Los_Angeles';
  $('manualToken').value = settings.manualToken || '';

  const mode = settings.autoSyncMode || 'daily';
  document.querySelectorAll('input[name="autoSyncMode"]').forEach(r => {
    r.checked = (r.value === mode);
  });
  applyModeUi(mode);
  renderNextSync(settings);

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

function applyModeUi(mode) {
  document.querySelectorAll('.mode-tab').forEach(t => {
    t.classList.toggle('active', t.querySelector('input').value === mode);
  });
  document.querySelectorAll('.mode-panel').forEach(p => {
    p.classList.toggle('active', p.dataset.mode === mode);
  });
}

function renderNextSync(settings) {
  const el = $('next-sync-hint');
  if (!settings.autoSync) {
    el.className = 'next-sync';
    el.textContent = 'Auto-sync is off. Enable it above and click Save Settings.';
    return;
  }
  if (!settings.nextScheduledAt) {
    el.className = 'next-sync';
    el.textContent = 'Next sync not scheduled yet — save settings to schedule it.';
    return;
  }
  const when = new Date(settings.nextScheduledAt);
  const localStr = when.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });
  const ms = when.getTime() - Date.now();
  const hrs = Math.max(0, Math.floor(ms / 3600000));
  const mins = Math.max(0, Math.floor((ms % 3600000) / 60000));
  const inWords = hrs >= 1 ? `in ${hrs}h ${mins}m` : (mins >= 1 ? `in ${mins}m` : 'in <1m');
  el.className = 'next-sync on';
  el.textContent = `Next sync: ${localStr} (${inWords})`;
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
    autoSyncMode: document.querySelector('input[name="autoSyncMode"]:checked')?.value || 'daily',
    autoSyncMinutes: parseInt($('autoSyncMinutes').value, 10) || 60,
    autoSyncDailyTime: $('autoSyncDailyTime').value || '19:20',
    autoSyncTimezone: $('autoSyncTimezone').value || 'America/Los_Angeles',
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

  document.querySelectorAll('input[name="autoSyncMode"]').forEach(r => {
    r.addEventListener('change', (e) => applyModeUi(e.target.value));
  });

  window.addEventListener('focus', loadSettings);
});
