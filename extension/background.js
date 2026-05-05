// Background service worker — multi-account Unity Nodes earnings sync.
// Fetches earnings for every configured account from api.unityedge.io and pushes
// them to the in-page bridge (and optionally a configurable HTTP destination).

const API_BASE = 'https://api.unityedge.io/rest/v1/rpc/';
const API_KEY = 'sb_publishable_yKqi0fu5vV6G4ryUIMJuzw_NCoFEl1c';
const ALARM_NAME = 'unity-auto-sync';
const VERSION = '1.2.0';
const TRACKER_URL = 'https://nam-qyn8.onrender.com/';
const TRACKER_MATCH = 'https://nam-qyn8.onrender.com/*';

const DEFAULT_SETTINGS = {
  destinationUrl: '',
  authHeaderName: 'Authorization',
  authHeaderValue: '',
  autoSync: false,
  autoSyncMode: 'daily',                    // 'interval' | 'daily'
  autoSyncMinutes: 60,                      // used when mode === 'interval'
  autoSyncDailyTime: '19:20',               // used when mode === 'daily'
  autoSyncTimezone: 'America/Los_Angeles',  // IANA tz; Pacific handles PST/PDT automatically
  accounts: [],                             // list of account objects (see ACCOUNT shape below)
  lastSync: null,
  lastSyncStatus: null,                     // 'ok' | 'partial' | 'error'
  lastSyncError: null,
  lastSummary: null,                        // { total_usd, lifetime_usd, balance_usd, account_count, ok_count, error_count, date }
  lastFullPayload: null,                    // backwards-compat: first ok account's payload (single-account tracker listeners still work)
  lastMultiPayload: null,                   // combined payload for multi-aware listeners
  nextScheduledAt: null
};

// ACCOUNT shape:
// {
//   id: 'uuid',
//   label: 'Display name (defaults to email)',
//   email: 'foo@bar.com' | null,
//   autoToken: '...' | '',                  // captured from manage.unitynodes.io localStorage
//   manualToken: '...' | '',                // user-pasted override (takes precedence)
//   enabled: true,
//   lastSync: ISO | null,
//   lastSyncStatus: 'ok' | 'error' | null,
//   lastSyncError: string | null,
//   lastEarnings: { date, total_usd, lifetime_usd, balance_usd, allocation_count, device_count, email } | null,
//   lastFullPayload: payload | null         // most recent successful payload for this account
// }

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────
function uuid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* fall through */ }
  return 'a-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

function decodeJwtEmail(jwt) {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email || payload.sub || null;
  } catch (e) {
    return null;
  }
}

function sanitizeAccount(a) {
  return {
    id: a.id || uuid(),
    label: (a.label || '').trim() || a.email || 'Unity Account',
    email: a.email || null,
    autoToken: a.autoToken || '',
    manualToken: a.manualToken || '',
    enabled: a.enabled !== false,
    lastSync: a.lastSync || null,
    lastSyncStatus: a.lastSyncStatus || null,
    lastSyncError: a.lastSyncError || null,
    lastEarnings: a.lastEarnings || null,
    lastFullPayload: a.lastFullPayload || null
  };
}

function getAccountToken(acc) {
  if (acc.manualToken && acc.manualToken.trim()) return { token: acc.manualToken.trim(), source: 'manual' };
  if (acc.autoToken && acc.autoToken.trim()) return { token: acc.autoToken.trim(), source: 'auto' };
  return { token: null, source: null };
}

// ───────────────────────────────────────────────────────────────
// Legacy migration — convert old single-account storage to accounts[]
// ───────────────────────────────────────────────────────────────
async function migrateLegacyIfNeeded() {
  const stored = await chrome.storage.local.get([
    'accounts', 'autoToken', 'manualToken', 'detectedEmail', 'tokenSource', 'lastEarnings', 'lastFullPayload'
  ]);
  if (Array.isArray(stored.accounts) && stored.accounts.length > 0) return;

  const accounts = [];
  const autoTok = stored.autoToken || '';
  const manualTok = stored.manualToken || '';
  const email = stored.detectedEmail
    || (manualTok && decodeJwtEmail(manualTok))
    || (autoTok && decodeJwtEmail(autoTok))
    || null;

  if (autoTok || manualTok) {
    accounts.push(sanitizeAccount({
      id: uuid(),
      label: email || 'Account 1',
      email,
      autoToken: autoTok,
      manualToken: manualTok,
      enabled: true,
      lastEarnings: stored.lastEarnings || null,
      lastFullPayload: stored.lastFullPayload || null
    }));
  }
  await setSettings({ accounts });
}

