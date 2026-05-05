// Content script — runs on manage.unitynodes.io
// Reads the Supabase auth token from localStorage and forwards it to the background worker.

(function () {
  'use strict';

  function findAuthToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.includes('-auth-token')) {
          const val = localStorage.getItem(key);
          if (!val) continue;
          try {
            const parsed = JSON.parse(val);
            if (parsed?.access_token) return parsed.access_token;
          } catch (e) { /* not JSON */ }
        }
      }
    } catch (e) { /* localStorage blocked */ }
    return null;
  }

  let lastSentToken = null;

  function sendTokenIfChanged() {
    const token = findAuthToken();
    if (token === lastSentToken) return;
    lastSentToken = token;
    try {
      chrome.runtime.sendMessage({ type: 'TOKEN_UPDATE', token }, () => {
        if (chrome.runtime.lastError) { /* silent */ }
      });
    } catch (e) { /* extension context invalidated on reload */ }
  }

  setTimeout(sendTokenIfChanged, 500);
  setTimeout(sendTokenIfChanged, 2000);
  setInterval(sendTokenIfChanged, 30000);
  window.addEventListener('focus', sendTokenIfChanged);
})();
