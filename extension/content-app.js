// content-app.js
// Runs on the Net Worth tracker page (https://nam-qyn8.onrender.com/*).
// Bridges chrome.storage.local <-> the page via window.postMessage so the
// extension can deliver Unity Nodes earnings (multi-account aware) directly
// to the React app without going through any server.
//
// Protocol (origin must match window.location.origin on both sides):
//
//   ext  → app:  { source: "unity-nodes-tracker-ext", type: "READY" }
//   ext  → app:  { source: "unity-nodes-tracker-ext", type: "EARNINGS_PUSH", payload: {...} }
//   ext  → app:  { source: "unity-nodes-tracker-ext", type: "EARNINGS_PUSH_MULTI", payload: {accounts:[...], total_usd, lifetime_usd, ...} }
//   app  → ext:  { source: "unity-nodes-tracker-app", type: "REQUEST_LATEST" }

(function () {
  'use strict';

  const EXT_SOURCE = 'unity-nodes-tracker-ext';
  const APP_SOURCE = 'unity-nodes-tracker-app';
  const STORAGE_KEY_SINGLE = 'lastFullPayload';
  const STORAGE_KEY_MULTI = 'lastMultiPayload';

  function postToPage(message) {
    try {
      window.postMessage(message, window.location.origin);
    } catch (err) {
      // Page may have navigated away; nothing useful we can do.
    }
  }

  // Push everything we have cached: emit one EARNINGS_PUSH per FRESHLY-refreshed
  // account in the multi payload (avoids re-replaying stale per-account data
  // on every sync), and one EARNINGS_PUSH_MULTI with the full combined summary
  // (which contains every enabled account's latest known reading — fresh + cached).
  // If only the legacy single payload exists, fall back to that.
  async function pushLatest() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY_MULTI, STORAGE_KEY_SINGLE]);
      const multi = stored && stored[STORAGE_KEY_MULTI];
      const single = stored && stored[STORAGE_KEY_SINGLE];

      if (multi && Array.isArray(multi.accounts) && multi.accounts.length > 0) {
        const freshIds = Array.isArray(multi.fresh_account_ids) ? new Set(multi.fresh_account_ids) : null;
        for (const p of multi.accounts) {
          // If the multi payload tagged which accounts were fresh, only emit
          // per-account EARNINGS_PUSH for those. Older payloads without that
          // tag fall back to emitting all (backwards compatible).
          if (freshIds && !freshIds.has(p.account_id)) continue;
          postToPage({ source: EXT_SOURCE, type: 'EARNINGS_PUSH', payload: p });
        }
        postToPage({ source: EXT_SOURCE, type: 'EARNINGS_PUSH_MULTI', payload: multi });
      } else if (single) {
        postToPage({ source: EXT_SOURCE, type: 'EARNINGS_PUSH', payload: single });
      }
    } catch (err) {
      // Extension context may be invalidated on reload — silent.
    }
  }

  // Announce ourselves so the page can mark "extension detected" and
  // optionally fire a REQUEST_LATEST back at us.
  postToPage({ source: EXT_SOURCE, type: 'READY' });

  // Push whatever's already cached (covers the case where the page loaded
  // *after* the extension's most recent sync completed).
  pushLatest();

  // Live-push when background.js completes a fresh sync. We watch the multi key
  // because background.js always writes both keys atomically — preferring multi
  // avoids double-emitting on the same sync.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const multiChange = changes[STORAGE_KEY_MULTI];
      if (multiChange && multiChange.newValue) {
        const multi = multiChange.newValue;
        if (Array.isArray(multi.accounts)) {
          const freshIds = Array.isArray(multi.fresh_account_ids) ? new Set(multi.fresh_account_ids) : null;
          for (const p of multi.accounts) {
            if (freshIds && !freshIds.has(p.account_id)) continue;
            postToPage({ source: EXT_SOURCE, type: 'EARNINGS_PUSH', payload: p });
          }
        }
        postToPage({ source: EXT_SOURCE, type: 'EARNINGS_PUSH_MULTI', payload: multi });
        return;
      }
      // Fallback: legacy storage path — should rarely fire in v1.2+ since both keys
      // are always written together, but kept for defensive backwards compatibility.
      const singleChange = changes[STORAGE_KEY_SINGLE];
      if (singleChange && singleChange.newValue) {
        postToPage({ source: EXT_SOURCE, type: 'EARNINGS_PUSH', payload: singleChange.newValue });
      }
    });
  } catch (err) {
    // chrome.storage may be unavailable in some contexts — silent.
  }

  // Page can ask for the latest cached reading on demand (used by the
  // "Sync from extension" button).
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== APP_SOURCE) return;
    if (data.type === 'REQUEST_LATEST') {
      pushLatest();
    }
  });
})();
