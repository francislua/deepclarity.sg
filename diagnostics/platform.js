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
  }

  function call(action, payload) {
    const s = readSession();
    const body = Object.assign({ action: action, session: s ? s.id : '' }, payload || {});
    return fetch(DCP_API_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight against the Apps Script web app
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.error === 'session_expired') clearSession();
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