// ───────────────────────────────────────────────────────────────
// Auto-token upsert (called from TOKEN_UPDATE)
// ───────────────────────────────────────────────────────────────
async function upsertAutoAccount(token) {
  await migrateLegacyIfNeeded();
  const email = decodeJwtEmail(token);
  const s = await getSettings();
  const accounts = (s.accounts || []).map(sanitizeAccount);

  // Match by email when we have one, otherwise by an existing auto-only account.
  let idx = -1;
  if (email) {
    idx = accounts.findIndex(a => a.email && a.email === email);
  }
  if (idx === -1 && !email) {
    // No email decoded — upsert into the first account that's auto-only and has no email.
    idx = accounts.findIndex(a => !a.email && !a.manualToken);
  }

  if (idx >= 0) {
    accounts[idx] = sanitizeAccount({
      ...accounts[idx],
      autoToken: token,
      email: email || accounts[idx].email,
      // If the label was the legacy default, refresh it to the email
      label: (accounts[idx].label === accounts[idx].email || !accounts[idx].label || accounts[idx].label === 'Unity Account' || accounts[idx].label === 'Account 1')
        ? (email || accounts[idx].label)
        : accounts[idx].label
    });
  } else {
    accounts.push(sanitizeAccount({
      id: uuid(),
      label: email || 'Unity Account',
      email,
      autoToken: token,
      manualToken: '',
      enabled: true
    }));
  }
  await setSettings({ accounts });
  return { email, count: accounts.length };
}

async function clearAutoTokenIfPresent() {
  // Called when content script finds no token (user signed out). We DON'T remove accounts —
  // we just clear the autoToken on auto-sourced accounts so manual-only accounts are unaffected.
  await migrateLegacyIfNeeded();
  const s = await getSettings();
  const accounts = (s.accounts || []).map(sanitizeAccount).map(a => {
    if (a.autoToken) return { ...a, autoToken: '' };
    return a;
  });
  await setSettings({ accounts });
}

// ───────────────────────────────────────────────────────────────
// Timezone helpers — for "daily at HH:MM in IANA tz" scheduling
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
  } catch (e) {
    return 0;
  }
}

function nextDailyUtcMs(hh, mm, timeZone) {
  const now = new Date();
  const nowMs = now.getTime();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  });
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
// Build today's earnings payload (per-account)
// ───────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

