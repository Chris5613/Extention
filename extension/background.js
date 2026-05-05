// Background service worker — multi-account Unity Nodes earnings sync.
// Pulls each account's allocations + balance, refreshes expired Supabase tokens
// automatically, builds a combined payload, and pushes to the in-page bridge.

const API_BASE = 'https://api.unityedge.io/rest/v1/rpc/';
const AUTH_REFRESH_URL = 'https://api.unityedge.io/auth/v1/token?grant_type=refresh_token';
const API_KEY = 'sb_publishable_yKqi0fu5vV6G4ryUIMJuzw_NCoFEl1c';
const ALARM_NAME = 'unity-auto-sync';
const VERSION = '1.2.1';
const TRACKER_URL = 'https://nam-qyn8.onrender.com/';
const TRACKER_MATCH = 'https://nam-qyn8.onrender.com/*';

// Account shape:
// {
//   id, email, label,
//   accessToken, refreshToken, expiresAt,
//   addedVia: 'auto'|'manual', addedAt,
//   enabled,
//   lastError, lastErrorAt, lastSuccessAt
// }
const DEFAULT_SETTINGS = {
  destinationUrl: '',
  authHeaderName: 'Authorization',
  authHeaderValue: '',
  autoSync: false,
  autoSyncMode: 'daily',
  autoSyncMinutes: 60,
  autoSyncDailyTime: '19:20',
  autoSyncTimezone: 'America/Los_Angeles',
  accounts: [],
  lastSync: null,
  lastSyncStatus: null,
  lastSyncError: null,
  lastEarnings: null,
  lastFullPayload: null,
  nextScheduledAt: null
};

// ───────────────────────────────────────────────────────────────
// Storage helpers
// ───────────────────────────────────────────────────────────────
async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}
async function setSettings(patch) { await chrome.storage.local.set(patch); }

async function getAccounts() {
  const s = await getSettings();
  return Array.isArray(s.accounts) ? s.accounts : [];
}
async function saveAccounts(accounts) { await setSettings({ accounts }); }

async function upsertAccount(partial) {
  const accounts = await getAccounts();
  const idx = accounts.findIndex(a => a.id === partial.id);
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], ...partial };
  } else {
    accounts.push({
      id: partial.id,
      email: partial.email || null,
      label: partial.label || (partial.email ? partial.email.split('@')[0] : 'Account'),
      accessToken: partial.accessToken || '',
      refreshToken: partial.refreshToken || null,
      expiresAt: partial.expiresAt || null,
      addedVia: partial.addedVia || 'manual',
      addedAt: new Date().toISOString(),
      enabled: partial.enabled !== false,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null
    });
  }
  await saveAccounts(accounts);
  return accounts.find(a => a.id === partial.id);
}

async function updateAccount(id, patch) {
  const accounts = await getAccounts();
  const idx = accounts.findIndex(a => a.id === id);
  if (idx < 0) return null;
  accounts[idx] = { ...accounts[idx], ...patch };
  await saveAccounts(accounts);
  return accounts[idx];
}

async function removeAccountById(id) {
  const accounts = await getAccounts();
  await saveAccounts(accounts.filter(a => a.id !== id));
}

// ───────────────────────────────────────────────────────────────
// JWT helpers
// ───────────────────────────────────────────────────────────────
function decodeJwt(jwt) {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { email: payload.email || null, sub: payload.sub || null, exp: payload.exp || null };
  } catch (e) {
    return { email: null, sub: null, exp: null };
  }
}

function accountIdFor(jwtPayload, fallbackToken) {
  return jwtPayload.sub || jwtPayload.email || ('tok-' + (fallbackToken || '').slice(-12));
}

