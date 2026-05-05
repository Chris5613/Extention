# Unity Nodes Earnings Tracker — Chrome Extension

A lightweight Chrome extension that fetches your daily Unity Nodes earnings from `api.unityedge.io` and POSTs them to your own tracking site.

## Features

- **Multi-account support** — connect any number of Unity Nodes accounts. Each one is captured automatically when you sign in to `manage.unitynodes.io`, or added manually with a Bearer token.
- **Sync All / per-account sync** — one-click "Sync All" runs every enabled account in sequence; each row in the popup also has its own sync icon.
- **Auto-detects your auth token** from `manage.unitynodes.io` while you're signed in (with email OTP login). Sign into another account → it shows up automatically.
- **Manual token override per account** — paste a Bearer token if you don't want to stay signed in.
- **Popup UI** — combined totals (today + lifetime) at the top, plus a list of accounts each showing today's earnings, lifetime, sync status.
- **Auto-sync** — runs in the background every 10 min → 1 day, OR daily at a chosen time/timezone. Syncs every enabled account on each tick.
- **Per-device breakdown** — each per-account payload includes today's earnings broken down by `licenseId`.
- **Customizable destination** — sends JSON to any URL you configure, with an optional auth header. Multi-account syncs send one POST per account **plus** one combined POST with `multi: true` and an `accounts: [...]` array.
- **Test ping** — verify your destination endpoint before relying on real syncs.

## Install (Developer Mode)

1. Open Chrome → go to `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** → select the `extension/` folder.
4. Pin the extension to your toolbar (puzzle-piece icon → pin).

## First-time setup

1. Click the extension icon → **Settings** (or right-click → Options).
2. (Optional) Paste your tracking site's URL in **Destination URL** if you want HTTP POST delivery in addition to the in-page bridge.
3. (Optional) Add an auth header, e.g. name `Authorization`, value `Bearer your-api-key`.
4. Click **Send test ping** to verify — you should get `✓ Received 200`.
5. Toggle **Enable auto-sync** and pick an interval or daily time.
6. Click **Save Settings**.
7. In another tab, sign in to `https://manage.unitynodes.io` — the extension will auto-detect your token and add the account. Repeat for each Unity Nodes account you want to track.
8. Click the extension icon → **Sync All** to run your first multi-account sync.

## Adding multiple accounts

Two ways:

1. **Auto (recommended)** — sign in to each Unity Nodes account once on `manage.unitynodes.io`. Each token is decoded for its email and stored as its own account. Switching accounts on the Unity site just adds the new one without removing previous ones.
2. **Manual** — open Settings → expand "Add account manually" → paste a Bearer access_token (and optionally a label). Useful if you have a token from another browser/profile and don't want to sign in here.

In Settings, each account row lets you rename, enable/disable (controls inclusion in Sync All), override the auto-token with a manual one, or remove the account entirely.

## Payload format

Each enabled account triggers a `POST` with `Content-Type: application/json` to your destination (if configured). Body:

```json
{
  "source": "chrome-extension",
  "version": "1.2.0",
  "synced_at": "2026-02-19T14:30:00.000Z",
  "account_id": "6c0f...2d1",
  "account_label": "Personal",
  "email": "you@example.com",
  "date": "2026-02-19",
  "total_usd": 1.234567,
  "allocation_count": 12,
  "device_count": 3,
  "balance_usd": 4.825001,
  "lifetime_usd": 152.834012,
  "devices": [
    { "license_id": "abc123-def456", "amount_usd": 0.456000, "allocation_count": 4 }
  ],
  "allocations": [
    { "id": "...", "license_id": "abc123-def456", "amount_usd": 0.123, "completed_at": "2026-02-19T12:34:56.789Z" }
  ]
}
```

After all per-account POSTs, one **combined summary** POST is also sent:

```json
{
  "source": "chrome-extension",
  "version": "1.2.0",
  "multi": true,
  "synced_at": "2026-02-19T14:30:00.000Z",
  "account_count": 2,
  "ok_count": 2,
  "error_count": 0,
  "total_usd": 2.481234,
  "lifetime_usd": 318.502419,
  "balance_usd": 9.213045,
  "accounts": [ /* per-account payloads */ ]
}
```

Use the `multi: true` flag (and `account_id` on per-account messages) to dedupe and aggregate on your server.

### Expected response

Anything in the 2xx range is treated as success. The response body is ignored (only its status code matters).

### Server-side sample (Node/Express)

```js
app.post('/api/unity-sync', express.json(), (req, res) => {
  if (req.headers.authorization !== 'Bearer your-api-key') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.body.multi) {
    // Combined summary across all accounts — useful for dashboards.
    db.upsertSummary({ date: req.body.synced_at.split('T')[0], total_usd: req.body.total_usd });
    return res.json({ ok: true, kind: 'summary' });
  }
  const { date, total_usd, email, account_id, devices } = req.body;
  // upsert by (account_id, date) to avoid duplicates across accounts on the same day.
  db.upsert({ account_id, date }, { email, total_usd, devices, updated_at: new Date() });
  res.json({ ok: true });
});
```

## How the auth token is obtained

The extension's content script runs on `manage.unitynodes.io` pages and reads the Supabase session from `localStorage`. It looks for any key containing `-auth-token`, parses the JSON, and grabs the `access_token`. The token is decoded for its `email` claim, then upserted into the `accounts` list under that email — so signing into a different account simply registers another row, without overwriting previous tokens.

If you don't want to keep a tab open on `manage.unitynodes.io`, you can paste a token into the **Manual token override** field on any account in Settings — it will be used instead of the auto-detected one for that account.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker — API calls, alarms, message routing |
| `content.js` | Reads token from `localStorage` on `manage.unitynodes.io` |
| `popup.html/css/js` | Toolbar popup |
| `options.html/css/js` | Settings page |
| `icons/` | 16/48/128 px PNG icons |

## Troubleshooting

- **"No accounts configured"** → Open `https://manage.unitynodes.io`, sign in to each account once. Or in Settings → "Add account manually" → paste a token.
- **One account shows "No auth token"** → The token expired or the account hasn't been signed in to recently. Sign back in on `manage.unitynodes.io`, or paste a fresh manual token in that account's row.
- **"Partial: 2/3 ok"** → At least one account failed (usually expired token). Click that account's individual sync icon in the popup to see the specific error, then refresh that token.
- **"Destination 401/403"** → Check your auth header name/value match what your server expects.
- **"Destination 404/CORS"** → The extension bypasses CORS via `host_permissions`. If you still see CORS errors, it usually means the URL is wrong.
- **Auto-sync not running** → Make sure the **Enable auto-sync** toggle is on and hit **Save**. Chrome throttles alarms; minimum useful interval is ~1 min.
- **Migrating from v1.1.x** → Your existing single-account state is migrated automatically into one account on first launch of v1.2.0. Settings, destination URL, and auto-sync timing are preserved.

## Privacy

- All tokens and data are stored locally in `chrome.storage.local`. Nothing is sent anywhere except your configured destination URL and `api.unityedge.io`.
- No telemetry, no analytics.
