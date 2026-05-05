// Content script — runs on manage.unitynodes.io
// Reads the FULL Supabase session (access_token + refresh_token + expires_at)
// from localStorage and forwards it to the background worker.

(function () {
  'use strict';

  function findAuthSession() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.includes('-auth-token')) {
          const val = localStorage.getItem(key);
          if (!val) continue;
          try {
            const parsed = JSON.parse(val);
            if (parsed?.access_token) {
              return {
                accessToken: parsed.access_token,
                refreshToken: parsed.refresh_token || null,
                expiresAt: parsed.expires_at || null
              };
            }
          } catch (e) { /* not JSON */ }
        }
      }
    } catch (e) { /* localStorage blocked */ }
    return null;
  }

  let lastSentAccessToken = null;

  function sendIfChanged() {
    const session = findAuthSession();
    const tok = session?.accessToken || null;
    if (tok === lastSentAccessToken) return;
    lastSentAccessToken = tok;
    try {
      chrome.runtime.sendMessage(
        { type: 'TOKEN_UPDATE', session, token: tok /* legacy back-compat */ },
        () => { if (chrome.runtime.lastError) { /* silent */ } }
      );
    } catch (e) { /* extension context invalidated on reload */ }
  }

  // Initial send (slight delay to let the app populate localStorage)
  setTimeout(sendIfChanged, 500);
  setTimeout(sendIfChanged, 2000);

  // Re-check periodically — token may refresh
  setInterval(sendIfChanged, 30000);

  // Also re-check when the tab regains focus
  window.addEventListener('focus', sendIfChanged);
})();
