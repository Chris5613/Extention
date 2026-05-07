// Content script — runs on manage.unitynodes.io
// Reads the Supabase auth token from localStorage and forwards it to the background worker.

(function () {
  'use strict';

  function decodeJwtPayload(token) {
    try {
      const payload = token.split('.')[1];
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
      const json = atob(padded);
      return JSON.parse(decodeURIComponent(escape(json)));
    } catch (e) {
      return null;
    }
  }

  function extractToken(value) {
    if (typeof value !== 'string') return null;

    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.access_token === 'string') return parsed.access_token;
        if (parsed.currentSession && typeof parsed.currentSession.access_token === 'string') return parsed.currentSession.access_token;
        if (parsed.auth && parsed.auth.session && typeof parsed.auth.session.access_token === 'string') return parsed.auth.session.access_token;
        if (parsed.session && typeof parsed.session.access_token === 'string') return parsed.session.access_token;
      }
    } catch (e) {
      // Not JSON or not a token payload.
    }

    // Fallback: raw token string if it looks like a JWT.
    const jwtMatch = value.match(/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
    if (jwtMatch) return jwtMatch[1];

    return null;
  }

  function isValidToken(token) {
    if (!token || typeof token !== 'string') return false;
    const payload = decodeJwtPayload(token);
    if (!payload) return false;
    if (typeof payload.exp === 'number') {
      const now = Math.floor(Date.now() / 1000);
      return payload.exp >= now;
    }
    return true;
  }

  function findAuthTokens() {
    try {
      const tokens = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const val = localStorage.getItem(key);
        if (!val) continue;

        const token = extractToken(val);
        if (!token || !isValidToken(token)) continue;
        if (!tokens.includes(token)) tokens.push(token);
      }
      return tokens;
    } catch (e) { /* localStorage blocked */ }
    return [];
  }

  let lastSentTokens = null;

  function sendTokenIfChanged() {
    const tokens = findAuthTokens();
    const normalized = JSON.stringify(tokens.sort());
    if (normalized === lastSentTokens) return;
    lastSentTokens = normalized;
    try {
      chrome.runtime.sendMessage({ type: 'TOKEN_UPDATE', tokens }, () => {
        if (chrome.runtime.lastError) { /* silent */ }
      });
    } catch (e) { /* extension context invalidated on reload */ }
  }

  setTimeout(sendTokenIfChanged, 500);
  setTimeout(sendTokenIfChanged, 2000);
  setInterval(sendTokenIfChanged, 30000);
  window.addEventListener('focus', sendTokenIfChanged);
})();