function buildPayload(allocations, balanceMicros, email) {
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
  const totalUsd = totalMicros / 1e6;
  const lifetimeMicros = (allocations || []).reduce((s, a) => s + (a.amountMicros || 0), 0);

  return {
    source: 'chrome-extension',
    version: VERSION,
    synced_at: new Date().toISOString(),
    email: email || null,
    date: usedDate,
    total_usd: Number(totalUsd.toFixed(6)),
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

// ───────────────────────────────────────────────────────────────
// POST payload to user's tracking site (optional, in addition to bridge)
// ───────────────────────────────────────────────────────────────
async function postToDestination(payload, settings) {
  if (!settings.destinationUrl) {
    throw new Error('Destination URL not set. Open extension options to configure.');
  }
  const headers = { 'content-type': 'application/json' };
  if (settings.authHeaderName && settings.authHeaderValue) {
    headers[settings.authHeaderName] = settings.authHeaderValue;
  }
  const res = await fetch(settings.destinationUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Destination ${res.status}: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: text.slice(0, 500) };
}

// ───────────────────────────────────────────────────────────────
// Sync a single account
// ───────────────────────────────────────────────────────────────
async function syncOneAccount(accountId) {
  const s = await getSettings();
  const accounts = (s.accounts || []).map(sanitizeAccount);
  const idx = accounts.findIndex(a => a.id === accountId);
  if (idx === -1) return { ok: false, error: 'Account not found', accountId };
  const acc = accounts[idx];
  const { token, source } = getAccountToken(acc);

  if (!token) {
    accounts[idx] = sanitizeAccount({
      ...acc,
      lastSync: new Date().toISOString(),
      lastSyncStatus: 'error',
      lastSyncError: 'No auth token. Open https://manage.unitynodes.io and sign in to this account, or paste a token in Settings.'
    });
    await setSettings({ accounts });
    return { ok: false, error: 'No auth token', accountId };
  }

  try {
    const [balRes, allocRes] = await Promise.allSettled([
      apiCall('rewards_get_balance', {}, token),
      apiCall('rewards_get_allocations', { skip: 0, take: 1000 }, token)
    ]);
    const balance = balRes.status === 'fulfilled' ? balRes.value : null;
    const allocations = allocRes.status === 'fulfilled' ? (allocRes.value || []) : [];
    if (allocRes.status === 'rejected') {
      throw new Error(allocRes.reason?.message || 'Failed to fetch allocations');
    }

    const email = decodeJwtEmail(token) || acc.email || null;
    const payload = buildPayload(allocations, balance, email);
    payload.account_id = acc.id;
    payload.account_label = acc.label || email || 'Unity Account';
    payload.token_source = source;

    accounts[idx] = sanitizeAccount({
      ...acc,
      email: email || acc.email,
      // Auto-update label if it was a placeholder
      label: acc.label && acc.label !== email && acc.label !== 'Unity Account' && acc.label !== 'Account 1'
        ? acc.label
        : (email || acc.label || 'Unity Account'),
      lastSync: new Date().toISOString(),
      lastSyncStatus: 'ok',
      lastSyncError: null,
      lastFullPayload: payload,
      lastEarnings: {
        date: payload.date,
        total_usd: payload.total_usd,
        allocation_count: payload.allocation_count,
        device_count: payload.device_count,
        balance_usd: payload.balance_usd,
        lifetime_usd: payload.lifetime_usd,
        email: payload.email
      }
    });
    await setSettings({ accounts });
    return { ok: true, accountId, payload };
  } catch (err) {
    const msg = err?.message || String(err);
    accounts[idx] = sanitizeAccount({
      ...acc,
      lastSync: new Date().toISOString(),
      lastSyncStatus: 'error',
      lastSyncError: msg
    });
    await setSettings({ accounts });
    return { ok: false, error: msg, accountId };
  }
}

// ───────────────────────────────────────────────────────────────
// Main sync routine — sync all enabled accounts (or one by id)
// ───────────────────────────────────────────────────────────────
async function performSync({ triggeredBy = 'manual', accountId = null } = {}) {
  await migrateLegacyIfNeeded();
  const s = await getSettings();
  const allAccounts = (s.accounts || []).map(sanitizeAccount);

  let toSync;
  if (accountId) {
    toSync = allAccounts.filter(a => a.id === accountId);
    if (toSync.length === 0) {
      return { ok: false, error: 'Account not found', triggeredBy };
    }
  } else {
    toSync = allAccounts.filter(a => a.enabled !== false);
  }

  if (toSync.length === 0) {
    const err = 'No accounts configured. Open https://manage.unitynodes.io and sign in to capture a token, or add a manual token in Settings.';
    await setSettings({
      lastSync: new Date().toISOString(),
      lastSyncStatus: 'error',
      lastSyncError: err
    });
    return { ok: false, error: err, triggeredBy };
  }

  const results = [];
  for (const acc of toSync) {
    const r = await syncOneAccount(acc.id);
    results.push(r);
  }

  const okPayloads = results.filter(r => r.ok).map(r => r.payload);
  const totalToday = okPayloads.reduce((sum, p) => sum + (p.total_usd || 0), 0);
  const totalLifetime = okPayloads.reduce((sum, p) => sum + (p.lifetime_usd || 0), 0);
  const totalBalance = okPayloads.reduce((sum, p) => sum + (p.balance_usd || 0), 0);
  const okCount = okPayloads.length;
  const errCount = results.length - okCount;

  const multiPayload = {
    source: 'chrome-extension',
    version: VERSION,
    multi: true,
    synced_at: new Date().toISOString(),
    triggered_by: triggeredBy,
    account_count: results.length,
    ok_count: okCount,
    error_count: errCount,
    total_usd: Number(totalToday.toFixed(6)),
    lifetime_usd: Number(totalLifetime.toFixed(6)),
    balance_usd: Number(totalBalance.toFixed(6)),
    accounts: okPayloads,
    errors: results.filter(r => !r.ok).map(r => ({ account_id: r.accountId, error: r.error }))
  };

  const overallStatus = errCount === 0 ? 'ok' : (okCount === 0 ? 'error' : 'partial');
  await setSettings({
    lastSync: new Date().toISOString(),
    lastSyncStatus: overallStatus,
    lastSyncError: errCount === 0
      ? null
      : results.filter(r => !r.ok).map(r => r.error).join(' · '),
    lastMultiPayload: multiPayload,
    lastFullPayload: okPayloads[0] || null,    // backwards-compat for single-account tracker listeners
    lastSummary: {
      total_usd: multiPayload.total_usd,
      lifetime_usd: multiPayload.lifetime_usd,
      balance_usd: multiPayload.balance_usd,
      account_count: multiPayload.account_count,
      ok_count: multiPayload.ok_count,
      error_count: multiPayload.error_count,
      date: okPayloads[0]?.date || null
    }
  });

  // Optional HTTP destination — one POST per account + one combined POST
  let destResults = [];
  if (s.destinationUrl) {
    for (const p of okPayloads) {
      try {
        const r = await postToDestination(p, s);
        destResults.push({ ok: true, account_id: p.account_id, status: r.status });
      } catch (err) {
        destResults.push({ ok: false, account_id: p.account_id, error: err?.message || String(err) });
      }
    }
    if (okPayloads.length > 0) {
      try {
        const r = await postToDestination(multiPayload, s);
        destResults.push({ ok: true, combined: true, status: r.status });
      } catch (err) {
        destResults.push({ ok: false, combined: true, error: err?.message || String(err) });
      }
    }
  }

  await ensureTrackerTab(triggeredBy);

  return {
    ok: overallStatus !== 'error',
    status: overallStatus,
    triggeredBy,
    results,
    summary: multiPayload,
    destinationPosted: !!s.destinationUrl,
    destResults
  };
}

async function testDestination() {
  const settings = await getSettings();
  if (!settings.destinationUrl) {
    return { ok: false, error: 'Destination URL not set.' };
  }
  try {
    const result = await postToDestination({
      source: 'chrome-extension',
      version: VERSION,
      test: true,
      multi: true,
      synced_at: new Date().toISOString(),
      message: 'Hello from Unity Nodes Earnings Tracker — this is a test ping.'
    }, settings);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ───────────────────────────────────────────────────────────────
// Account CRUD
// ───────────────────────────────────────────────────────────────
async function addManualAccount({ label, manualToken }) {
  await migrateLegacyIfNeeded();
  const tok = (manualToken || '').trim();
  if (!tok) return { ok: false, error: 'A manual token is required to add an account.' };
  const email = decodeJwtEmail(tok);
  const s = await getSettings();
  const accounts = (s.accounts || []).map(sanitizeAccount);

  // If an account with the same email already exists, just update its manualToken instead of duplicating.
  const existingIdx = email ? accounts.findIndex(a => a.email === email) : -1;
  if (existingIdx >= 0) {
    accounts[existingIdx] = sanitizeAccount({
      ...accounts[existingIdx],
      manualToken: tok,
      label: (label || '').trim() || accounts[existingIdx].label,
      enabled: true
    });
    await setSettings({ accounts });
    return { ok: true, account_id: accounts[existingIdx].id, updated: true };
  }

  const newAcc = sanitizeAccount({
    id: uuid(),
    label: (label || '').trim() || email || 'Unity Account',
    email,
    autoToken: '',
    manualToken: tok,
    enabled: true
  });
  accounts.push(newAcc);
  await setSettings({ accounts });
  return { ok: true, account_id: newAcc.id };
}

async function updateAccount({ id, patch }) {
  await migrateLegacyIfNeeded();
  const s = await getSettings();
  const accounts = (s.accounts || []).map(sanitizeAccount);
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return { ok: false, error: 'Account not found' };
  const merged = sanitizeAccount({ ...accounts[idx], ...patch });
  // Re-decode email from manualToken if it changed and provides one
  if (patch && patch.manualToken !== undefined) {
    const decoded = decodeJwtEmail((patch.manualToken || '').trim());
    if (decoded) merged.email = decoded;
  }
  accounts[idx] = merged;
  await setSettings({ accounts });
  return { ok: true };
}

async function removeAccount({ id }) {
  await migrateLegacyIfNeeded();
  const s = await getSettings();
  const accounts = (s.accounts || []).map(sanitizeAccount).filter(a => a.id !== id);
  await setSettings({ accounts });
  return { ok: true, remaining: accounts.length };
}

// ───────────────────────────────────────────────────────────────
// Alarms — auto-sync scheduling (syncs ALL enabled accounts on tick)
// ───────────────────────────────────────────────────────────────
async function rescheduleAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (!s.autoSync) {
    await setSettings({ nextScheduledAt: null });
    return;
  }

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
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: mins
    });
    await setSettings({ nextScheduledAt: new Date(Date.now() + 60000).toISOString() });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const result = await performSync({ triggeredBy: 'alarm' });
  if (!result.ok || result.status === 'partial') {
    try {
      const errMsg = (result.error || result.summary?.errors?.map(e => e.error).join('; ') || 'Sync failed.').slice(0, 200);
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: result.status === 'partial' ? 'Unity Sync — partial failure' : 'Unity Sync Failed',
        message: errMsg
      });
    } catch (e) { /* notifications may be disabled */ }
  }
  // Daily mode uses one-shot alarms — reschedule for next day after firing
  const s = await getSettings();
  if (s.autoSync && s.autoSyncMode === 'daily') {
    await rescheduleAlarm();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await migrateLegacyIfNeeded();
  await rescheduleAlarm();
});
chrome.runtime.onStartup.addListener(async () => {
  await migrateLegacyIfNeeded();
  await rescheduleAlarm();
});

