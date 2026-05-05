// Options page — multi-account configure, destination, auto-sync.

const $ = (id) => document.getElementById(id);

const SAMPLE_PAYLOAD = {
  source: 'chrome-extension',
  version: '1.2.0',
  synced_at: '2026-02-19T14:30:00.000Z',
  date: '2026-02-19',
  account_count: 2,
  failed_account_count: 0,
  grand_total_usd: 2.834000,
  grand_lifetime_usd: 304.512000,
  grand_balance_usd: 7.825001,
  accounts: [
    {
      account_id: 'sub-uuid-1',
      email: 'main@example.com',
      label: 'Main',
      date: '2026-02-19',
      total_usd: 1.234567,
      allocation_count: 12,
      device_count: 3,
      balance_usd: 4.825001,
      lifetime_usd: 152.834012,
      devices: [{ license_id: 'abc123', amount_usd: 0.456, allocation_count: 4 }],
      allocations: [{ id: '...', license_id: 'abc123', amount_usd: 0.123, completed_at: '2026-02-19T12:34:56.789Z' }]
    },
    {
      account_id: 'sub-uuid-2',
      email: 'second@example.com',
      label: 'Second',
      date: '2026-02-19',
      total_usd: 1.599433,
      allocation_count: 8,
      device_count: 2,
      balance_usd: 3.000000,
      lifetime_usd: 151.677988,
      devices: [],
      allocations: []
    }
  ],
  errors: [],
  // Backward-compat flat fields (sums of all accounts)
  email: 'main@example.com, second@example.com',
  total_usd: 2.834000,
  lifetime_usd: 304.512000,
  balance_usd: 7.825001,
  allocation_count: 20,
  device_count: 5
};

// ───────────────────────────────────────────────────────────────
// Settings load/save
// ───────────────────────────────────────────────────────────────
async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!res?.ok) return;
  const { settings, accounts, currentAutoSession } = res;

  $('destinationUrl').value = settings.destinationUrl || '';
  $('authHeaderName').value = settings.authHeaderName || 'Authorization';
  $('authHeaderValue').value = settings.authHeaderValue || '';
  $('autoSync').checked = !!settings.autoSync;
  $('autoSyncMinutes').value = String(settings.autoSyncMinutes || 60);
  $('autoSyncDailyTime').value = settings.autoSyncDailyTime || '19:20';
  $('autoSyncTimezone').value = settings.autoSyncTimezone || 'America/Los_Angeles';

  const mode = settings.autoSyncMode || 'daily';
  document.querySelectorAll('input[name="autoSyncMode"]').forEach(r => { r.checked = (r.value === mode); });
  applyModeUi(mode);
  renderNextSync(settings);
  renderAccounts(accounts || [], currentAutoSession);
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

// ───────────────────────────────────────────────────────────────
// Accounts UI
// ───────────────────────────────────────────────────────────────
function renderAccounts(accounts, currentSession) {
  // Current detect banner
  const detect = $('current-detect');
  const haveCurrent = !!currentSession?.accessToken;
  const accountIds = new Set(accounts.map(a => a.id));
  const currentId = currentSession?.sub || currentSession?.email;
  const alreadySaved = haveCurrent && accountIds.has(currentId);

  if (haveCurrent && !alreadySaved) {
    detect.className = 'current-detect has-session';
    detect.innerHTML = `
      <span>Detected on manage.unitynodes.io: <strong>${escapeHtml(currentSession.email || 'unknown')}</strong></span>
      <button class="btn primary btn-sm" id="add-current-btn" type="button">+ Add this account</button>
    `;
    $('add-current-btn').addEventListener('click', addCurrent);
  } else if (haveCurrent && alreadySaved) {
    detect.className = 'current-detect has-session';
    detect.innerHTML = `<span>✓ Currently signed in as <strong>${escapeHtml(currentSession.email || 'unknown')}</strong> — already saved below.</span>`;
  } else {
    detect.className = 'current-detect no-session';
    detect.textContent = 'No active session detected. Open https://manage.unitynodes.io and sign in to auto-grab a token.';
  }

  // List
  const list = $('acc-list');
  list.innerHTML = '';
  accounts.forEach(acc => list.appendChild(renderAccountRow(acc)));
}

