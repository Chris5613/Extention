// content-app.js
// Runs on the Net Worth tracker page (https://nam-qyn8.onrender.com/*).
// Bridges chrome.storage.local <-> the page via window.postMessage so the
// extension can deliver Unity Nodes earnings directly to the React app
// without going through any server.
//
// Protocol (origin must match window.location.origin on both sides):
//
//   ext  → app:  { source: "unity-nodes-tracker-ext", type: "READY" }
//   ext  → app:  { source: "unity-nodes-tracker-ext", type: "EARNINGS_PUSH", payload: {...} }
//   app  → ext:  { source: "unity-nodes-tracker-app", type: "REQUEST_LATEST" }

(function () {
  'use strict';

  const EXT_SOURCE = 'unity-nodes-tracker-ext';
  const APP_SOURCE = 'unity-nodes-tracker-app';
  const STORAGE_KEY = 'lastFullPayload';

  function postToPage(message) {
    try {
      window.postMessage(message, window.location.origin);
    } catch (err) {
      // Page may have navigated away; nothing useful we can do.
    }
  }

  // Push the cached payload (if any) to the page.
  async function pushLatest() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY]);
      const payload = stored && stored[STORAGE_KEY];
      if (payload) {
        postToPage({ source: EXT_SOURCE, type: 'EARNINGS_PUSH', payload });
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

  // Live-push when background.js completes a fresh sync.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORAGE_KEY]?.newValue) {
        postToPage({
          source: EXT_SOURCE,
          type: 'EARNINGS_PUSH',
          payload: changes[STORAGE_KEY].newValue,
        });
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