// ───────────────────────────────────────────────────────────────
// Message router
// ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'TOKEN_UPDATE': {
          // From content script — auto-detected token on manage.unitynodes.io
          if (msg.token) {
            const r = await upsertAutoAccount(msg.token);
            sendResponse({ ok: true, email: r.email, account_count: r.count });
          } else {
            await clearAutoTokenIfPresent();
            sendResponse({ ok: true });
          }
          break;
        }
        case 'SYNC_NOW': {
          const result = await performSync({
            triggeredBy: msg.triggeredBy || 'popup',
            accountId: msg.accountId || null
          });
          sendResponse(result);
          break;
        }
        case 'TEST_DESTINATION': {
          const result = await testDestination();
          sendResponse(result);
          break;
        }
        case 'GET_STATUS': {
          await migrateLegacyIfNeeded();
          const s = await getSettings();
          sendResponse({
            ok: true,
            settings: s,
            accounts: (s.accounts || []).map(sanitizeAccount)
          });
          break;
        }
        case 'ADD_MANUAL_ACCOUNT': {
          const result = await addManualAccount({ label: msg.label, manualToken: msg.manualToken });
          sendResponse(result);
          break;
        }
        case 'UPDATE_ACCOUNT': {
          const result = await updateAccount({ id: msg.id, patch: msg.patch || {} });
          sendResponse(result);
          break;
        }
        case 'REMOVE_ACCOUNT': {
          const result = await removeAccount({ id: msg.id });
          sendResponse(result);
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
  return true; // async response
});