// ───────────────────────────────────────────────────────────────
// Token refresh (Supabase GoTrue)
// ───────────────────────────────────────────────────────────────
async function refreshAccountToken(account) {
  if (!account.refreshToken) {
    throw new Error('No refresh_token saved — sign in to manage.unitynodes.io to refresh.');
  }
  const res = await fetch(AUTH_REFRESH_URL, {
    method: 'POST',
    headers: {
      'apikey': API_KEY,
      'authorization': 'Bearer ' + API_KEY,
      'content-type': 'application/json',
      'x-client-info': 'supabase-js-web/2.87.1'
    },
    body: JSON.stringify({ refresh_token: account.refreshToken })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Refresh ${res.status}: ${t.slice(0, 160)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Refresh response missing access_token');
  const exp = data.expires_at || (Math.floor(Date.now() / 1000) + (data.expires_in || 3600));
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || account.refreshToken,
    expiresAt: exp
  };
}

async function ensureFreshToken(account) {
  const nowS = Math.floor(Date.now() / 1000);
  const expSoon = account.expiresAt && (account.expiresAt - 60 < nowS);
  if (expSoon && account.refreshToken) {
    try {
      const refreshed = await refreshAccountToken(account);
      const updated = await updateAccount(account.id, refreshed);
      return updated || { ...account, ...refreshed };
    } catch (e) { /* fall through; retry on 401 below */ }
  }
  return account;
}

// ───────────────────────────────────────────────────────────────
// Tracker tab
// ───────────────────────────────────────────────────────────────
async function ensureTrackerTab(triggeredBy) {
  try {
    const tabs = await chrome.tabs.query({ url: TRACKER_MATCH });
    if (tabs && tabs.length > 0) {
      const tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      if (tab.status === 'unloaded' || tab.discarded) {
        await chrome.tabs.reload(tab.id);
      }
      if (triggeredBy === 'popup' || triggeredBy === 'manual') {
        try {
          await chrome.tabs.update(tab.id, { active: true });
          if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
        } catch (e) { /* ignore */ }
      }
      return tab;
    }
    const active = (triggeredBy === 'popup' || triggeredBy === 'manual');
    return await chrome.tabs.create({ url: TRACKER_URL, active });
  } catch (err) { return null; }
}

// ───────────────────────────────────────────────────────────────
// Unity Edge API
// ───────────────────────────────────────────────────────────────
async function apiCall(rpc, body, token) {
  const res = await fetch(API_BASE + rpc, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'apikey': API_KEY,
      'authorization': 'Bearer ' + token,
      'content-profile': 'public',
      'content-type': 'application/json',
      'x-client-info': 'supabase-js-web/2.87.1'
    },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${rpc} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ───────────────────────────────────────────────────────────────
// Per-account sync (with single auto-retry on 401)
// ───────────────────────────────────────────────────────────────
async function syncAccount(accountIn) {
  let account = await ensureFreshToken(accountIn);
  let token = account.accessToken;
  if (!token) return { ok: false, account, error: 'No access token saved.' };

  const tryFetch = () => Promise.allSettled([
    apiCall('rewards_get_balance', {}, token),
    apiCall('rewards_get_allocations', { skip: 0, take: 1000 }, token)
  ]);

  let [balRes, allocRes] = await tryFetch();
  const isAuthFail = (r) => r.status === 'rejected' && /\b401\b|JWT|jwt|expired/i.test(r.reason?.message || '');

  if ((isAuthFail(allocRes) || isAuthFail(balRes)) && account.refreshToken) {
    try {
      const refreshed = await refreshAccountToken(account);
      account = await updateAccount(account.id, refreshed) || { ...account, ...refreshed };
      token = account.accessToken;
      [balRes, allocRes] = await tryFetch();
    } catch (e) {
      const msg = 'Refresh failed: ' + (e.message || e);
      await updateAccount(account.id, { lastError: msg, lastErrorAt: new Date().toISOString() });
      return { ok: false, account, error: msg };
    }
  }

  if (allocRes.status === 'rejected') {
    const msg = allocRes.reason?.message || 'Failed to fetch allocations';
    await updateAccount(account.id, { lastError: msg, lastErrorAt: new Date().toISOString() });
    return { ok: false, account, error: msg };
  }

  const balance = balRes.status === 'fulfilled' ? balRes.value : null;
  const allocations = allocRes.value || [];
  await updateAccount(account.id, {
    lastError: null, lastErrorAt: null, lastSuccessAt: new Date().toISOString()
  });
  return { ok: true, account, balance, allocations };
}

// ───────────────────────────────────────────────────────────────
// Payload builders
// ───────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

function buildAccountPayload(account, allocations, balanceMicros) {
  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const todayUtc = now.toISOString().split('T')[0];

  const dateSet = new Set();
  (allocations || []).forEach(a => {
    const d = (a.completedAt || '').split('T')[0];
    if (d) dateSet.add(d);
  });
  const sortedDates = [...dateSet].sort();
  const latestDate = sortedDates[sortedDates.length - 1] || todayLocal;

  let todayItems = (allocations || []).filter(a => {
    const d = (a.completedAt || '').split('T')[0];
    return d === todayLocal || d === todayUtc;
  });
  let usedDate = todayLocal;
  if (!todayItems.length) {
    todayItems = (allocations || []).filter(a => (a.completedAt || '').split('T')[0] === latestDate);
    usedDate = latestDate;
  }

  const perDevice = {};
  todayItems.forEach(a => {
    const id = a.licenseId || 'unknown';
    if (!perDevice[id]) perDevice[id] = { license_id: id, amount_usd: 0, allocation_count: 0 };
    perDevice[id].amount_usd += (a.amountMicros || 0) / 1e6;
    perDevice[id].allocation_count += 1;
  });

  const totalMicros = todayItems.reduce((s, a) => s + (a.amountMicros || 0), 0);
  const lifetimeMicros = (allocations || []).reduce((s, a) => s + (a.amountMicros || 0), 0);

  return {
    account_id: account.id,
    email: account.email,
    label: account.label,
    date: usedDate,
    total_usd: Number((totalMicros / 1e6).toFixed(6)),
    allocation_count: todayItems.length,
    device_count: Object.keys(perDevice).length,
    balance_usd: balanceMicros != null ? Number((balanceMicros / 1e6).toFixed(6)) : null,
    lifetime_usd: Number((lifetimeMicros / 1e6).toFixed(6)),
    devices: Object.values(perDevice).map(d => ({ ...d, amount_usd: Number(d.amount_usd.toFixed(6)) })),
    allocations: todayItems.map(a => ({
      id: a.id,
      license_id: a.licenseId,
      amount_usd: Number(((a.amountMicros || 0) / 1e6).toFixed(6)),
      completed_at: a.completedAt
    }))
  };
}

function buildCombinedPayload(perAccountResults) {
  const okResults = perAccountResults.filter(r => r.ok && r.payload);
  const accounts = okResults.map(r => r.payload);
  const errors = perAccountResults.filter(r => !r.ok).map(r => ({
    account_id: r.account?.id || null,
    email: r.account?.email || null,
    label: r.account?.label || null,
    error: r.error
  }));
  const sum = (key) => accounts.reduce((s, a) => s + (a[key] || 0), 0);

  // Flat lists for backward compat with single-account consumers
  const flatDevices = [];
  const flatAllocations = [];
  accounts.forEach(a => {
    (a.devices || []).forEach(d => flatDevices.push({ ...d, email: a.email }));
    (a.allocations || []).forEach(al => flatAllocations.push({ ...al, email: a.email }));
  });

  const date = accounts[0]?.date || new Date().toISOString().split('T')[0];

  return {
    source: 'chrome-extension',
    version: VERSION,
    synced_at: new Date().toISOString(),
    date,
    // Multi-account fields
    accounts,
    errors,
    account_count: accounts.length,
    failed_account_count: errors.length,
    grand_total_usd: Number(sum('total_usd').toFixed(6)),
    grand_lifetime_usd: Number(sum('lifetime_usd').toFixed(6)),
    grand_balance_usd: Number(sum('balance_usd').toFixed(6)),
    // Backward-compat flat fields (sums across all accounts)
    email: accounts.map(a => a.email).filter(Boolean).join(', ') || null,
    total_usd: Number(sum('total_usd').toFixed(6)),
    lifetime_usd: Number(sum('lifetime_usd').toFixed(6)),
    balance_usd: Number(sum('balance_usd').toFixed(6)),
    allocation_count: sum('allocation_count'),
    device_count: sum('device_count'),
    devices: flatDevices,
    allocations: flatAllocations
  };
}

// ───────────────────────────────────────────────────────────────
// Sync orchestrator
// ───────────────────────────────────────────────────────────────
async function performSync({ triggeredBy = 'manual' } = {}) {
  try {
    return await _performSyncInner({ triggeredBy });
  } catch (err) {
    // Top-level safety net — never leak unhandled rejections to alarm handler.
    const msg = err?.message || String(err);
    await appendSyncLog({ at: new Date().toISOString(), triggeredBy, ok: false, error: msg });
    try {
      await setSettings({
        lastSync: new Date().toISOString(),
        lastSyncStatus: 'error',
        lastSyncError: 'Internal error: ' + msg
      });
    } catch (e) { /* storage broken — nothing more we can do */ }
    return { ok: false, error: msg };
  }
}

async function _performSyncInner({ triggeredBy }) {
  const settings = await getSettings();
  const accounts = (await getAccounts()).filter(a => a.enabled !== false);

  if (accounts.length === 0) {
    const err = 'No accounts configured. Open Settings → Accounts → Add account, or sign in on manage.unitynodes.io.';
    await setSettings({ lastSync: new Date().toISOString(), lastSyncStatus: 'error', lastSyncError: err });
    await appendSyncLog({ at: new Date().toISOString(), triggeredBy, ok: false, error: err });
    return { ok: false, error: err };
  }

  // Sync all accounts in parallel
  const settled = await Promise.allSettled(accounts.map(a => syncAccount(a)));
  const perAccountResults = settled.map((s, i) => {
    if (s.status === 'fulfilled') {
      const r = s.value;
      if (r.ok) {
        return { ok: true, account: r.account, payload: buildAccountPayload(r.account, r.allocations, r.balance) };
      }
      return r;
    }
    return { ok: false, account: accounts[i], error: s.reason?.message || String(s.reason) };
  });

  const okCount = perAccountResults.filter(r => r.ok).length;
  const failCount = perAccountResults.length - okCount;
  const combined = buildCombinedPayload(perAccountResults);

  // Optional HTTP POST (kept for backward compat — usually empty when bridge is in use)
  let destResult = null;
  if (settings.destinationUrl) {
    try { destResult = await postToDestination(combined, settings); }
    catch (e) { destResult = { error: e.message }; }
  }

  // Even partial success counts as 'ok' so the bridge gets the data; surface errors in payload.errors[]
  const overallOk = okCount > 0;
  await setSettings({
    lastSync: new Date().toISOString(),
    lastSyncStatus: overallOk ? 'ok' : 'error',
    lastSyncError: overallOk ? (failCount > 0 ? `${failCount} of ${perAccountResults.length} accounts failed` : null) : combined.errors[0]?.error || 'All accounts failed',
    lastFullPayload: combined,
    lastEarnings: {
      date: combined.date,
      total_usd: combined.grand_total_usd,
      allocation_count: combined.allocation_count,
      device_count: combined.device_count,
      balance_usd: combined.grand_balance_usd,
      lifetime_usd: combined.grand_lifetime_usd,
      account_count: combined.account_count,
      failed_account_count: combined.failed_account_count,
      email: combined.email
    }
  });

  await appendSyncLog({
    at: new Date().toISOString(),
    triggeredBy,
    ok: overallOk,
    okCount, failCount,
    grand_total_usd: combined.grand_total_usd,
    error: overallOk ? null : (combined.errors[0]?.error || 'All accounts failed')
  });

  if (overallOk) await ensureTrackerTab(triggeredBy);

  return {
    ok: overallOk,
    triggeredBy,
    payload: combined,
    okCount,
    failCount,
    destinationPosted: !!settings.destinationUrl,
    destResult
  };
}

// Keep last 20 sync events for diagnostics — visible in Settings → Diagnostics.
async function appendSyncLog(entry) {
  try {
    const { syncLog } = await chrome.storage.local.get(['syncLog']);
    const next = Array.isArray(syncLog) ? syncLog.slice(-19) : [];
    next.push(entry);
    await chrome.storage.local.set({ syncLog: next });
  } catch (e) { /* ignore */ }
}

// ───────────────────────────────────────────────────────────────
// Destination POST (legacy)
// ───────────────────────────────────────────────────────────────
async function postToDestination(payload, settings) {
  if (!settings.destinationUrl) throw new Error('Destination URL not set.');
  const headers = { 'content-type': 'application/json' };
  if (settings.authHeaderName && settings.authHeaderValue) {
    headers[settings.authHeaderName] = settings.authHeaderValue;
  }
  const res = await fetch(settings.destinationUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Destination ${res.status}: ${text.slice(0, 200)}`);
  return { status: res.status, body: text.slice(0, 500) };
}

async function testDestination() {
  const settings = await getSettings();
  if (!settings.destinationUrl) return { ok: false, error: 'Destination URL not set.' };
  try {
    const result = await postToDestination({
      source: 'chrome-extension', version: VERSION, test: true,
      synced_at: new Date().toISOString(),
      message: 'Hello from Unity Nodes Earnings Tracker — this is a test ping.'
    }, settings);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ───────────────────────────────────────────────────────────────
// Alarms
// ───────────────────────────────────────────────────────────────
function getTzOffsetMinutes(utcDate, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = {};
    fmt.formatToParts(utcDate).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
    const hr = parts.hour === '24' ? 0 : +parts.hour;
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hr, +parts.minute, +parts.second);
    return (asIfUtc - utcDate.getTime()) / 60000;
  } catch (e) { return 0; }
}

function nextDailyUtcMs(hh, mm, timeZone) {
  const now = new Date();
  const nowMs = now.getTime();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = {};
  fmt.formatToParts(now).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const asIfUtc = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + dayOffset, hh, mm, 0));
    const tzOffset = getTzOffsetMinutes(asIfUtc, timeZone);
    const actualUtc = asIfUtc.getTime() - tzOffset * 60000;
    if (actualUtc > nowMs + 5000) return actualUtc;
  }
  return null;
}

async function rescheduleAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (!s.autoSync) { await setSettings({ nextScheduledAt: null }); return; }
  if (s.autoSyncMode === 'daily') {
    const [hhStr, mmStr] = (s.autoSyncDailyTime || '19:20').split(':');
    const hh = Math.max(0, Math.min(23, parseInt(hhStr, 10) || 0));
    const mm = Math.max(0, Math.min(59, parseInt(mmStr, 10) || 0));
    const tz = s.autoSyncTimezone || 'America/Los_Angeles';
    const when = nextDailyUtcMs(hh, mm, tz);
    if (when) {
      chrome.alarms.create(ALARM_NAME, { when });
      await setSettings({ nextScheduledAt: new Date(when).toISOString() });
    } else {
      await setSettings({ nextScheduledAt: null });
    }
  } else {
    const mins = Math.max(1, s.autoSyncMinutes || 60);
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: mins });
    await setSettings({ nextScheduledAt: new Date(Date.now() + 60000).toISOString() });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // Reschedule FIRST — locks in tomorrow's daily alarm even if sync hangs/crashes.
  // Do this before sync so we never lose the recurring cycle.
  try {
    const s0 = await getSettings();
    if (s0.autoSync && s0.autoSyncMode === 'daily') await rescheduleAlarm();
  } catch (e) { /* will retry below */ }

  try {
    const result = await performSync({ triggeredBy: 'alarm' });
    if (!result.ok) {
      try {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Unity Sync Failed',
          message: result.error?.slice(0, 200) || 'Unknown error'
        });
      } catch (e) { /* ignore */ }
    }
  } catch (e) {
    // performSync has its own try/catch but be defensive
    await appendSyncLog({ at: new Date().toISOString(), triggeredBy: 'alarm', ok: false, error: 'Alarm handler crash: ' + e.message });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await migrateLegacyTokens();
  await rescheduleAlarm();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarmHealthy();
});

// Self-healing: every time the service worker wakes, make sure the alarm
// is still scheduled. MV3 SWs are aggressively unloaded; if the alarm got
// dropped (e.g. extension was disabled briefly), recreate it.
async function ensureAlarmHealthy() {
  try {
    const s = await getSettings();
    if (!s.autoSync) return;
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (!existing) {
      await rescheduleAlarm();
      await appendSyncLog({ at: new Date().toISOString(), triggeredBy: 'self-heal', ok: true, note: 'Re-armed missing alarm' });
    } else if (s.autoSyncMode === 'daily' && s.nextScheduledAt) {
      // Sanity check: stored nextScheduledAt should match the alarm's scheduledTime.
      // If they're more than a minute apart, alarm is stale → reschedule.
      const drift = Math.abs(existing.scheduledTime - new Date(s.nextScheduledAt).getTime());
      if (drift > 60000) await rescheduleAlarm();
    }
  } catch (e) { /* silent */ }
}

// Run health check on every SW wake (top-level statement = runs on every cold start).
ensureAlarmHealthy();

// ───────────────────────────────────────────────────────────────
// Migration — move pre-1.2.0 tokens (autoToken / manualToken) into accounts[]
// ───────────────────────────────────────────────────────────────
async function migrateLegacyTokens() {
  const stored = await chrome.storage.local.get(['accounts', 'autoToken', 'manualToken']);
  if (Array.isArray(stored.accounts) && stored.accounts.length > 0) return; // already migrated

  const newAccounts = [];
  if (stored.manualToken && stored.manualToken.trim()) {
    const tok = stored.manualToken.trim();
    const decoded = decodeJwt(tok);
    newAccounts.push({
      id: accountIdFor(decoded, tok),
      email: decoded.email,
      label: decoded.email ? decoded.email.split('@')[0] : 'Manual',
      accessToken: tok,
      refreshToken: null,
      expiresAt: decoded.exp,
      addedVia: 'manual',
      addedAt: new Date().toISOString(),
      enabled: true,
      lastError: null, lastErrorAt: null, lastSuccessAt: null
    });
  }
  if (stored.autoToken && (!newAccounts.length || decodeJwt(stored.autoToken).sub !== newAccounts[0].id)) {
    const tok = stored.autoToken;
    const decoded = decodeJwt(tok);
    newAccounts.push({
      id: accountIdFor(decoded, tok),
      email: decoded.email,
      label: decoded.email ? decoded.email.split('@')[0] : 'Auto',
      accessToken: tok,
      refreshToken: null,
      expiresAt: decoded.exp,
      addedVia: 'auto',
      addedAt: new Date().toISOString(),
      enabled: true,
      lastError: null, lastErrorAt: null, lastSuccessAt: null
    });
  }
  if (newAccounts.length) await saveAccounts(newAccounts);
  await chrome.storage.local.remove(['autoToken', 'manualToken']);
}

// ───────────────────────────────────────────────────────────────
// Message router
// ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'TOKEN_UPDATE': {
          // Receives the FULL session from content.js: { accessToken, refreshToken, expiresAt }
          const session = msg.session || (msg.token ? { accessToken: msg.token } : null);
          if (!session?.accessToken) {
            await chrome.storage.local.remove(['currentAutoSession']);
            sendResponse({ ok: true });
            break;
          }
          const decoded = decodeJwt(session.accessToken);
          await chrome.storage.local.set({
            currentAutoSession: {
              accessToken: session.accessToken,
              refreshToken: session.refreshToken || null,
              expiresAt: session.expiresAt || decoded.exp || null,
              email: decoded.email,
              sub: decoded.sub,
              capturedAt: new Date().toISOString()
            }
          });
          // Auto-add OR refresh-tokens-for-existing
          const accounts = await getAccounts();
          const id = accountIdFor(decoded, session.accessToken);
          const existing = accounts.find(a => a.id === id);
          const wasEmpty = accounts.length === 0;
          let autoAdded = false;
          if (existing) {
            await updateAccount(id, {
              accessToken: session.accessToken,
              refreshToken: session.refreshToken || existing.refreshToken,
              expiresAt: session.expiresAt || decoded.exp || existing.expiresAt,
              email: decoded.email || existing.email
            });
          } else if (wasEmpty) {
            // First account: auto-add for friction-free single-account flow
            await upsertAccount({
              id, email: decoded.email,
              label: decoded.email ? decoded.email.split('@')[0] : 'Main',
              accessToken: session.accessToken,
              refreshToken: session.refreshToken || null,
              expiresAt: session.expiresAt || decoded.exp || null,
              addedVia: 'auto'
            });
            autoAdded = true;
          }
          sendResponse({ ok: true, email: decoded.email, autoAdded });
          break;
        }
        case 'ADD_CURRENT_ACCOUNT': {
          // User clicked "Add current account" in options
          const cur = (await chrome.storage.local.get(['currentAutoSession'])).currentAutoSession;
          if (!cur?.accessToken) {
            sendResponse({ ok: false, error: 'No current session detected — open manage.unitynodes.io and sign in first.' });
            break;
          }
          const decoded = decodeJwt(cur.accessToken);
          const id = accountIdFor(decoded, cur.accessToken);
          await upsertAccount({
            id, email: cur.email || decoded.email,
            label: msg.label || (cur.email ? cur.email.split('@')[0] : 'Account'),
            accessToken: cur.accessToken,
            refreshToken: cur.refreshToken,
            expiresAt: cur.expiresAt,
            addedVia: 'auto'
          });
          sendResponse({ ok: true, id, email: cur.email });
          break;
        }
        case 'ADD_ACCOUNT_FROM_TOKEN': {
          // User pasted either an access_token or the full JSON from localStorage
          const raw = (msg.input || '').trim();
          if (!raw) { sendResponse({ ok: false, error: 'Empty input' }); break; }
          let accessToken = raw;
          let refreshToken = null;
          let expiresAt = null;
          if (raw.startsWith('{')) {
            try {
              const parsed = JSON.parse(raw);
              accessToken = parsed.access_token || parsed.accessToken;
              refreshToken = parsed.refresh_token || parsed.refreshToken || null;
              expiresAt = parsed.expires_at || parsed.expiresAt || null;
            } catch (e) {
              sendResponse({ ok: false, error: 'Could not parse JSON: ' + e.message });
              break;
            }
          }
          if (!accessToken) { sendResponse({ ok: false, error: 'No access_token found in input.' }); break; }
          const decoded = decodeJwt(accessToken);
          const id = accountIdFor(decoded, accessToken);
          await upsertAccount({
            id, email: decoded.email,
            label: msg.label || (decoded.email ? decoded.email.split('@')[0] : 'Manual'),
            accessToken, refreshToken,
            expiresAt: expiresAt || decoded.exp,
            addedVia: 'manual'
          });
          sendResponse({ ok: true, id, email: decoded.email });
          break;
        }
        case 'REMOVE_ACCOUNT': {
          await removeAccountById(msg.id);
          sendResponse({ ok: true });
          break;
        }
        case 'UPDATE_ACCOUNT': {
          const updated = await updateAccount(msg.id, msg.patch || {});
          sendResponse({ ok: !!updated, account: updated });
          break;
        }
        case 'REFRESH_ACCOUNT': {
          const accounts = await getAccounts();
          const acc = accounts.find(a => a.id === msg.id);
          if (!acc) { sendResponse({ ok: false, error: 'Account not found' }); break; }
          try {
            const refreshed = await refreshAccountToken(acc);
            const updated = await updateAccount(acc.id, { ...refreshed, lastError: null, lastErrorAt: null });
            sendResponse({ ok: true, account: updated });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }
        case 'SYNC_NOW': {
          const result = await performSync({ triggeredBy: msg.triggeredBy || 'popup' });
          sendResponse(result);
          break;
        }
        case 'TEST_DESTINATION': {
          sendResponse(await testDestination());
          break;
        }
        case 'GET_STATUS': {
          const s = await getSettings();
          const cur = (await chrome.storage.local.get(['currentAutoSession'])).currentAutoSession;
          sendResponse({
            ok: true,
            settings: s,
            accounts: s.accounts || [],
            currentAutoSession: cur || null
          });
          break;
        }
        case 'GET_DIAGNOSTICS': {
          const s = await getSettings();
          const stored = await chrome.storage.local.get(['syncLog']);
          const alarm = await chrome.alarms.get(ALARM_NAME);
          sendResponse({
            ok: true,
            autoSync: s.autoSync,
            autoSyncMode: s.autoSyncMode,
            autoSyncDailyTime: s.autoSyncDailyTime,
            autoSyncTimezone: s.autoSyncTimezone,
            nextScheduledAt: s.nextScheduledAt,
            alarmExists: !!alarm,
            alarmScheduledTime: alarm ? new Date(alarm.scheduledTime).toISOString() : null,
            alarmPeriodInMinutes: alarm?.periodInMinutes || null,
            accountCount: (s.accounts || []).filter(a => a.enabled !== false).length,
            lastSync: s.lastSync,
            lastSyncStatus: s.lastSyncStatus,
            lastSyncError: s.lastSyncError,
            syncLog: (stored.syncLog || []).slice(-20)
          });
          break;
        }
        case 'RESCHEDULE_ALARM': {
          await rescheduleAlarm();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});
