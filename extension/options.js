// Options page — multi-account management + destination + auto-sync.

const $ = (id) => document.getElementById(id);

const SAMPLE_PAYLOAD = {
  source: 'chrome-extension',
  version: '1.2.0',
  synced_at: '2026-02-19T14:30:00.000Z',
  account_id: '6c0f…2d1',
  account_label: 'Personal',
  email: 'you@example.com',
  date: '2026-02-19',
  total_usd: 1.234567,
  allocation_count: 12,
  device_count: 3,
  balance_usd: 4.825001,
  lifetime_usd: 152.834012,
  devices: [
    { license_id: 'abc123-def456', amount_usd: 0.456, allocation_count: 4 }
  ],
  allocations: [
    { id: '…', license_id: 'abc123-def456', amount_usd: 0.123, completed_at: '2026-02-19T12:34:56.789Z' }
  ]
};

const SAMPLE_MULTI = {
  source: 'chrome-extension',
  version: '1.2.0',
  multi: true,
  synced_at: '2026-02-19T14:30:00.000Z',
  account_count: 2,
  ok_count: 2,
  error_count: 0,
  total_usd: 2.481234,
  lifetime_usd: 318.502419,
  balance_usd: 9.213045,
  accounts: [
    { account_id: '6c0f…2d1', email: 'you@example.com', total_usd: 1.234567, lifetime_usd: 152.834012 },
    { account_id: 'bd91…4f8', email: 'work@example.com', total_usd: 1.246667, lifetime_usd: 165.668407 }
  ]
};

let currentSettings = null;
let currentAccounts = [];

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtUsd(v, decimals = 3) {
  if (v == null || isNaN(v)) return '$—';
  return '$' + Number(v).toFixed(decimals);
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function sourceFor(acc) {
  if (acc.manualToken && acc.manualToken.trim()) return { label: 'Manual override', cls: 'manual' };
  if (acc.autoToken && acc.autoToken.trim()) return { label: 'Auto-detected', cls: 'auto' };
  return { label: 'No token', cls: 'missing' };
}

function renderAccounts() {
  const list = $('accounts-list');
  const empty = $('empty-accounts');
  list.innerHTML = '';

  if (!currentAccounts.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  currentAccounts.forEach(acc => {
    const src = sourceFor(acc);
    const node = document.createElement('div');
    node.className = 'acct';
    node.dataset.id = acc.id;
    node.dataset.disabled = acc.enabled === false ? 'true' : 'false';
    node.dataset.status = acc.lastSyncStatus || '';

    let statusLine = '';
    if (acc.lastSyncStatus === 'ok') {
      statusLine = `<div class="acct-status-line ok">✓ Synced ${timeAgo(acc.lastSync)}</div>`;
    } else if (acc.lastSyncStatus === 'error') {
      statusLine = `<div class="acct-status-line err">✕ ${escapeHtml(acc.lastSyncError || 'Last sync failed')}</div>`;
    } else {
      statusLine = `<div class="acct-status-line">Not synced yet</div>`;
    }

    const today = acc.lastEarnings?.total_usd;
    const balance = acc.lastEarnings?.balance_usd;
    const lifetime = acc.lastEarnings?.lifetime_usd;
    const emailLine = acc.email ? escapeHtml(acc.email) : '<em style="font-style:normal;opacity:0.6;">No email decoded yet</em>';

    node.innerHTML = `
      <div class="acct-top">
        <div class="acct-headline">
          <div class="acct-row1">
            <input class="acct-name-input" type="text" value="${escapeHtml(acc.label || '')}" placeholder="Account label" data-field="label" data-id="${escapeHtml(acc.id)}" />
            <span class="acct-source-pill ${src.cls}">${src.label}</span>
          </div>
          <div class="acct-email">${emailLine}</div>
        </div>
        <div class="acct-actions">
          <label class="acct-toggle" title="Enable / disable in Sync All">
            <input type="checkbox" data-field="enabled" data-id="${escapeHtml(acc.id)}" ${acc.enabled !== false ? 'checked' : ''} />
            <span class="slider"></span>
            <span class="acct-toggle-label">${acc.enabled !== false ? 'Enabled' : 'Disabled'}</span>
          </label>
          <button class="acct-remove" data-action="remove" data-id="${escapeHtml(acc.id)}">Remove</button>
        </div>
      </div>

      <div class="acct-stats-row">
        <div class="acct-stat">
          <div class="acct-stat-label">Today</div>
          <div class="acct-stat-value accent">${fmtUsd(today, 3)}</div>
        </div>
        <div class="acct-stat">
          <div class="acct-stat-label">Balance</div>
          <div class="acct-stat-value">${fmtUsd(balance, 2)}</div>
        </div>
        <div class="acct-stat">
          <div class="acct-stat-label">Lifetime</div>
          <div class="acct-stat-value">${fmtUsd(lifetime, 2)}</div>
        </div>
      </div>

      ${statusLine}

      <div class="acct-token-section">
        <span class="label">
          <span>Manual token override <em>(takes precedence over auto-detect)</em></span>
          <span class="label-actions">
            ${acc.manualToken ? `<button type="button" class="label-action" data-action="clear-token" data-id="${escapeHtml(acc.id)}">Clear</button>` : ''}
          </span>
        </span>
        <textarea data-field="manualToken" data-id="${escapeHtml(acc.id)}" rows="2" placeholder="Paste a Bearer access_token to override auto-detection for this account">${escapeHtml(acc.manualToken || '')}</textarea>
      </div>
    `;
    list.appendChild(node);
  });

  // Wire up listeners
  list.querySelectorAll('input[data-field="label"]').forEach(input => {
    input.addEventListener('change', onAccountFieldChange);
    input.addEventListener('blur', onAccountFieldChange);
  });
  list.querySelectorAll('input[data-field="enabled"]').forEach(input => {
    input.addEventListener('change', onAccountFieldChange);
  });
  list.querySelectorAll('textarea[data-field="manualToken"]').forEach(input => {
    input.addEventListener('change', onAccountFieldChange);
    input.addEventListener('blur', onAccountFieldChange);
  });
  list.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', onRemoveAccount);
  });
  list.querySelectorAll('[data-action="clear-token"]').forEach(btn => {
    btn.addEventListener('click', onClearManualToken);
  });
}

