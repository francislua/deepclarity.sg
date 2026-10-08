/* ============================================================
   DeepClarity Diagnostic (OTAS): shared client-side engine
   Requires ../platform.js to be loaded first.

   How it stays fast: the first page of a visit loads all of the
   respondent's answers once and keeps a copy in the browser tab.
   Every later page shows that copy straight away and checks with
   the sheet in the background. Answers are saved in the background
   too; anything not yet confirmed is kept on this device and sent
   from the next page, so moving on never waits for Google.
   ============================================================ */

const DC = (function () {
  const params = new URLSearchParams(window.location.search);
  let assignment = params.get('a');
  try {
    if (assignment) sessionStorage.setItem('dc_otas_assignment', assignment);
    else assignment = sessionStorage.getItem('dc_otas_assignment');
  } catch (e) {}

  const STATE_KEY = 'dc_state:' + assignment;      // copy of answers, this tab only
  const PENDING_KEY = 'dc_pending:' + assignment;  // unsent answers, this device

  function store(kind) {
    try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch (e) { return null; }
  }
  function readJSON(kind, key) {
    const s = store(kind);
    if (!s) return null;
    try { return JSON.parse(s.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function writeJSON(kind, key, value) {
    const s = store(kind);
    if (!s) return;
    try {
      if (value === null) s.removeItem(key); else s.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  /** Adds this diagnostic's assignment ID to a link within the project. */
  function link(path) {
    const u = new URL(path, window.location.href);
    if (assignment) u.searchParams.set('a', assignment);
    return u.toString();
  }

  // ── Save queue ──
  const pending = readJSON('local', PENDING_KEY) || {};  // 'section|field' -> { section, field, value }
  let inFlight = null;
  let inFlightBatch = [];
  let statusListener = function () {};
  let waiters = [];

  // ── The browser's copy of the answers ──
  function cachedState() {
    const s = readJSON('session', STATE_KEY);
    return s && s.ok && s.full ? s : null;
  }

  function saveCopy(state) { writeJSON('session', STATE_KEY, state); }

  function applyLocal(state, f) {
    if (f.section === 'Respondents') {
      state.respondent = state.respondent || {};
      state.respondent.fields = state.respondent.fields || {};
      state.respondent.fields[f.field] = f.value;
    } else {
      state.responses = state.responses || {};
      state.responses[f.field] = f.value;
    }
  }

  /** Folds a reply from the service into the browser's copy and returns the result. */
  function mergeIntoCopy(fresh, full) {
    const old = cachedState() || {};
    const copy = full
      ? Object.assign({}, fresh, { full: true })
      : Object.assign({}, old, fresh, {
          full: !!old.full,
          responses: Object.assign({}, old.responses || {}, fresh.responses || {}),
          progress: old.progress || fresh.progress
        });
    // Answers typed but not yet confirmed win over what the sheet says.
    inFlightBatch.forEach(function (f) { applyLocal(copy, f); });
    Object.keys(pending).forEach(function (k) { applyLocal(copy, pending[k]); });
    if (copy.full) saveCopy(copy);
    return copy;
  }

  /** section: 'D3' loads just that section; 'none' loads none; '' for all. page: resume point to record. */
  function loadState(section, page) {
    const payload = { assignment: assignment };
    if (section) payload.section = section;
    if (page) payload.page = page;
    return DCP.call('getState', payload);
  }

  function persistPending() {
    const all = {};
    inFlightBatch.forEach(function (f) { all[f.section + '|' + f.field] = f; });
    Object.keys(pending).forEach(function (k) { all[k] = pending[k]; });
    writeJSON('local', PENDING_KEY, Object.keys(all).length ? all : null);
  }

  function onSaveStatus(fn) { statusListener = fn; }
  function hasPending() { return Object.keys(pending).length > 0; }
  function isBusy() { return !!inFlight || hasPending(); }

  function settleWaiters(ok) {
    const w = waiters; waiters = [];
    w.forEach(function (fn) { fn(ok); });
  }

  function requeue() {
    inFlightBatch.forEach(function (f) { const k = f.section + '|' + f.field; if (!pending[k]) pending[k] = f; });
  }

  // A save that fails for a temporary reason is retried on its own, waiting a
  // little longer each time (5s, 10s, 20s, then every 30s).
  let retryTimer = null;
  let retryDelay = 5000;
  const FINAL_ERRORS = ['session_expired', 'no_access', 'submitted', 'invalid'];

  function scheduleRetry(res) {
    if (res && FINAL_ERRORS.indexOf(res.error) !== -1) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { retryTimer = null; flush(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }

  function flush() {
    if (inFlight) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    if (!hasPending()) { settleWaiters(true); return; }
    inFlightBatch = Object.keys(pending).map(function (k) { const f = pending[k]; delete pending[k]; return f; });
    persistPending();
    statusListener('saving');
    inFlight = DCP.call('saveFields', { assignment: assignment, fields: inFlightBatch })
      .then(function (res) {
        if (res && res.ok) { retryDelay = 5000; statusListener('saved'); return { ok: true }; }
        requeue();
        statusListener('error', res);
        return { ok: false, res: res };
      }, function () {
        requeue();
        statusListener('error', null);
        return { ok: false, res: null };
      })
      .then(function (r) {
        inFlight = null;
        inFlightBatch = [];
        persistPending();
        if (r.ok && hasPending()) flush();
        else {
          settleWaiters(r.ok && !hasPending());
          if (!r.ok) scheduleRetry(r.res);
        }
      });
  }

  function queueSave(section, field, value) {
    const f = { section: section, field: field, value: value };
    pending[section + '|' + field] = f;
    persistPending();
    const copy = cachedState();
    if (copy) { applyLocal(copy, f); saveCopy(copy); }
    flush();
  }

  /** Resolves true once everything typed so far is saved, false if a save failed. */
  function saveAll() {
    return new Promise(function (resolve) {
      if (!isBusy()) { resolve(true); return; }
      waiters.push(resolve);
      if (!inFlight) flush();
    });
  }

  /** Notes the page being shown in the browser's copy (the sheet is told in the background). */
  function notePage(page) {
    const copy = cachedState();
    if (copy && !copy.submitted) { copy.current_page = page; saveCopy(copy); }
  }

  // Warn before closing the tab while answers are still being sent. Moving
  // between pages of the diagnostic is fine: unsent answers travel along.
  let leavingWithinDiagnostic = false;
  window.addEventListener('beforeunload', function (e) {
    if (!leavingWithinDiagnostic && isBusy()) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('click', function (e) {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && a.href.indexOf(window.location.href.split('/').slice(0, -1).join('/') + '/') === 0) {
      leavingWithinDiagnostic = true; // a link to another page of this diagnostic
      persistPending();
    }
  }, true);

  function go(page) {
    leavingWithinDiagnostic = true;
    persistPending();
    window.location.href = link(page);
  }

  function submit() {
    return DCP.call('submit', { assignment: assignment }).then(function (res) {
      if (res && res.ok) {
        const copy = cachedState();
        if (copy) {
          copy.submitted = true; copy.status = 'Completed'; copy.date_submitted = res.date_submitted;
          saveCopy(copy);
        }
      }
      return res;
    });
  }

  // Answers left over from an earlier page (or visit) go out straight away.
  if (assignment && hasPending()) setTimeout(flush, 0);

  return {
    assignment: assignment, link: link, go: go, loadState: loadState,
    cachedState: cachedState, mergeIntoCopy: mergeIntoCopy, notePage: notePage,
    queueSave: queueSave, saveAll: saveAll, isBusy: isBusy, onSaveStatus: onSaveStatus,
    submit: submit
  };
})();

/** The current page's short name, e.g. "d3-b". */
function dcPageCode() {
  return (window.location.pathname.split('/').pop() || '').replace(/\.html$/, '') || 'landing';
}

/** Adds "Dashboard" and "Sign out" to the page header. Both wait for saves first. */
function dcInitAccountLinks() {
  const inner = document.querySelector('.dc-header-inner');
  if (!inner || inner.querySelector('.dcp-account')) return;
  const wrap = document.createElement('div');
  wrap.className = 'dcp-account';
  const dash = document.createElement('a');
  dash.href = DCP.root;
  dash.textContent = 'Dashboard';
  dash.addEventListener('click', function (e) {
    e.preventDefault();
    if (dcInitAutosave.flushTimers) dcInitAutosave.flushTimers();
    dash.textContent = 'Saving…';
    DC.saveAll().then(function () { window.location.href = DCP.root; });
  });
  const out = document.createElement('button');
  out.type = 'button';
  out.textContent = 'Sign out';
  out.addEventListener('click', function () {
    if (dcInitAutosave.flushTimers) dcInitAutosave.flushTimers();
    out.textContent = 'Saving…';
    DC.saveAll().then(function () { DCP.logout(); });
  });
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
  const text = (res && res.message) || 'We could not reach the diagnostics service. Please check your connection and try again.';
  main.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'dc-locked';
  box.style.marginTop = '2rem';
  const p = document.createElement('p');
  p.textContent = text;
  const a = document.createElement('a');
  a.className = 'btn btn-primary';
  a.style.marginTop = '1.5rem';
  a.href = DCP.root;
  a.textContent = code === 'session_expired' ? 'Sign in again' : 'Go to your dashboard';
  box.appendChild(p);
  box.appendChild(a);
  main.appendChild(box);
}

/**
 * Gets this page going.
 *   opts.section         answers this page needs from the background check ('D3', or omit)
 *   opts.full            true to refresh every section in the background (review page)
 *   opts.recordPage      false to leave the resume point alone (welcome and confirmation pages)
 *   opts.allowSubmitted  true on the confirmation page
 *   opts.onRefresh(state)  called when the background check comes back
 *
 * Resolves with the state to show: the browser's copy if this tab has one
 * (instant), otherwise a full load from the service. Resolves null if the
 * page has already been dealt with (signed out, no access, submitted).
 */
function dcStart(opts) {
  opts = opts || {};
  dcInitAccountLinks();
  if (!DCP.isSignedIn() || !DC.assignment) { window.location.href = DCP.root; return Promise.resolve(null); }

  const page = opts.recordPage === false ? '' : dcPageCode();
  if (page) DC.notePage(page);

  function handled(state) {
    if (!state || state.error) { dcShowProblem(state); return true; }
    if (state.submitted && !opts.allowSubmitted) {
      window.location.replace(DC.link('complete.html'));
      return true;
    }
    return false;
  }

  function showLabel(state) {
    const label = document.getElementById('dcPracticeLabel');
    if (label && state.respondent) label.textContent = state.respondent.organisation || '';
  }

  const copy = DC.cachedState();
  if (copy) {
    if (handled(copy)) return Promise.resolve(null);
    showLabel(copy);
    // Show the copy now; check with the sheet in the background.
    const section = opts.full ? '' : (opts.section || 'none');
    DC.loadState(section, page).then(function (fresh) {
      if (!fresh || fresh.error) {
        if (fresh && (fresh.error === 'session_expired' || fresh.error === 'no_access')) dcShowProblem(fresh);
        return; // otherwise keep working from the copy
      }
      const merged = DC.mergeIntoCopy(fresh, !!opts.full);
      if (handled(merged)) return;
      if (opts.onRefresh) opts.onRefresh(merged);
    }).catch(function () { /* keep working from the copy */ });
    return Promise.resolve(copy);
  }

  // No copy yet in this tab: load everything once.
  return DC.loadState('', page).then(function (state) {
    if (handled(state)) return null;
    const merged = DC.mergeIntoCopy(state, true);
    showLabel(merged);
    return merged;
  }).catch(function () { dcShowProblem(null); return null; });
}

/**
 * Wires up autosave for every element with [data-autosave] inside the page.
 * Text fields save ~1.5s after typing stops and immediately on leaving the
 * field. Checkboxes and radios save the instant they change.
 */
function dcInitAutosave(section) {
  const statusEl = document.getElementById('dcSaveStatus');
  const timers = {};

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'dc-save-status ' + cls;
  }

  DC.onSaveStatus(function (state, res) {
    if (state === 'saving') { setStatus('Saving…', 'saving'); return; }
    if (state === 'saved') { setStatus('Saved', 'saved'); return; }
    if (res && (res.error === 'session_expired' || res.error === 'submitted' || res.error === 'no_access')) {
      dcShowProblem(res);
      return;
    }
    setStatus('Not saved yet: will retry', 'error');
  });

  function doSave(el) {
    if (!el.name) return;
    el.setAttribute('data-touched', '1');
    DC.queueSave(section, el.name, dcCurrentValue(el));
  }

  document.querySelectorAll('[data-autosave]').forEach(function (el) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.addEventListener('change', function () { doSave(el); });
    } else {
      el.addEventListener('input', function () {
        el.setAttribute('data-touched', '1');
        clearTimeout(timers[el.name]);
        timers[el.name] = setTimeout(function () { delete timers[el.name]; doSave(el); }, 1500);
      });
      el.addEventListener('blur', function () {
        if (timers[el.name]) { clearTimeout(timers[el.name]); delete timers[el.name]; doSave(el); }
      });
    }
  });

  // Saves anything still waiting on its typing pause; called before leaving a page.
  dcInitAutosave.flushTimers = function () {
    Object.keys(timers).forEach(function (name) {
      clearTimeout(timers[name]);
      delete timers[name];
      const el = document.querySelector('[data-autosave][name="' + name + '"]');
      if (el) doSave(el);
    });
  };
}

function dcCurrentValue(el) {
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

/**
 * Fills in saved values. With onlyUntouched (background refreshes), fields
 * the respondent has already changed on this page are left alone.
 */
function dcPrefill(responses, onlyUntouched) {
  if (!responses) return;
  document.querySelectorAll('[data-autosave]').forEach(function (el) {
    if (onlyUntouched && document.querySelector('[data-autosave][name="' + el.name + '"][data-touched]')) return;
    const raw = responses[el.name];
    const has = !(raw === undefined || raw === null || raw === '');
    if (el.type === 'checkbox') {
      const vals = has ? String(raw).split(',').map(function (s) { return s.trim(); }) : [];
      el.checked = vals.indexOf(el.value) !== -1;
    } else if (el.type === 'radio') {
      el.checked = has && el.value === String(raw);
    } else if (has) {
      el.value = raw;
    } else if (onlyUntouched) {
      el.value = '';
    }
  });
}

/**
 * Wires up the jump-to-section strip (.dc-jumpnav a): carries the
 * assignment along on every link and highlights the current page.
 */
function dcInitJumpNav() {
  const current = window.location.pathname.split('/').pop();
  const currentDim = (current.match(/^(d\d)-/) || [])[1];
  document.querySelectorAll('.dc-jumpnav a').forEach(function (a) {
    const href = a.getAttribute('href');
    const dim = a.getAttribute('data-dim');
    if (dim) {
      if (dim === currentDim) a.classList.add('is-active');
    } else if (href === current) {
      a.classList.add('is-active');
    }
    a.href = DC.link(href);
    a.addEventListener('click', function () {
      if (dcInitAutosave.flushTimers) dcInitAutosave.flushTimers();
    });
  });
}

/** Shows or hides a gated section according to the latest release settings. */
function dcApplyGate(gate, state) {
  if (!gate) return;
  const unlocked = !!(state.gating && state.gating[gate]);
  const gated = document.getElementById('dcGatedContent');
  const locked = document.getElementById('dcLockedPlaceholder');
  if (gated) gated.style.display = unlocked ? '' : 'none';
  if (locked) locked.style.display = unlocked ? 'none' : '';
}

/**
 * Standard page bootstrap. Call from each section page:
 *   dcBootstrapPage({ dimension: 'D1', prevPage: 'd1-a.html', nextPage: 'd1-b.html' });
 * `gate` (D2B, D7 or D8) hides the section until Francis releases it.
 */
function dcBootstrapPage(opts) {
  document.addEventListener('DOMContentLoaded', function () {
    // Until answers are available, keep the questions and buttons locked so
    // nothing typed in the meantime goes unsaved. With the browser's copy
    // this is instant; only the first page of a visit has to wait.
    const lockable = Array.prototype.slice.call(
      document.querySelectorAll('.dc-main input, .dc-main textarea, .dc-main select, .dc-main button'));
    lockable.forEach(function (el) { el.disabled = true; });
    const statusEl = document.getElementById('dcSaveStatus');
    if (statusEl) { statusEl.textContent = 'Loading…'; statusEl.className = 'dc-save-status saving'; }

    dcStart({
      section: opts.dimension,
      onRefresh: function (state) {
        dcPrefill(state.responses, true);
        dcApplyGate(opts.gate, state);
      }
    }).then(function (state) {
      if (!state) return;
      lockable.forEach(function (el) { el.disabled = false; });
      if (statusEl && !DC.isBusy()) { statusEl.textContent = ''; statusEl.className = 'dc-save-status'; }
      dcPrefill(state.responses);
      dcInitAutosave(opts.dimension);
      dcInitJumpNav();
      dcApplyGate(opts.gate, state);

      const continueBtn = document.getElementById('dcContinue');
      if (continueBtn) continueBtn.addEventListener('click', function () { dcLeave(opts.nextPage); });
      const backBtn = document.getElementById('dcBack');
      if (backBtn && opts.prevPage) backBtn.addEventListener('click', function () { dcLeave(opts.prevPage); });
    });
  });
}

/** Moves to another page straight away; unsent answers travel with the respondent. */
function dcLeave(page) {
  if (dcInitAutosave.flushTimers) dcInitAutosave.flushTimers();
  DC.go(page);
}
