/* ============================================================
   DeepClarity Diagnostic — shared client-side engine
   Handles token resolution, load/save calls to the Apps Script
   web app, real per-field autosave, and prefill on page load.
   ============================================================ */

// ── FILL THIS IN once you have deployed the Apps Script web app ──
const DC_API_URL = 'https://script.google.com/macros/s/AKfycbwYSyLuhJxStfSKslNIcwuQe0eStZZp2t43je7_VV-ZTJAzHffqsxh0Uxn7yEwVr-2nmA/exec';

const DC = (function () {
  const params = new URLSearchParams(window.location.search);
  let token = params.get('token');
  if (token) {
    sessionStorage.setItem('dc_token', token);
  } else {
    token = sessionStorage.getItem('dc_token');
  }

  function withToken(path) {
    const u = new URL(path, window.location.href);
    if (token) u.searchParams.set('token', token);
    return u.toString();
  }

  function postJSON(payload) {
    return fetch(DC_API_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight against the Apps Script web app
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  function loadState() {
    return fetch(DC_API_URL + '?action=getState&token=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); });
  }

  function saveField(dimension, field, value) {
    return postJSON({ action: 'saveField', token: token, dimension: dimension, field: field, value: value });
  }

  function setCurrentPage(page) {
    return postJSON({ action: 'setCurrentPage', token: token, page: page });
  }

  return { token: token, withToken: withToken, loadState: loadState, saveField: saveField, setCurrentPage: setCurrentPage };
})();

/**
 * Wires up autosave for every element with [data-autosave] inside the page.
 * Text/number/textarea fields debounce ~1.5s after typing stops, and also
 * save immediately on blur. Checkboxes and radios save the instant they change.
 */
function dcInitAutosave(dimension) {
  const statusEl = document.getElementById('dcSaveStatus');
  const timers = {};

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'dc-save-status ' + cls;
  }

  function currentValue(el) {
    if (el.type === 'checkbox') {
      const group = document.querySelectorAll('input[name="' + el.name + '"]');
      return Array.from(group).filter(function (x) { return x.checked; }).map(function (x) { return x.value; }).join(', ');
    }
    if (el.type === 'radio') {
      const checked = document.querySelector('input[name="' + el.name + '"]:checked');
      return checked ? checked.value : '';
    }
    return el.value;
  }

  function doSave(el) {
    const field = el.name;
    if (!field) return;
    const value = currentValue(el);
    setStatus('Saving…', 'saving');
    DC.saveField(dimension, field, value)
      .then(function (res) {
        if (res && res.error) { setStatus('Save failed', 'error'); return; }
        setStatus('Saved', 'saved');
      })
      .catch(function () { setStatus('Save failed — check connection', 'error'); });
  }

  document.querySelectorAll('[data-autosave]').forEach(function (el) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.addEventListener('change', function () { doSave(el); });
    } else {
      el.addEventListener('input', function () {
        clearTimeout(timers[el.name]);
        timers[el.name] = setTimeout(function () { doSave(el); }, 1500);
      });
      el.addEventListener('blur', function () {
        clearTimeout(timers[el.name]);
        doSave(el);
      });
    }
  });
}

/** Fills in previously saved values from the getState() response. */
function dcPrefill(responses) {
  if (!responses) return;
  document.querySelectorAll('[data-autosave]').forEach(function (el) {
    const raw = responses[el.name];
    if (raw === undefined || raw === null || raw === '') return;
    if (el.type === 'checkbox') {
      const vals = String(raw).split(',').map(function (s) { return s.trim(); });
      if (vals.indexOf(el.value) !== -1) el.checked = true;
    } else if (el.type === 'radio') {
      if (el.value === String(raw)) el.checked = true;
    } else {
      el.value = raw;
    }
  });
}

/**
 * Wires up the jump-to-section nav strip (.dc-jumpnav a): carries the token
 * along on every link and highlights whichever page you're currently on.
 * Safe to call on any page — it's a no-op if the strip isn't present.
 */
function dcInitJumpNav() {
  const current = window.location.pathname.split('/').pop();
  const currentDim = (current.match(/^(d\d)-/) || [])[1];
  document.querySelectorAll('.dc-jumpnav a').forEach(function (a) {
    const href = a.getAttribute('href');
    const dim = a.getAttribute('data-dim');
    if (dim) {
      // Dimension pill: stays active across every section within that dimension.
      if (dim === currentDim) a.classList.add('is-active');
    } else if (href === current) {
      a.classList.add('is-active');
    }
    a.href = DC.withToken(href);
  });
}

/**
 * Standard page bootstrap. Call from each section page:
 *   dcBootstrapPage({ dimension: 'D1', prevPage: 'd1-a.html', nextPage: 'd1-b.html' });
 *
 * `nextPage` is also what gets written to Clients.current_page when Continue
 * is clicked (stripped of ".html"), since that's where the respondent should
 * resume next time. `prevPage` (optional — omit on the very first page) wires
 * up a Back button so respondents can revisit and edit earlier sections;
 * Back never overwrites current_page, so the resume link still points to the
 * furthest section reached.
 */
function dcBootstrapPage(opts) {
  document.addEventListener('DOMContentLoaded', function () {
    if (!DC.token) {
      window.location.href = 'landing.html';
      return;
    }
    DC.loadState().then(function (state) {
      if (!state || state.error) {
        const main = document.querySelector('.dc-main');
        if (main) main.innerHTML = '<p class="dc-error">' + (state && state.error ? state.error : 'Something went wrong loading your saved answers.') + '</p>';
        return;
      }
      dcPrefill(state.responses);
      dcInitAutosave(opts.dimension);
      dcInitJumpNav();

      if (opts.gate) {
        const gating = state.gating || {};
        let unlocked = false;
        if (opts.gate === 'D2B') {
          unlocked = !!gating.release_D2B || !!gating.meeting_1_date;
        } else if (opts.gate === 'D7') {
          unlocked = !!gating.release_D7;
        } else if (opts.gate === 'D8') {
          unlocked = !!gating.release_D8;
        }
        const gated = document.getElementById('dcGatedContent');
        const locked = document.getElementById('dcLockedPlaceholder');
        if (gated) gated.style.display = unlocked ? '' : 'none';
        if (locked) locked.style.display = unlocked ? 'none' : '';
      }

      const continueBtn = document.getElementById('dcContinue');
      if (continueBtn) {
        continueBtn.addEventListener('click', function () {
          const resumeCode = opts.nextPage.replace('.html', '');
          DC.setCurrentPage(resumeCode).finally(function () {
            window.location.href = DC.withToken(opts.nextPage);
          });
        });
      }

      const backBtn = document.getElementById('dcBack');
      if (backBtn && opts.prevPage) {
        backBtn.addEventListener('click', function () {
          window.location.href = DC.withToken(opts.prevPage);
        });
      }
    });
  });
}
