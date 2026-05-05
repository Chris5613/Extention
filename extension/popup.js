// Popup script — displays current status and triggers manual sync.

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
  const { settings, hasAutoToken, hasManualToken } = res;

  // Token state pill
  const pill = $('token-pill');
  if (hasManualToken) {
    pill.dataset.state = 'manual';
    pill.textContent = 'Manual token';
  } else if (hasAutoToken) {
    pill.dataset.state = 'auto';
    pill.textContent = 'Auto-detected';
  } else {
    pill.dataset.state = 'missing';
    pill.textContent = 'No token';
  }

  // Email / subtitle
  if (settings.detectedEmail) {
    $('email').textContent = settings.detectedEmail;
  } else if (hasManualToken) {
    $('email').textContent = 'Using manual token';
  } else {
    $('email').textContent = 'Open manage.unitynodes.io to detect';
  }

  // Earnings
  const e = settings.lastEarnings;
  if (e) {
    $('today-usd').textContent = fmtUsd(e.total_usd, 3);
    $('today-meta').textContent =
      `${e.allocation_count || 0} payout${e.allocation_count === 1 ? '' : 's'} · ${e.device_count || 0} device${e.device_count === 1 ? '' : 's'}`;
    $('balance').textContent = fmtUsd(e.balance_usd, 2);
    $('lifetime').textContent = fmtUsd(e.lifetime_usd, 2);
    $('date').textContent = e.date || '—';
  }

  // Status
  const statusEl = $('status');
  statusEl.className = 'status';
  if (settings.lastSyncStatus === 'ok') {
    statusEl.classList.add('success');
    statusEl.textContent = settings.destinationUrl
      ? 'Synced to your tracking site.'
      : 'Fetched. Set destination URL in Settings.';
  } else if (settings.lastSyncStatus === 'error') {
    statusEl.classList.add('error');
    statusEl.textContent = settings.lastSyncError || 'Last sync failed.';
  } else {
    statusEl.textContent = 'Ready. Click Sync Now.';
  }

  $('last-sync').textContent = settings.lastSync ? timeAgo(settings.lastSync) : '';

  // Next scheduled sync (when auto-sync is on)
  const statusEl2 = $('status');
  if (settings.autoSync && settings.nextScheduledAt && settings.lastSyncStatus !== 'error') {
    const when = new Date(settings.nextScheduledAt);
    const whenStr = when.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    statusEl2.textContent = `Next: ${whenStr}`;
    statusEl2.classList.remove('success', 'error');
  }
}

async function doSync() {
  const btn = $('sync-btn');
  const label = btn.querySelector('.btn-label');
  const statusEl = $('status');
  btn.disabled = true;
  label.innerHTML = '<span class="spin"></span>Syncing…';
  statusEl.className = 'status working';
  statusEl.textContent = 'Fetching earnings…';

  const res = await chrome.runtime.sendMessage({ type: 'SYNC_NOW', triggeredBy: 'popup' });

  btn.disabled = false;
  label.textContent = 'Sync Now';

  if (res?.ok) {
    const p = res.payload;
    statusEl.className = 'status success';
    statusEl.textContent = res.destinationPosted
      ? `Synced $${p.total_usd.toFixed(3)} → your site`
      : `Fetched $${p.total_usd.toFixed(3)} (no destination set)`;
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
