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

  /** section: a section name (e.g. 'D3') loads only its answers; 'none' loads none; omit for all. */
  function loadState(section) {
    const payload = { assignment: assignment };
    if (section) payload.section = section;
    return DCP.call('getState', payload);
  }

  // ── Save queue ──
  // Answers are queued and sent together, one request at a time, so quick
  // changes across several questions become a single save.
  const pending = {};          // 'section|field' -> { section, field, value }
  let inFlight = null;
  let statusListener = function () {};
  let waiters = [];

  function onSaveStatus(fn) { statusListener = fn; }

  function hasPending() { return Object.keys(pending).length > 0; }

  function settleWaiters(ok) {
    const w = waiters; waiters = [];
    w.forEach(function (fn) { fn(ok); });
  }

  function flush() {
    if (inFlight) return;
    if (!hasPending()) { settleWaiters(true); return; }
    const batch = Object.keys(pending).map(function (k) { const f = pending[k]; delete pending[k]; return f; });
    statusListener('saving');
    inFlight = DCP.call('saveFields', { assignment: assignment, fields: batch })
      .then(function (res) {
        if (res && res.ok) { statusListener('saved'); return true; }
        // Keep the answers queued (unless already changed again) for the next attempt.
        batch.forEach(function (f) { const k = f.section + '|' + f.field; if (!pending[k]) pending[k] = f; });
        statusListener('error', res);
        return false;
      }, function () {
        batch.forEach(function (f) { const k = f.section + '|' + f.field; if (!pending[k]) pending[k] = f; });
        statusListener('error', null);
        return false;
      })
      .then(function (ok) {
        inFlight = null;
        if (ok && hasPending()) flush();
        else settleWaiters(ok && !hasPending());
      });
  }

  function queueSave(section, field, value) {
    pending[section + '|' + field] = { section: section, field: field, value: value };
    flush();
  }

  /** Resolves true once everything typed so far is saved, false if a save failed. */
  function saveAll() {
    return new Promise(function (resolve) {
      if (!inFlight && !hasPending()) { resolve(true); return; }
      waiters.push(resolve);
      if (!inFlight) flush();
    });
  }

  window.addEventListener('beforeunload', function (e) {
    if (inFlight || hasPending()) { e.preventDefault(); e.returnValue = ''; }
  });

  function setCurrentPage(page) {
    return DCP.call('setCurrentPage', { assignment: assignment, page: page });
  }

  function submit() { return DCP.call('submit', { assignment: assignment }); }

  return { assignment: assignment, link: link, loadState: loadState, queueSave: queueSave,
    saveAll: saveAll, onSaveStatus: onSaveStatus, setCurrentPage: setCurrentPage, submit: submit };
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
  return DC.loadState(opts.section).then(function (state) {
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

  DC.onSaveStatus(function (state, res) {
    if (state === 'saving') { setStatus('Saving…', 'saving'); return; }
    if (state === 'saved') { setStatus('Saved', 'saved'); return; }
    if (res && (res.error === 'session_expired' || res.error === 'submitted' || res.error === 'no_access')) {
      dcShowProblem(res);
      return;
    }
    setStatus(res ? 'Save failed' : 'Save failed: check connection', 'error');
  });

  function doSave(el) {
    if (!el.name) return;
    DC.queueSave(section, el.name, currentValue(el));
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
    // Until saved answers have loaded, keep the questions and buttons locked
    // so nothing typed in the meantime goes unsaved.
    const lockable = Array.prototype.slice.call(
      document.querySelectorAll('.dc-main input, .dc-main textarea, .dc-main select, .dc-main button'));
    lockable.forEach(function (el) { el.disabled = true; });
    const statusEl = document.getElementById('dcSaveStatus');
    if (statusEl) { statusEl.textContent = 'Loading…'; statusEl.className = 'dc-save-status saving'; }

    dcStart({ section: opts.dimension }).then(function (state) {
      if (!state) return;
      lockable.forEach(function (el) { el.disabled = false; });
      if (statusEl) { statusEl.textContent = ''; statusEl.className = 'dc-save-status'; }
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
          dcLeaveAfterSaving(continueBtn, function () {
            return DC.setCurrentPage(resumeCode).catch(function () {});
          }, opts.nextPage);
        });
      }

      const backBtn = document.getElementById('dcBack');
      if (backBtn && opts.prevPage) {
        backBtn.addEventListener('click', function () {
          dcLeaveAfterSaving(backBtn, null, opts.prevPage);
        });
      }
    });
  });
}

/**
 * Waits for queued answers to finish saving, then (optionally) runs `before`
 * and goes to `page`. If a save fails, stays put and says so, so nothing
 * typed is lost.
 */
function dcLeaveAfterSaving(btn, before, page) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  DC.saveAll().then(function (ok) {
    if (!ok) {
      btn.disabled = false;
      btn.textContent = label;
      const status = document.getElementById('dcSaveStatus');
      if (status) { status.textContent = 'Save failed: please try again'; status.className = 'dc-save-status error'; }
      return;
    }
    Promise.resolve(before ? before() : null).then(function () {
      window.location.href = DC.link(page);
    });
  });
}
