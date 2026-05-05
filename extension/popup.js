// Popup — multi-account display + manual sync trigger.

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

async function refreshStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!res?.ok) return;
  const { settings, accounts, currentAutoSession } = res;

  // Account-count pill
  const pill = $('token-pill');
  const enabledCount = (accounts || []).filter(a => a.enabled !== false).length;
  if (enabledCount === 0) {
    pill.dataset.state = 'missing';
    pill.textContent = 'No accounts';
  } else if (enabledCount === 1) {
    pill.dataset.state = 'auto';
    pill.textContent = '1 account';
  } else {
    pill.dataset.state = 'auto';
    pill.textContent = `${enabledCount} accounts`;
  }

  // Subtitle: current session email or list of saved
  if (enabledCount === 0 && currentAutoSession?.email) {
    $('email').textContent = `Detected: ${currentAutoSession.email} (not added)`;
  } else if (enabledCount > 0) {
    const labels = accounts.filter(a => a.enabled !== false).map(a => a.label || a.email).slice(0, 2);
    $('email').textContent = labels.join(', ') + (enabledCount > 2 ? ` +${enabledCount - 2} more` : '');
  } else {
    $('email').textContent = 'Open manage.unitynodes.io to detect';
  }

  // Earnings (grand totals across all accounts)
  const e = settings.lastEarnings;
  const heroLabel = $('hero-label');
  if (e) {
    $('today-usd').textContent = fmtUsd(e.total_usd, 3);
    if (e.account_count > 1) {
      heroLabel.textContent = `TODAY'S EARNINGS · ${e.account_count} ACCOUNTS`;
    } else {
      heroLabel.textContent = "TODAY'S EARNINGS";
    }
    const parts = [
      `${e.allocation_count || 0} payout${e.allocation_count === 1 ? '' : 's'}`,
      `${e.device_count || 0} device${e.device_count === 1 ? '' : 's'}`
    ];
    if (e.failed_account_count > 0) parts.push(`⚠ ${e.failed_account_count} failed`);
    $('today-meta').textContent = parts.join(' · ');
    $('balance').textContent = fmtUsd(e.balance_usd, 2);
    $('lifetime').textContent = fmtUsd(e.lifetime_usd, 2);
    $('date').textContent = e.date || '—';
  }

  // Status line
  const statusEl = $('status');
  statusEl.className = 'status';
  if (settings.lastSyncStatus === 'ok') {
    statusEl.classList.add('success');
    statusEl.textContent = e?.failed_account_count > 0
      ? `Synced — ${e.failed_account_count} of ${e.account_count + e.failed_account_count} failed`
      : 'Synced — payload pushed to tracker.';
  } else if (settings.lastSyncStatus === 'error') {
    statusEl.classList.add('error');
    statusEl.textContent = settings.lastSyncError || 'Last sync failed.';
  } else {
    statusEl.textContent = 'Ready. Click Sync Now.';
  }

  $('last-sync').textContent = settings.lastSync ? timeAgo(settings.lastSync) : '';

  // Next scheduled sync (when auto-sync is on and last sync was ok)
  if (settings.autoSync && settings.nextScheduledAt && settings.lastSyncStatus === 'ok') {
    const when = new Date(settings.nextScheduledAt);
    const whenStr = when.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    statusEl.textContent = `Next: ${whenStr}`;
    statusEl.classList.remove('success', 'error');
  }
}

async function doSync() {
  const btn = $('sync-btn');
  const label = btn.querySelector('.btn-label');
  const statusEl = $('status');
  btn.disabled = true;
  label.innerHTML = '<span class="spin"></span>Syncing…';
  statusEl.className = 'status working';
  statusEl.textContent = 'Fetching all accounts…';

  const res = await chrome.runtime.sendMessage({ type: 'SYNC_NOW', triggeredBy: 'popup' });

  btn.disabled = false;
  label.textContent = 'Sync Now';

  if (res?.ok) {
    const p = res.payload;
    statusEl.className = 'status success';
    const tail = res.failCount > 0 ? ` · ${res.failCount} failed` : '';
    statusEl.textContent = `Synced $${p.grand_total_usd.toFixed(3)} (${res.okCount} acct${res.okCount === 1 ? '' : 's'})${tail}`;
  } else {
    statusEl.className = 'status error';
    statusEl.textContent = res?.error || 'Sync failed.';
  }
  await refreshStatus();
}

document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();

  $('sync-btn').addEventListener('click', doSync);

  $('settings-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  $('open-unity').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://manage.unitynodes.io/' });
  });
});
