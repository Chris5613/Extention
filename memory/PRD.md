# Unity Nodes Earnings Tracker — Chrome Extension

## Original Problem Statement
> "I want help creating a google chrome extension. It will take in an auth token and will get my earnings for the day then sends it to my own site that will be used to track it everyday."

User uploaded `Unity Nodes Dashboard Pro-3.31.user.txt` (a Tampermonkey userscript) for reference.

## User Choices
- **Scope**: Chrome extension ONLY (no tracking dashboard built — user POSTs data to their own site)
- **Run mode**: Both auto-run (background service worker on `manage.unitynodes.io` pages) + popup with manual sync & status
- **Token input**: Auto-detect Bearer token from `manage.unitynodes.io` localStorage, with manual override option
- **Destination site auth**: User-configurable header (e.g. `Authorization: Bearer <api-key>`)
- Note: Unity site itself uses email OTP login; extension just reads the resulting Supabase session token

## Architecture
Manifest V3 Chrome extension located at `/app/extension/`:

| File | Role |
|---|---|
| `manifest.json` | MV3, permissions: storage, alarms, notifications; host perms for manage.unitynodes.io, api.unityedge.io, and any user-configured destination |
| `background.js` | Service worker. Fetches `rewards_get_balance` + `rewards_get_allocations` from `api.unityedge.io/rest/v1/rpc/`, builds today's payload (per-device breakdown + allocations), POSTs JSON to user's destination. Handles `chrome.alarms` for auto-sync. |
| `content.js` | Injected into `manage.unitynodes.io`. Reads Supabase `access_token` from `localStorage` keys containing `-auth-token` and relays to background via `chrome.runtime.sendMessage`. |
| `popup.html/css/js` | Toolbar popup: today's USD total, balance, lifetime, device count, token-status pill, Sync Now + Settings buttons. Custom dark theme with Geist + JetBrains Mono. |
| `options.html/css/js` | Full settings page: destination URL, auth header name/value, auto-sync toggle + interval, manual token override, test ping, sample payload preview. |
| `icons/` | 16/48/128px PNG icons (generated) |
| `README.md` | Install, setup, payload format, troubleshooting |

Packaged zip at `/app/unity-nodes-earnings-tracker.zip` for easy distribution.

## Core Requirements (static)
- Extension must auto-grab Supabase `access_token` from Unity's localStorage.
- Extension must call Unity Edge API with the correct `apikey`, `authorization`, `content-profile`, `x-client-info` headers.
- Extension must POST a well-structured JSON payload (today's total, per-device breakdown, allocations, balance, lifetime) to the user-configured URL.
- Optional custom auth header for destination.
- Auto-sync via `chrome.alarms`, configurable 10 min → 1 day.

## What's Been Implemented (Feb 2026)
- Complete MV3 Chrome extension (10 files + 3 icons)
- Auto-detect token via content script, manual override via options page
- Popup UI with today's earnings, balance, lifetime, device count, token state pill, last-sync timestamp
- Options page with destination URL, auth header, auto-sync toggle + interval dropdown, manual token, test-ping button, sample JSON payload preview
- Background service worker with message router (TOKEN_UPDATE, SYNC_NOW, TEST_DESTINATION, GET_STATUS, RESCHEDULE_ALARM)
- Error handling: failed syncs surface in popup status + Chrome notification for background failures
- README with install guide, payload schema, sample Node/Express receiver

## v1.2.0 — Multi-account (added 2026-07)
- New `accounts: [{id, label, email, autoToken, manualToken, enabled, lastSync, lastSyncStatus, lastSyncError, lastEarnings, lastFullPayload}]` storage model
- Legacy single-account state migrated automatically into one account on first launch
- Auto-detection upserts by decoded JWT `email` — signing into another Unity account adds a new row instead of overwriting
- New message types: `ADD_MANUAL_ACCOUNT`, `UPDATE_ACCOUNT`, `REMOVE_ACCOUNT`; `SYNC_NOW` accepts optional `accountId` for per-account sync
- `performSync` iterates all enabled accounts, sets `lastMultiPayload` (combined) and `lastFullPayload` (first-ok, for backwards-compat)
- Tracker bridge (`content-app.js`) emits one `EARNINGS_PUSH` per account + a new `EARNINGS_PUSH_MULTI` message
- Optional HTTP destination: one POST per account + one combined `multi:true` POST
- Popup: combined hero totals + scrollable account list with per-row today/lifetime + per-row sync icon + "Sync All" button
- Options: "Accounts" card with rename / enable-toggle / manual-token override / remove + "Add account manually" form

## Prioritized Backlog (not implemented)
- **P1**: History of recent syncs (last 10) viewable in popup
- **P1**: Retry-with-backoff on destination POST failures
- **P2**: Optional webhook signing (HMAC-SHA256) for destination requests
- **P2**: Configurable payload template (let user pick which fields to send)

## Next Tasks
- User loads `extension/` as unpacked extension in Chrome
- User configures destination URL + auth header in Settings
- User opens `manage.unitynodes.io` once to auto-detect token
- User builds receiver endpoint on their own site
