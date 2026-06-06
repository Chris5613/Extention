// Popup script — multi-account dashboard. Lists every configured account,
// shows combined totals at the top, lets the user sync one or all.

const $ = (id) => document.getElementById(id);

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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function accountSourceLabel(acc) {
  if (acc.manualToken && acc.manualToken.trim()) return { label: 'manual', cls: 'manual' };
  if (acc.autoToken && acc.autoToken.trim()) return { label: 'auto', cls: 'auto' };
  return { label: 'no token', cls: 'missing' };
}

const SYNC_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>';

function renderAccounts(accounts) {
  const list = $('accounts-list');
  const empty = $('empty-state');
  list.innerHTML = '';

  if (!accounts || accounts.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  accounts.forEach(acc => {
    const src = accountSourceLabel(acc);
    const today = acc.lastEarnings?.total_usd;
    const lifetime = acc.lastEarnings?.lifetime_usd;

    const row = document.createElement('div');
    row.className = 'acct-row';
    row.dataset.id = acc.id;
    row.dataset.status = acc.lastSyncStatus || '';
    row.dataset.disabled = acc.enabled === false ? 'true' : 'false';

    const labelText = acc.label || acc.email || 'Unity Account';
    const emailLine = acc.email && acc.email !== labelText ? acc.email : '';
    let metaText = '';
    if (acc.lastSyncStatus === 'error') {
      metaText = `<span class="err">${escapeHtml(acc.lastSyncError || 'Sync failed')}</span>`;
    } else if (acc.lastSync) {
      metaText = `Synced ${timeAgo(acc.lastSync)}`;
      if (emailLine) metaText = `${escapeHtml(emailLine)} · ${metaText}`;
    } else if (emailLine) {
      metaText = escapeHtml(emailLine);
    } else if (src.cls === 'missing') {
      metaText = '<span class="err">No token — sign in to capture</span>';
    } else {
      metaText = 'Not synced yet';
    }

    row.innerHTML = `
      <div class="acct-info">
        <div class="acct-label">
          <span class="acct-label-text">${escapeHtml(labelText)}</span>
          <span class="acct-source ${src.cls}">${src.label}</span>
        </div>
        <div class="acct-meta">${metaText}</div>
      </div>
      <div class="acct-stats">
        <div class="acct-today">${fmtUsd(today, 3)}</div>
        <div class="acct-lifetime">${fmtUsd(lifetime, 2)} lifetime</div>
      </div>
      <button class="acct-sync-btn" data-account-id="${escapeHtml(acc.id)}" title="Sync this account">${SYNC_ICON_SVG}</button>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('.acct-sync-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.accountId;
      syncOneAccount(id, btn);
    });
  });
}

function renderTotals(accounts) {
  const enabled = accounts.filter(a => a.enabled !== false);
  const okEarnings = enabled.map(a => a.lastEarnings).filter(Boolean);

  const totalToday = okEarnings.reduce((s, e) => s + (e.total_usd || 0), 0);
  const totalLifetime = okEarnings.reduce((s, e) => s + (e.lifetime_usd || 0), 0);

  $('today-usd').textContent = fmtUsd(totalToday, 3);
  const accountsLabel = `${enabled.length} account${enabled.length === 1 ? '' : 's'}`;
  const lifetimeLabel = totalLifetime > 0 ? `${fmtUsd(totalLifetime, 2)} lifetime` : '— lifetime';
  $('today-meta').textContent = `${accountsLabel} · ${lifetimeLabel}`;

  $('accounts-count').textContent = accounts.length
    ? `${enabled.length} of ${accounts.length} enabled`
    : '';

  // Subtitle = all account emails, comma-joined, or a hint
  const sub = $('subtitle');
  if (accounts.length === 0) {
    sub.textContent = 'No accounts yet';
  } else if (accounts.length === 1) {
    sub.textContent = accounts[0].email || accounts[0].label || 'Unity Account';
  } else {
    sub.textContent = `${accounts.length} accounts connected`;
  }

  // Summary pill: ok / partial / missing
  const pill = $('summary-pill');
  const errCount = accounts.filter(a => a.lastSyncStatus === 'error').length;
  const okCount = accounts.filter(a => a.lastSyncStatus === 'ok').length;
  const noTokenCount = accounts.filter(a => !((a.manualToken && a.manualToken.trim()) || (a.autoToken && a.autoToken.trim()))).length;

  if (accounts.length === 0 || noTokenCount === accounts.length) {
    pill.dataset.state = 'missing';
    pill.textContent = `${accounts.length} accounts`;
  } else if (errCount > 0 || noTokenCount > 0) {
    pill.dataset.state = 'partial';
    pill.textContent = `${okCount}/${accounts.length} ok`;
  } else {
    pill.dataset.state = 'ok';
    pill.textContent = `${accounts.length} ok`;
  }
}

function renderStatus(settings) {
  const statusEl = $('status');
  statusEl.className = 'status';

  if (settings.lastSyncStatus === 'ok') {
    statusEl.classList.add('success');
    statusEl.textContent = 'All accounts synced — pushed to tracker.';
  } else if (settings.lastSyncStatus === 'partial') {
    statusEl.classList.add('working');
    const summary = settings.lastSummary;
    const oks = summary?.ok_count ?? 0;
    const tot = summary?.account_count ?? 0;
    statusEl.textContent = `Partial: ${oks}/${tot} accounts synced.`;
  } else if (settings.lastSyncStatus === 'error') {
    statusEl.classList.add('error');
    statusEl.textContent = settings.lastSyncError || 'Last sync failed.';
  } else {
    statusEl.textContent = 'Ready. Click Sync All.';
  }

  $('last-sync').textContent = settings.lastSync ? timeAgo(settings.lastSync) : '';

  if (settings.autoSync && settings.nextScheduledAt && settings.lastSyncStatus !== 'error') {
    const when = new Date(settings.nextScheduledAt);
    const whenStr = when.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    statusEl.textContent = `Next: ${whenStr}`;
    statusEl.classList.remove('success', 'error', 'working');
  }
}

async function refreshStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!res?.ok) return;
  const { settings, accounts } = res;

  renderAccounts(accounts);
  renderTotals(accounts);
  renderStatus(settings);
}

async function syncAll() {
  const btn = $('sync-btn');
  const label = btn.querySelector('.btn-label');
  const statusEl = $('status');
  btn.disabled = true;
  label.innerHTML = '<span class="spin"></span>Syncing…';
  statusEl.className = 'status working';
  statusEl.textContent = 'Fetching earnings for all accounts…';

  const res = await chrome.runtime.sendMessage({ type: 'SYNC_NOW', triggeredBy: 'popup' });

  btn.disabled = false;
  label.textContent = 'Sync All';

  if (res?.ok) {
    const sum = res.summary;
    statusEl.className = 'status success';
    if (res.status === 'partial') {
      statusEl.className = 'status working';
      statusEl.textContent = `Partial: $${(sum?.total_usd || 0).toFixed(3)} · ${sum?.ok_count}/${sum?.account_count} ok`;
    } else {
      statusEl.textContent = `Synced $${(sum?.total_usd || 0).toFixed(3)} across ${sum?.ok_count} account${sum?.ok_count === 1 ? '' : 's'}`;
    }
  } else {
    statusEl.className = 'status error';
    statusEl.textContent = res?.error || 'Sync failed.';
  }
  await refreshStatus();
}

async function syncOneAccount(accountId, buttonEl) {
  if (!accountId) return;
  const statusEl = $('status');
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.classList.add('spinning');
  }
  statusEl.className = 'status working';
  statusEl.textContent = 'Syncing account…';

  const res = await chrome.runtime.sendMessage({
    type: 'SYNC_NOW',
    triggeredBy: 'popup',
    accountId
  });

  if (buttonEl) {
    buttonEl.disabled = false;
    buttonEl.classList.remove('spinning');
  }

  if (res?.ok) {
    const sum = res.summary;
    statusEl.className = 'status success';
    statusEl.textContent = `Synced $${(sum?.total_usd || 0).toFixed(3)}`;
  } else {
    statusEl.className = 'status error';
    statusEl.textContent = res?.error || 'Sync failed.';
  }
  await refreshStatus();
}

document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();

  $('sync-btn').addEventListener('click', syncAll);

  $('settings-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  const openUnity = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://manage.unetwork.io/' });
  };
  $('open-unity').addEventListener('click', openUnity);
  $('open-unity-empty')?.addEventListener('click', openUnity);

  $('open-settings-empty')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});
