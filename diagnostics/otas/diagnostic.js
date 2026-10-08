/* ============================================================
   DeepClarity Diagnostic (OTAS): shared client-side engine
   Handles the signed-in session, load/save calls to the
   diagnostics service, per-field autosave, prefill on page
   load, section gating and the locked state after submission.
   Requires ../platform.js to be loaded first.
   ============================================================ */

const DC = (function () {
  const KEY = 'dc_otas_assignment';
  const params = new URLSearchParams(window.location.search);
  let assignment = params.get('a');
  try {
    if (assignment) sessionStorage.setItem(KEY, assignment);
    else assignment = sessionStorage.getItem(KEY);
  } catch (e) {}

  /** Adds this diagnostic's assignment ID to a link within the project. */
  function link(path) {
    const u = new URL(path, window.location.href);
    if (assignment) u.searchParams.set('a', assignment);
    return u.toString();
  }

  function loadState() { return DCP.call('getState', { assignment: assignment }); }

  function saveField(section, field, value) {
    return DCP.call('saveField', { assignment: assignment, section: section, field: field, value: value });
  }

  function setCurrentPage(page) {
    return DCP.call('setCurrentPage', { assignment: assignment, page: page });
  }

  function submit() { return DCP.call('submit', { assignment: assignment }); }

  return { assignment: assignment, link: link, loadState: loadState, saveField: saveField,
    setCurrentPage: setCurrentPage, submit: submit };
})();

/** Adds "Dashboard" and "Sign out" to the page header. */
function dcInitAccountLinks() {
  const inner = document.querySelector('.dc-header-inner');
  if (!inner || inner.querySelector('.dcp-account')) return;
  const wrap = document.createElement('div');
  wrap.className = 'dcp-account';
  const dash = document.createElement('a');
  dash.href = DCP.root;
  dash.textContent = 'Dashboard';
  const out = document.createElement('button');
  out.type = 'button';
  out.textContent = 'Sign out';
  out.addEventListener('click', function () { DCP.logout(); });
  wrap.appendChild(dash);
  wrap.appendChild(out);
  // Sit alongside the progress and save indicators when the page has them.
  const right = inner.lastElementChild;
  if (right && right.tagName === 'DIV') right.appendChild(wrap);
  else inner.appendChild(wrap);
}

/** Replaces the page body with a message and a way forward. */
function dcShowProblem(res) {
  const main = document.querySelector('.dc-main');
  if (!main) return;
  const code = res && res.error;
  let text = (res && res.message) || 'We could not reach the diagnostics service. Please check your connection and try again.';
  let action = { href: DCP.root, label: 'Go to your dashboard' };
  if (code === 'session_expired') action = { href: DCP.root, label: 'Sign in again' };
  main.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'dc-locked';
  box.style.marginTop = '2rem';
  const p = document.createElement('p');
  p.textContent = text;
  const a = document.createElement('a');
  a.className = 'btn btn-primary';
  a.style.marginTop = '1.5rem';
  a.href = action.href;
  a.textContent = action.label;
  box.appendChild(p);
  box.appendChild(a);
  main.appendChild(box);
}

/**
 * Checks the visitor is signed in and has a diagnostic open, then loads its
 * state. Sends submitted diagnostics to the confirmation page, since answers
 * are locked once submitted. Resolves with the state, or null if the page
 * has already been handled.
 */
function dcStart(opts) {
  opts = opts || {};
  dcInitAccountLinks();
  if (!DCP.isSignedIn()) { window.location.href = DCP.root; return Promise.resolve(null); }
  if (!DC.assignment) { window.location.href = DCP.root; return Promise.resolve(null); }
  return DC.loadState().then(function (state) {
    if (!state || state.error) { dcShowProblem(state); return null; }
    if (state.submitted && !opts.allowSubmitted) {
      window.location.replace(DC.link('complete.html'));
      return null;
    }
    const label = document.getElementById('dcPracticeLabel');
    if (label) label.textContent = state.respondent.organisation || '';
    return state;
  }).catch(function () { dcShowProblem(null); return null; });
}

/**
 * Wires up autosave for every element with [data-autosave] inside the page.
 * Text/number/textarea fields debounce ~1.5s after typing stops, and also
 * save immediately on blur. Checkboxes and radios save the instant they change.
 */
function dcInitAutosave(section) {
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
    DC.saveField(section, field, value)
      .then(function (res) {
        if (res && res.error) {
          if (res.error === 'session_expired' || res.error === 'submitted' || res.error === 'no_access') {
            dcShowProblem(res);
            return;
          }
          setStatus('Save failed', 'error');
          return;
        }
        setStatus('Saved', 'saved');
      })
      .catch(function () { setStatus('Save failed: check connection', 'error'); });
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
 * Wires up the jump-to-section nav strip (.dc-jumpnav a): carries the
 * assignment along on every link and highlights the current page.
 * Safe to call on any page; it does nothing if the strip isn't present.
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
    a.href = DC.link(href);
  });
}

/**
 * Standard page bootstrap. Call from each section page:
 *   dcBootstrapPage({ dimension: 'D1', prevPage: 'd1-a.html', nextPage: 'd1-b.html' });
 *
 * `nextPage` is also what gets recorded as the resume point when Continue
 * is clicked (stripped of ".html"). `prevPage` (optional) wires up a Back
 * button; Back never moves the resume point. `gate` (D2B, D7 or D8) hides
 * the section until Francis releases it for this respondent.
 */
function dcBootstrapPage(opts) {
  document.addEventListener('DOMContentLoaded', function () {
    dcStart().then(function (state) {
      if (!state) return;
      dcPrefill(state.responses);
      dcInitAutosave(opts.dimension);
      dcInitJumpNav();

      if (opts.gate) {
        const unlocked = !!(state.gating && state.gating[opts.gate]);
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
            window.location.href = DC.link(opts.nextPage);
          });
        });
      }

      const backBtn = document.getElementById('dcBack');
      if (backBtn && opts.prevPage) {
        backBtn.addEventListener('click', function () {
          window.location.href = DC.link(opts.prevPage);
        });
      }
    });
  });
}
