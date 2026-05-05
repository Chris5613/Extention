// Background service worker — handles API calls to Unity Edge and syncs to user's tracking site.

const API_BASE = 'https://api.unityedge.io/rest/v1/rpc/';
const API_KEY = 'sb_publishable_yKqi0fu5vV6G4ryUIMJuzw_NCoFEl1c';
const ALARM_NAME = 'unity-auto-sync';
const VERSION = '1.0.0';

const DEFAULT_SETTINGS = {
  destinationUrl: '',
  authHeaderName: 'Authorization',
  authHeaderValue: '',
  autoSync: false,
  autoSyncMinutes: 60,
  manualToken: '',
  lastSync: null,
  lastSyncStatus: null, // 'ok' | 'error'
  lastSyncError: null,
  lastEarnings: null,    // { date, total_usd, allocation_count, device_count, email }
  tokenSource: null,     // 'auto' | 'manual' | null
  detectedEmail: null
};

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────
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

// Get the token to use — manual override if set, else auto-detected.
async function resolveToken() {
  const s = await getSettings();
  if (s.manualToken && s.manualToken.trim()) {
    return { token: s.manualToken.trim(), source: 'manual' };
  }
  const auto = await chrome.storage.local.get(['autoToken']);
  if (auto.autoToken) {
    return { token: auto.autoToken, source: 'auto' };
  }
  return { token: null, source: null };
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
// Build today's earnings payload
// ───────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

function buildPayload(allocations, balanceMicros, email) {
  // Determine "today" — try local date first, fall back to most recent allocation date
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

  // Today's items: matching local or UTC today, else fall back to latest date in data
  let todayItems = (allocations || []).filter(a => {
    const d = (a.completedAt || '').split('T')[0];
    return d === todayLocal || d === todayUtc;
  });
  let usedDate = todayLocal;
  if (!todayItems.length) {
    todayItems = (allocations || []).filter(a => (a.completedAt || '').split('T')[0] === latestDate);
    usedDate = latestDate;
  }

  // Per-device breakdown for today
  const perDevice = {};
  todayItems.forEach(a => {
    const id = a.licenseId || 'unknown';
    if (!perDevice[id]) perDevice[id] = { license_id: id, amount_usd: 0, allocation_count: 0 };
    perDevice[id].amount_usd += (a.amountMicros || 0) / 1e6;
    perDevice[id].allocation_count += 1;
  });

  const totalMicros = todayItems.reduce((s, a) => s + (a.amountMicros || 0), 0);
  const totalUsd = totalMicros / 1e6;

  // Lifetime total across all allocations
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
    devices: Object.values(perDevice).map(d => ({
      ...d,
      amount_usd: Number(d.amount_usd.toFixed(6))
    })),
    allocations: todayItems.map(a => ({
      id: a.id,
      license_id: a.licenseId,
      amount_usd: Number(((a.amountMicros || 0) / 1e6).toFixed(6)),
      completed_at: a.completedAt
    }))
  };
}

// ───────────────────────────────────────────────────────────────
// POST payload to user's tracking site
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
// Main sync routine
// ───────────────────────────────────────────────────────────────
async function performSync({ triggeredBy = 'manual' } = {}) {
  const settings = await getSettings();
  const { token, source } = await resolveToken();

  if (!token) {
    const err = 'No auth token. Open https://manage.unitynodes.io and sign in, or paste a token in Settings.';
    await setSettings({
      lastSync: new Date().toISOString(),
      lastSyncStatus: 'error',
      lastSyncError: err,
      tokenSource: null
    });
    return { ok: false, error: err };
  }

  const email = decodeJwtEmail(token);
  await setSettings({ tokenSource: source, detectedEmail: email });

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

    const payload = buildPayload(allocations, balance, email);

    // If destination URL is configured, POST it
    let destResult = null;
    if (settings.destinationUrl) {
      destResult = await postToDestination(payload, settings);
    }

    await setSettings({
      lastSync: new Date().toISOString(),
      lastSyncStatus: 'ok',
      lastSyncError: null,
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

    return {
      ok: true,
      triggeredBy,
      payload,
      destinationPosted: !!settings.destinationUrl,
      destResult
    };
  } catch (err) {
    const msg = err?.message || String(err);
    await setSettings({
      lastSync: new Date().toISOString(),
      lastSyncStatus: 'error',
      lastSyncError: msg
    });
    return { ok: false, error: msg };
  }
}

// ───────────────────────────────────────────────────────────────
// Test destination endpoint with a tiny payload
// ───────────────────────────────────────────────────────────────
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
      synced_at: new Date().toISOString(),
      message: 'Hello from Unity Nodes Earnings Tracker — this is a test ping.'
    }, settings);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ───────────────────────────────────────────────────────────────
// Alarms — auto-sync scheduling
// ───────────────────────────────────────────────────────────────
async function rescheduleAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (s.autoSync && s.autoSyncMinutes >= 1) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: Math.max(1, s.autoSyncMinutes)
    });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const result = await performSync({ triggeredBy: 'alarm' });
  if (!result.ok) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Unity Sync Failed',
        message: result.error?.slice(0, 200) || 'Unknown error'
      });
    } catch (e) { /* notifications may be disabled */ }
  }
});

chrome.runtime.onInstalled.addListener(rescheduleAlarm);
chrome.runtime.onStartup.addListener(rescheduleAlarm);

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
            const email = decodeJwtEmail(msg.token);
            await chrome.storage.local.set({ autoToken: msg.token });
            await setSettings({ detectedEmail: email, tokenSource: 'auto' });
            sendResponse({ ok: true, email });
          } else {
            await chrome.storage.local.remove(['autoToken']);
            sendResponse({ ok: true });
          }
          break;
        }
        case 'SYNC_NOW': {
          const result = await performSync({ triggeredBy: msg.triggeredBy || 'popup' });
          sendResponse(result);
          break;
        }
        case 'TEST_DESTINATION': {
          const result = await testDestination();
          sendResponse(result);
          break;
        }
        case 'GET_STATUS': {
          const s = await getSettings();
          const autoTok = await chrome.storage.local.get(['autoToken']);
          sendResponse({
            ok: true,
            settings: s,
            hasAutoToken: !!autoTok.autoToken,
            hasManualToken: !!(s.manualToken && s.manualToken.trim())
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
  return true; // async response
});
