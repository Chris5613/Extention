# Unity Nodes Earnings Tracker — Chrome Extension

A lightweight Chrome extension that fetches your daily Unity Nodes earnings from `api.unityedge.io` and POSTs them to your own tracking site.

## Features

- **Auto-detects your auth token** from `manage.unitynodes.io` while you're signed in (with email OTP login).
- **Manual token override** — paste a Bearer token if you don't want to stay signed in.
- **Popup UI** — shows today's total, balance, lifetime earnings, device count, and last-sync status.
- **Auto-sync** — runs in the background every 10 min → 1 day (configurable).
- **Manual sync** — one-click "Sync Now" button in the popup.
- **Per-device breakdown** — payload includes today's earnings broken down by `licenseId`.
- **Customizable destination** — sends JSON to any URL you configure, with an optional auth header (e.g. `Authorization: Bearer your-api-key`).
- **Test ping** — verify your destination endpoint before relying on real syncs.

## Install (Developer Mode)

1. Open Chrome → go to `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** → select the `extension/` folder.
4. Pin the extension to your toolbar (puzzle-piece icon → pin).

## First-time setup

1. Click the extension icon → **Settings** (or right-click → Options).
2. Paste your tracking site's URL in **Destination URL** (e.g. `https://your-site.com/api/unity-sync`).
3. (Optional) Add an auth header, e.g. name `Authorization`, value `Bearer your-api-key`.
4. Click **Send test ping** to verify — you should get `✓ Received 200`.
5. Toggle **Enable auto-sync** and pick an interval.
6. Click **Save Settings**.
7. In another tab, sign in to `https://manage.unitynodes.io` — the extension will auto-detect your token.
8. Click the extension icon → **Sync Now** to run your first sync.

## Payload format

Your destination endpoint receives a `POST` with `Content-Type: application/json`. Body:

```json
{
  "source": "chrome-extension",
  "version": "1.0.0",
  "synced_at": "2025-02-19T14:30:00.000Z",
  "email": "you@example.com",
  "date": "2025-02-19",
  "total_usd": 1.234567,
  "allocation_count": 12,
  "device_count": 3,
  "balance_usd": 4.825001,
  "lifetime_usd": 152.834012,
  "devices": [
    { "license_id": "abc123-def456", "amount_usd": 0.456000, "allocation_count": 4 }
  ],
  "allocations": [
    { "id": "...", "license_id": "abc123-def456", "amount_usd": 0.123, "completed_at": "2025-02-19T12:34:56.789Z" }
  ]
}
```

### Expected response

Anything in the 2xx range is treated as success. The response body is ignored (only its status code matters).

### Server-side sample (Node/Express)

```js
app.post('/api/unity-sync', express.json(), (req, res) => {
  if (req.headers.authorization !== 'Bearer your-api-key') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { date, total_usd, email, devices } = req.body;
  // upsert by (email, date) to avoid duplicates
  db.upsert({ email, date }, { total_usd, devices, updated_at: new Date() });
  res.json({ ok: true });
});
```

## How the auth token is obtained

The extension's content script runs on `manage.unitynodes.io` pages and reads the Supabase session from `localStorage`. It looks for any key containing `-auth-token`, parses the JSON, and grabs the `access_token`. The token is then stored in `chrome.storage.local` and used by the background service worker to call `api.unityedge.io`.

If you don't want to keep a tab open on `manage.unitynodes.io`, you can paste a token into the **Manual token override** field in Settings — it will be used instead of the auto-detected one.

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

- **"No auth token"** → Open `https://manage.unitynodes.io`, sign in, then try again. Or paste a token in Settings.
- **"Destination 401/403"** → Check your auth header name/value match what your server expects.
- **"Destination 404/CORS"** → The extension bypasses CORS via `host_permissions`. If you still see CORS errors, it usually means the URL is wrong.
- **Auto-sync not running** → Make sure the **Enable auto-sync** toggle is on and hit **Save**. Chrome throttles alarms; minimum useful interval is ~1 min.

## Privacy

- All tokens and data are stored locally in `chrome.storage.local`. Nothing is sent anywhere except your configured destination URL and `api.unityedge.io`.
- No telemetry, no analytics.
