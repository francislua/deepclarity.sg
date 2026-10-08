/* ============================================================
   DeepClarity Diagnostics: shared sign-in and service calls
   Used by the sign-in/dashboard page and by every diagnostic.
   ============================================================ */

// ── The one place to paste the Apps Script web app address ──
const DCP_API_URL = 'https://script.google.com/macros/s/AKfycbwv6h6AH7zBSJ0xCfJlvP-GbtEIVk0qQ79WwPh3OtVYPmZoOdy7FdYM_r6VamnGDOL2Tg/exec';

const DCP = (function () {
  const KEY = 'dc_session';
  const scriptEl = document.currentScript;
  // The /diagnostics/ folder, worked out from where this file lives.
  const ROOT = new URL('./', scriptEl ? scriptEl.src : window.location.href).href;
  let memorySession = null; // fallback when the browser blocks storage

  function readSession() {
    let s = memorySession;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null') || memorySession; } catch (e) {}
    if (!s || !s.id || !s.expires) return null;
    if (new Date(s.expires) <= new Date()) { clearSession(); return null; }
    return s;
  }

  function saveSession(s) {
    memorySession = s;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
  }

  function clearSession() {
    memorySession = null;
    try { localStorage.removeItem(KEY); } catch (e) {}
    // Diagnostics keep a copy of answers in the tab for speed; don't leave it behind.
    try {
      Object.keys(sessionStorage).forEach(function (k) {
        if (k.indexOf('dc_state:') === 0) sessionStorage.removeItem(k);
      });
    } catch (e) {}
  }

  // Google occasionally holds a request for 20+ seconds or returns an error
  // page instead of an answer. Each attempt is given ATTEMPT_MS, and a slow or
  // unreadable reply is retried, up to ATTEMPTS times in all.
  const ATTEMPT_MS = 12000;
  const ATTEMPTS = 3;

  function attempt(body) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, ATTEMPT_MS) : null;
    return fetch(DCP_API_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight against the Apps Script web app
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined
    })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        let res;
        try { res = JSON.parse(text); } catch (e) { throw new Error('unreadable reply'); }
        if (!res || typeof res !== 'object') throw new Error('unreadable reply');
        return res;
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function call(action, payload) {
    const s = readSession();
    const body = Object.assign({ action: action, session: s ? s.id : '' }, payload || {});
    function go(n) {
      return attempt(body).catch(function (err) {
        if (n >= ATTEMPTS) throw err;
        return new Promise(function (resolve) { setTimeout(resolve, 700 * n); })
          .then(function () { return go(n + 1); });
      });
    }
    return go(1).then(function (res) {
      if (res.error === 'session_expired') clearSession();
      return res;
    });
  }

  function login(email, code) {
    return call('login', { email: email, code: code }).then(function (res) {
      if (res && res.ok) saveSession({ id: res.session, expires: res.expires, name: res.name });
      return res;
    });
  }

  function logout() {
    const done = function () { clearSession(); window.location.href = ROOT; };
    return call('logout').then(done, done);
  }

  /** Formats a date from the service as e.g. "7 October 2026", Singapore time. */
  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Singapore' });
    } catch (e) { return d.toDateString(); }
  }

  return {
    root: ROOT,
    session: readSession,
    isSignedIn: function () { return !!readSession(); },
    call: call,
    login: login,
    logout: logout,
    formatDate: formatDate
  };
})();