function renderAccountRow(acc) {
  const row = document.createElement('div');
  row.className = 'acc-row';
  row.dataset.id = acc.id;
  row.dataset.disabled = acc.enabled === false ? 'true' : 'false';

  const status = acc.lastError ? 'error' : (acc.lastSuccessAt ? 'ok' : 'pending');
  row.dataset.status = status;

  const expiresInS = acc.expiresAt ? acc.expiresAt - Math.floor(Date.now() / 1000) : null;
  const expiryStr = expiresInS == null ? 'no refresh token' :
    expiresInS < 0 ? `expired ${formatDuration(-expiresInS)} ago` : `valid ${formatDuration(expiresInS)}`;

  const metaParts = [];
  metaParts.push(expiryStr);
  if (acc.lastSuccessAt) metaParts.push('last sync ' + timeAgo(acc.lastSuccessAt));

  row.innerHTML = `
    <div class="acc-status"></div>
    <div class="acc-info">
      <div class="acc-label-row">
        <span class="acc-label-text">${escapeHtml(acc.label || 'Account')}</span>
        <span class="acc-via" data-via="${acc.addedVia}">${acc.addedVia === 'manual' ? 'manual' : 'auto'}</span>
      </div>
      <div class="acc-email">${escapeHtml(acc.email || '—')}</div>
      <div class="acc-meta">${escapeHtml(metaParts.join(' · '))}</div>
      ${acc.lastError ? `<div class="acc-meta error-msg">⚠ ${escapeHtml(acc.lastError)}</div>` : ''}
    </div>
    <div class="acc-actions">
      <button class="acc-iconbtn" data-act="rename" title="Rename">✎</button>
      <button class="acc-iconbtn" data-act="toggle" title="${acc.enabled === false ? 'Enable' : 'Disable'}">${acc.enabled === false ? '◯' : '●'}</button>
      <button class="acc-iconbtn" data-act="refresh" title="Refresh token">↻</button>
      <button class="acc-iconbtn danger" data-act="remove" title="Remove">×</button>
    </div>
  `;
  row.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => handleAccountAction(acc, btn.dataset.act));
  });
  return row;
}

async function handleAccountAction(acc, action) {
  switch (action) {
    case 'rename': {
      const next = prompt('New label for this account:', acc.label || '');
      if (next != null && next.trim()) {
        await chrome.runtime.sendMessage({ type: 'UPDATE_ACCOUNT', id: acc.id, patch: { label: next.trim() } });
        await loadSettings();
      }
      break;
    }
    case 'toggle': {
      await chrome.runtime.sendMessage({ type: 'UPDATE_ACCOUNT', id: acc.id, patch: { enabled: !(acc.enabled !== false) } });
      await loadSettings();
      break;
    }
    case 'refresh': {
      const res = await chrome.runtime.sendMessage({ type: 'REFRESH_ACCOUNT', id: acc.id });
      if (!res?.ok) alert('Refresh failed: ' + (res?.error || 'unknown'));
      await loadSettings();
      break;
    }
    case 'remove': {
      if (confirm(`Remove "${acc.label || acc.email}" from synced accounts?`)) {
        await chrome.runtime.sendMessage({ type: 'REMOVE_ACCOUNT', id: acc.id });
        await loadSettings();
      }
      break;
    }
  }
}

async function addCurrent() {
  const res = await chrome.runtime.sendMessage({ type: 'ADD_CURRENT_ACCOUNT' });
  if (!res?.ok) alert('Could not add: ' + (res?.error || 'unknown'));
  await loadSettings();
}

async function addByToken() {
  const status = $('add-status');
  status.className = 'test-status';
  status.textContent = 'Saving…';
  const res = await chrome.runtime.sendMessage({
    type: 'ADD_ACCOUNT_FROM_TOKEN',
    input: $('add-token').value,
    label: $('add-label').value
  });
  if (!res?.ok) {
    status.className = 'test-status err';
    status.textContent = '✕ ' + (res?.error || 'failed');
    return;
  }
  status.className = 'test-status ok';
  status.textContent = `✓ Added ${res.email || 'account'}`;
  $('add-token').value = '';
  $('add-label').value = '';
  setTimeout(() => {
    $('add-panel').hidden = true;
    status.textContent = '';
  }, 1200);
  await loadSettings();
}

// ───────────────────────────────────────────────────────────────
// Save / test ping
// ───────────────────────────────────────────────────────────────
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
    autoSyncTimezone: $('autoSyncTimezone').value || 'America/Los_Angeles'
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

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDuration(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  return formatDuration(Math.floor(ms / 1000)) + ' ago';
}

// ───────────────────────────────────────────────────────────────
// Init
// ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('sample-payload').textContent = JSON.stringify(SAMPLE_PAYLOAD, null, 2);
  loadSettings();

  $('save-btn').addEventListener('click', save);
  $('test-btn').addEventListener('click', testPing);

  document.querySelectorAll('input[name="autoSyncMode"]').forEach(r => {
    r.addEventListener('change', (e) => applyModeUi(e.target.value));
  });

  // Add-by-token panel
  $('add-toggle').addEventListener('click', () => {
    const panel = $('add-panel');
    panel.hidden = !panel.hidden;
  });
  $('add-cancel').addEventListener('click', () => {
    $('add-panel').hidden = true;
    $('add-status').textContent = '';
  });
  $('add-save').addEventListener('click', addByToken);

  window.addEventListener('focus', loadSettings);
});