async function onAccountFieldChange(e) {
  const id = e.target.dataset.id;
  const field = e.target.dataset.field;
  if (!id || !field) return;
  let value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (field === 'manualToken') value = (value || '').trim();
  if (field === 'label') value = (value || '').trim();

  const patch = { [field]: value };
  const res = await chrome.runtime.sendMessage({ type: 'UPDATE_ACCOUNT', id, patch });
  if (!res?.ok) {
    flashSave('Update failed: ' + (res?.error || 'unknown'), true);
    return;
  }
  await loadSettings();
}

async function onRemoveAccount(e) {
  const id = e.target.dataset.id;
  if (!id) return;
  const acc = currentAccounts.find(a => a.id === id);
  const name = acc?.label || acc?.email || 'this account';
  if (!confirm(`Remove ${name}? This only removes it from the extension — your Unity Nodes account is unaffected. You can re-capture it by signing in again.`)) return;
  const res = await chrome.runtime.sendMessage({ type: 'REMOVE_ACCOUNT', id });
  if (!res?.ok) {
    flashSave('Remove failed: ' + (res?.error || 'unknown'), true);
    return;
  }
  flashSave('Account removed.');
  await loadSettings();
}

async function onClearManualToken(e) {
  const id = e.target.dataset.id;
  if (!id) return;
  const res = await chrome.runtime.sendMessage({ type: 'UPDATE_ACCOUNT', id, patch: { manualToken: '' } });
  if (!res?.ok) {
    flashSave('Clear failed: ' + (res?.error || 'unknown'), true);
    return;
  }
  await loadSettings();
}

async function addManualAccount() {
  const label = $('new-account-label').value.trim();
  const token = $('new-account-token').value.trim();
  const status = $('add-account-status');
  status.className = 'test-status';
  status.textContent = '';

  if (!token) {
    status.className = 'test-status err';
    status.textContent = 'Token is required.';
    return;
  }

  const btn = $('add-account-btn');
  btn.disabled = true;
  status.textContent = 'Adding…';

  const res = await chrome.runtime.sendMessage({
    type: 'ADD_MANUAL_ACCOUNT',
    label,
    manualToken: token
  });

  btn.disabled = false;

  if (!res?.ok) {
    status.className = 'test-status err';
    status.textContent = '✕ ' + (res?.error || 'Failed to add account');
    return;
  }

  status.className = 'test-status ok';
  status.textContent = res.updated ? '✓ Updated existing account' : '✓ Account added';
  $('new-account-label').value = '';
  $('new-account-token').value = '';
  setTimeout(() => {
    status.textContent = '';
    $('add-account').open = false;
  }, 1800);
  await loadSettings();
}

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!res?.ok) return;
  currentSettings = res.settings;
  currentAccounts = res.accounts || [];

  $('destinationUrl').value = currentSettings.destinationUrl || '';
  $('authHeaderName').value = currentSettings.authHeaderName || 'Authorization';
  $('authHeaderValue').value = currentSettings.authHeaderValue || '';
  $('autoSync').checked = !!currentSettings.autoSync;
  $('autoSyncMinutes').value = String(currentSettings.autoSyncMinutes || 60);
  $('autoSyncDailyTime').value = currentSettings.autoSyncDailyTime || '19:20';
  $('autoSyncTimezone').value = currentSettings.autoSyncTimezone || 'America/Los_Angeles';

  const mode = currentSettings.autoSyncMode || 'daily';
  document.querySelectorAll('input[name="autoSyncMode"]').forEach(r => {
    r.checked = (r.value === mode);
  });
  applyModeUi(mode);
  renderNextSync(currentSettings);
  renderAccounts();
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
  const enabled = currentAccounts.filter(a => a.enabled !== false).length;
  el.className = 'next-sync on';
  el.textContent = `Next sync: ${localStr} (${inWords}) — will sync ${enabled} enabled account${enabled === 1 ? '' : 's'}`;
}

function flashSave(msg, isErr = false) {
  const saveMsg = $('save-msg');
  saveMsg.className = 'save-msg ' + (isErr ? 'err' : 'saved');
  saveMsg.textContent = msg;
  setTimeout(() => { saveMsg.textContent = ''; saveMsg.className = 'save-msg'; }, 2500);
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

document.addEventListener('DOMContentLoaded', () => {
  $('sample-payload').textContent = JSON.stringify(SAMPLE_PAYLOAD, null, 2);
  $('sample-multi-payload').textContent = JSON.stringify(SAMPLE_MULTI, null, 2);
  loadSettings();

  $('save-btn').addEventListener('click', save);
  $('test-btn').addEventListener('click', testPing);
  $('add-account-btn').addEventListener('click', addManualAccount);

  document.querySelectorAll('input[name="autoSyncMode"]').forEach(r => {
    r.addEventListener('change', (e) => applyModeUi(e.target.value));
  });

  window.addEventListener('focus', loadSettings);
});
