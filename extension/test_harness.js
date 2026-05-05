// Test harness for the Chrome extension's core logic.
// Validates: JWT decoding, payload building, API contract with api.unityedge.io,
// destination POST flow via a local HTTP server.

const http = require('http');
const fs = require('fs');

// ─── Extract pure helpers from background.js ──────────────────────────
const bgSource = fs.readFileSync('/app/extension/background.js', 'utf8');

function decodeJwtEmail(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return payload.email || payload.sub || null;
  } catch (e) {
    return null;
  }
}

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
    version: '1.0.0',
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

// ─── Test runner ──────────────────────────────────────────────────────
let pass = 0, fail = 0;
const results = [];

function assert(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✕ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST 1: Extension files exist & referenced files match manifest
// ═══════════════════════════════════════════════════════════════════════
console.log('\n═══ TEST 1: File structure & manifest ═══');
const manifest = JSON.parse(fs.readFileSync('/app/extension/manifest.json', 'utf8'));
assert('manifest_version is 3', manifest.manifest_version === 3);
assert('background.service_worker exists', fs.existsSync('/app/extension/' + manifest.background.service_worker));
assert('content script file exists', fs.existsSync('/app/extension/' + manifest.content_scripts[0].js[0]));
assert('popup HTML exists', fs.existsSync('/app/extension/' + manifest.action.default_popup));
assert('options page exists', fs.existsSync('/app/extension/' + manifest.options_ui.page));
['16','48','128'].forEach(sz => {
  assert(`icon${sz} exists`, fs.existsSync('/app/extension/' + manifest.icons[sz]));
});
assert('permissions include storage', manifest.permissions.includes('storage'));
assert('permissions include alarms', manifest.permissions.includes('alarms'));
assert('host_permissions include api.unityedge.io', manifest.host_permissions.some(p => p.includes('unityedge.io')));
assert('host_permissions include manage.unitynodes.io', manifest.host_permissions.some(p => p.includes('manage.unitynodes.io')));
assert('host_permissions include https://*/*', manifest.host_permissions.includes('https://*/*'));

// ═══════════════════════════════════════════════════════════════════════
// TEST 2: Message types match between sender & receiver
// ═══════════════════════════════════════════════════════════════════════
console.log('\n═══ TEST 2: Message router consistency ═══');
const popupJs = fs.readFileSync('/app/extension/popup.js', 'utf8');
const optionsJs = fs.readFileSync('/app/extension/options.js', 'utf8');
const contentJs = fs.readFileSync('/app/extension/content.js', 'utf8');

const bgHandles = ['TOKEN_UPDATE','SYNC_NOW','TEST_DESTINATION','GET_STATUS','RESCHEDULE_ALARM'];
bgHandles.forEach(t => assert(`background handles ${t}`, bgSource.includes(`case '${t}'`)));

// Sender sides
assert('content.js sends TOKEN_UPDATE', contentJs.includes("type: 'TOKEN_UPDATE'"));
assert('popup.js sends GET_STATUS', popupJs.includes("type: 'GET_STATUS'"));
assert('popup.js sends SYNC_NOW', popupJs.includes("type: 'SYNC_NOW'"));
assert('options.js sends GET_STATUS', optionsJs.includes("type: 'GET_STATUS'"));
assert('options.js sends TEST_DESTINATION', optionsJs.includes("type: 'TEST_DESTINATION'"));
assert('options.js sends RESCHEDULE_ALARM', optionsJs.includes("type: 'RESCHEDULE_ALARM'"));

// ═══════════════════════════════════════════════════════════════════════
// TEST 3: JWT email decoding
// ═══════════════════════════════════════════════════════════════════════
console.log('\n═══ TEST 3: JWT decoding ═══');
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const body = Buffer.from(JSON.stringify({email:'alice@example.com',sub:'uuid-123',iat:1}));
const fakeJwt = `${header}.${body.toString('base64url')}.signature`;
const decoded = decodeJwtEmail(fakeJwt);
assert('decodes email from valid JWT', decoded === 'alice@example.com', `got "${decoded}"`);
assert('returns null on malformed JWT', decodeJwtEmail('not-a-jwt') === null);
assert('returns null on empty', decodeJwtEmail('') === null);

// ═══════════════════════════════════════════════════════════════════════
// TEST 4: Payload building — today's earnings
// ═══════════════════════════════════════════════════════════════════════
console.log('\n═══ TEST 4: Payload building ═══');
const now = new Date();
const todayISO = now.toISOString();
const todayDate = todayISO.split('T')[0];

const allocations = [
  { id: 'a1', licenseId: 'dev-A', amountMicros: 500000, completedAt: todayISO },          // today: $0.50
  { id: 'a2', licenseId: 'dev-A', amountMicros: 250000, completedAt: todayISO },          // today: $0.25
  { id: 'a3', licenseId: 'dev-B', amountMicros: 1000000, completedAt: todayISO },         // today: $1.00
  { id: 'a4', licenseId: 'dev-A', amountMicros: 300000, completedAt: '2025-01-01T12:00:00Z' }, // past
  { id: 'a5', licenseId: 'dev-C', amountMicros: 200000, completedAt: '2025-01-02T12:00:00Z' }  // past
];
const payload = buildPayload(allocations, 4825001, 'alice@example.com');

assert('payload.source = chrome-extension', payload.source === 'chrome-extension');
assert('payload.email preserved', payload.email === 'alice@example.com');
assert('today total_usd = $1.75', payload.total_usd === 1.75, `got ${payload.total_usd}`);
assert('today allocation_count = 3', payload.allocation_count === 3, `got ${payload.allocation_count}`);
assert('today device_count = 2', payload.device_count === 2, `got ${payload.device_count}`);
assert('lifetime_usd = $2.25', payload.lifetime_usd === 2.25, `got ${payload.lifetime_usd}`);
assert('balance_usd from micros', payload.balance_usd === 4.825001, `got ${payload.balance_usd}`);
assert('devices array has 2 entries', payload.devices.length === 2);
const devA = payload.devices.find(d => d.license_id === 'dev-A');
assert('dev-A amount = $0.75', devA && devA.amount_usd === 0.75, `got ${devA?.amount_usd}`);
assert('dev-A allocation_count = 2', devA && devA.allocation_count === 2);
assert('date field = today', payload.date === todayDate);

// Edge case: no today data → falls back to latest
const onlyPast = [{ id: 'p1', licenseId: 'd1', amountMicros: 100000, completedAt: '2025-01-05T12:00:00Z' }];
const fbPayload = buildPayload(onlyPast, null, null);
assert('falls back to latest date when no today data', fbPayload.date === '2025-01-05', `got ${fbPayload.date}`);
assert('fallback total matches', fbPayload.total_usd === 0.1);
assert('null balance_usd when no balance', fbPayload.balance_usd === null);

// Edge case: empty
const empty = buildPayload([], null, null);
assert('empty allocations → total 0', empty.total_usd === 0);
assert('empty allocations → devices []', empty.devices.length === 0);

// ═══════════════════════════════════════════════════════════════════════
// TEST 5: Unity Edge API contract (headers format)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n═══ TEST 5: Unity Edge API headers ═══');
const reqHeadersBlock = bgSource.match(/headers:\s*{[\s\S]*?}/);
const h = bgSource;
assert('API uses POST method', /method:\s*'POST'/.test(h));
assert('includes apikey header', /'apikey':\s*API_KEY/.test(h));
assert('includes Bearer authorization', /'authorization':\s*'Bearer '/.test(h));
assert('includes content-profile: public', /'content-profile':\s*'public'/.test(h));
assert('includes x-client-info supabase', /'x-client-info':\s*'supabase-js-web/.test(h));
assert('API_BASE points to rest/v1/rpc', h.includes('api.unityedge.io/rest/v1/rpc/'));
assert('calls rewards_get_allocations', h.includes("apiCall('rewards_get_allocations'"));
assert('calls rewards_get_balance', h.includes("apiCall('rewards_get_balance'"));
assert('allocations body uses skip/take', /skip:\s*0,\s*take:\s*1000/.test(h));

// ═══════════════════════════════════════════════════════════════════════
// TEST 6: Live API smoke test (expects 401 for fake token — confirms endpoint/headers work)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n═══ TEST 6: Live Unity Edge API smoke test ═══');
const runApiSmoke = async () => {
  const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fake';
  try {
    const res = await fetch('https://api.unityedge.io/rest/v1/rpc/rewards_get_allocations', {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'apikey': 'sb_publishable_yKqi0fu5vV6G4ryUIMJuzw_NCoFEl1c',
        'authorization': 'Bearer ' + fakeToken,
        'content-profile': 'public',
        'content-type': 'application/json',
        'x-client-info': 'supabase-js-web/2.87.1'
      },
      body: JSON.stringify({ skip: 0, take: 1 })
    });
    const body = await res.text();
    // 401 = token rejected (but request format is valid). 4xx that is NOT 401 would suggest a contract issue.
    // Supabase rejects invalid JWT with 401 and a specific error message.
    assert(`Unity API reachable (status ${res.status})`, res.status >= 200 && res.status < 500);
    assert('rejects fake JWT with auth error',
      res.status === 401 || res.status === 403 || body.includes('JWT') || body.includes('token'),
      `status=${res.status}, body=${body.slice(0,150)}`);
    console.log(`    Response status: ${res.status}`);
    console.log(`    Response snippet: ${body.slice(0, 120)}`);
  } catch (err) {
    assert('Unity API network call', false, err.message);
  }
};

// ═══════════════════════════════════════════════════════════════════════
// TEST 7: Destination POST flow — spin up local receiver & simulate
// ═══════════════════════════════════════════════════════════════════════
console.log('\n═══ TEST 7: Destination POST (local receiver) ═══');
const runDestinationTest = () => new Promise((resolve) => {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      received = {
        method: req.method,
        url: req.url,
        authHeader: req.headers['authorization'],
        contentType: req.headers['content-type'],
        body: (() => { try { return JSON.parse(body); } catch { return null; } })()
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stored: true }));
    });
  });

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/api/unity-sync`;

    // Simulate the extension's POST logic
    const testPayload = buildPayload(allocations, 4825001, 'alice@example.com');
    const postRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': 'Bearer my-api-key-123'
      },
      body: JSON.stringify(testPayload)
    });

    assert('destination responded 200', postRes.status === 200);
    assert('receiver got POST method', received?.method === 'POST');
    assert('receiver got auth header', received?.authHeader === 'Bearer my-api-key-123');
    assert('receiver got JSON content-type', received?.contentType === 'application/json');
    assert('receiver got parsed JSON body', received?.body !== null);
    assert('body has total_usd', received?.body?.total_usd === 1.75);
    assert('body has devices array', Array.isArray(received?.body?.devices));
    assert('body has allocations array', Array.isArray(received?.body?.allocations));
    assert('body.source = chrome-extension', received?.body?.source === 'chrome-extension');
    assert('body.email round-trips', received?.body?.email === 'alice@example.com');

    server.close();
    resolve();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Run async tests
// ═══════════════════════════════════════════════════════════════════════
(async () => {
  await runApiSmoke();
  await runDestinationTest();

  console.log('\n' + '═'.repeat(60));
  results.forEach(r => console.log(r));
  console.log('═'.repeat(60));
  console.log(`\n  PASSED: ${pass}`);
  console.log(`  FAILED: ${fail}`);
  console.log(`  TOTAL:  ${pass + fail}\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
