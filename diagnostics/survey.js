/* ============================================================
   DeepClarity Diagnostics: single-page survey engine
   Shared by one-page surveys (e.g. govtech/nla). Requires
   platform.js to be loaded first.

   A survey page calls:
     dcsInit({ section: 'NLA', prefillName: 'q1_name' });

   Page markup it expects:
     #dcsForm               the form holding every question
     .dcs-question          one per question; add data-required to require it
     [name] inside it       inputs, textareas and selects; the name is the
                            column in the <section>_Responses tab
     .dcs-rank              wraps a ranking question's selects (each number once)
     #dcsSubmit, #dcsSubmitMessage, #dcsSaveStatus, #dcsLoading
   ============================================================ */

function dcsInit(config) {
  const section = config.section;
  const completePage = config.completePage || 'complete.html';

  // ── Which assignment this is ──
  const folderKey = 'dcs_a:' + window.location.pathname.replace(/[^/]*$/, '');
  let assignment = new URLSearchParams(window.location.search).get('a');
  try {
    if (assignment) sessionStorage.setItem(folderKey, assignment);
    else assignment = sessionStorage.getItem(folderKey);
  } catch (e) {}

  if (!DCP.isSignedIn() || !assignment) { window.location.href = DCP.root; return; }

  const form = document.getElementById('dcsForm');
  const fields = Array.prototype.slice.call(form.querySelectorAll('input[name], textarea[name], select[name]'));
  const statusEl = document.getElementById('dcsSaveStatus');
  const submitBtn = document.getElementById('dcsSubmit');
  const submitMsg = document.getElementById('dcsSubmitMessage');

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'dc-save-status ' + (cls || '');
  }

  function goTo(page) {
    const u = new URL(page, window.location.href);
    u.searchParams.set('a', assignment);
    window.location.href = u.toString();
  }

  // ── Saving ──
  // Changes are queued and sent together, one request at a time. Anything not
  // yet confirmed is kept on this device so it survives a reload, and a failed
  // save is retried on its own.
  const PENDING_KEY = 'dcs_pending:' + assignment;
  let pending = {};
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}') || {}; } catch (e) { pending = {}; }
  let sending = null;      // the batch currently on its way
  let retryTimer = null;
  let retryDelay = 5000;
  let waiters = [];

  function keepPending() {
    const all = Object.assign({}, sending || {}, pending);
    try {
      if (Object.keys(all).length) localStorage.setItem(PENDING_KEY, JSON.stringify(all));
      else localStorage.removeItem(PENDING_KEY);
    } catch (e) {}
  }

  function busy() { return !!sending || Object.keys(pending).length > 0; }

  function finishWaiting(ok) {
    const w = waiters; waiters = [];
    w.forEach(function (fn) { fn(ok); });
  }

  function flush() {
    if (sending) return;
    clearTimeout(retryTimer);
    if (!Object.keys(pending).length) { finishWaiting(true); return; }
    sending = pending;
    pending = {};
    keepPending();
    setStatus('Saving…', 'saving');
    const batch = Object.keys(sending).map(function (name) {
      return { section: section, field: name, value: sending[name] };
    });
    DCP.call('saveFields', { assignment: assignment, fields: batch })
      .then(function (res) { return res; }, function () { return null; })
      .then(function (res) {
        const ok = !!(res && res.ok);
        if (!ok) {
          // Put the batch back unless the same answer has changed again since.
          Object.keys(sending).forEach(function (name) {
            if (!(name in pending)) pending[name] = sending[name];
          });
        }
        sending = null;
        keepPending();
        if (ok) {
          retryDelay = 5000;
          setStatus('Saved', 'saved');
          if (Object.keys(pending).length) flush(); else finishWaiting(true);
          return;
        }
        if (res && (res.error === 'session_expired' || res.error === 'no_access' || res.error === 'submitted')) {
          showProblem(res);
          finishWaiting(false);
          return;
        }
        setStatus('Not saved yet: will retry', 'error');
        finishWaiting(false);
        retryTimer = setTimeout(flush, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      });
  }

  function queue(name, value) {
    pending[name] = value;
    keepPending();
    flush();
  }

  function saveAll() {
    return new Promise(function (resolve) {
      if (!busy()) { resolve(true); return; }
      waiters.push(resolve);
      flush();
    });
  }

  window.addEventListener('beforeunload', function (e) {
    if (busy()) { e.preventDefault(); e.returnValue = ''; }
  });

  // ── Problems that stop the page ──
  function showProblem(res) {
    const main = document.querySelector('.dcs-main');
    const code = res && res.error;
    const box = document.createElement('div');
    box.className = 'dc-locked';
    const p = document.createElement('p');
    p.textContent = (res && res.message) || 'We could not reach the diagnostics service. Please check your connection and try again.';
    const a = document.createElement('a');
    a.className = 'btn btn-primary';
    a.style.marginTop = '1.5rem';
    a.href = DCP.root;
    a.textContent = code === 'session_expired' ? 'Sign in again' : 'Go to your dashboard';
    box.appendChild(p);
    box.appendChild(a);
    main.innerHTML = '';
    main.appendChild(box);
  }

  // ── Header links: wait for answers to save before leaving ──
  const dashLink = document.getElementById('dcsDashboard');
  if (dashLink) dashLink.addEventListener('click', function (e) {
    e.preventDefault();
    dashLink.textContent = 'Saving…';
    saveAll().then(function () { window.location.href = DCP.root; });
  });
  const signOut = document.getElementById('dcsSignOut');
  if (signOut) signOut.addEventListener('click', function () {
    signOut.textContent = 'Saving…';
    saveAll().then(function () { DCP.logout(); });
  });

  // ── Ranking: each number can be chosen once per group ──
  const rankGroups = Array.prototype.slice.call(form.querySelectorAll('.dcs-rank'));
  function refreshRanks() {
    rankGroups.forEach(function (group) {
      const selects = Array.prototype.slice.call(group.querySelectorAll('select'));
      const taken = selects.map(function (s) { return s.value; }).filter(Boolean);
      selects.forEach(function (s) {
        Array.prototype.forEach.call(s.options, function (opt) {
          opt.disabled = !!opt.value && opt.value !== s.value && taken.indexOf(opt.value) !== -1;
        });
      });
    });
  }

  // ── Required questions ──
  function isAnswered(question) {
    const inputs = question.querySelectorAll('input[name], textarea[name], select[name]');
    return Array.prototype.every.call(inputs, function (el) { return el.value.trim() !== ''; });
  }

  function markAnswered(question) {
    if (question.classList.contains('is-missing') && isAnswered(question)) question.classList.remove('is-missing');
  }

  // ── Autosave wiring ──
  const timers = {};
  fields.forEach(function (el) {
    const question = el.closest('.dcs-question');
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', function () {
        refreshRanks();
        queue(el.name, el.value);
        if (question) markAnswered(question);
      });
      return;
    }
    el.addEventListener('input', function () {
      clearTimeout(timers[el.name]);
      timers[el.name] = setTimeout(function () { delete timers[el.name]; queue(el.name, el.value); }, 1500);
      if (question) markAnswered(question);
    });
    el.addEventListener('blur', function () {
      if (timers[el.name]) { clearTimeout(timers[el.name]); delete timers[el.name]; queue(el.name, el.value); }
    });
  });

  function saveTypingNow() {
    Object.keys(timers).forEach(function (name) {
      clearTimeout(timers[name]);
      delete timers[name];
      const el = form.querySelector('[name="' + name + '"]');
      if (el) queue(name, el.value);
    });
  }

  // ── Submitting ──
  function showSubmitMessage(text) {
    submitMsg.textContent = text;
    submitMsg.style.display = text ? '' : 'none';
  }

  submitBtn.addEventListener('click', function () {
    saveTypingNow();
    const missing = Array.prototype.filter.call(form.querySelectorAll('.dcs-question[data-required]'), function (q) {
      return !isAnswered(q);
    });
    missing.forEach(function (q) { q.classList.add('is-missing'); });
    if (missing.length) {
      showSubmitMessage(missing.length === 1
        ? 'One question still needs an answer. It is highlighted above.'
        : missing.length + ' questions still need an answer. They are highlighted above.');
      missing[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      const firstEmpty = Array.prototype.find.call(missing[0].querySelectorAll('input, textarea, select'),
        function (el) { return el.value.trim() === ''; });
      if (firstEmpty) setTimeout(function () { firstEmpty.focus({ preventScroll: true }); }, 400);
      return;
    }

    showSubmitMessage('');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    saveAll().then(function (saved) {
      if (!saved) {
        throw { message: 'Some answers have not saved yet. Please check your connection and try again.' };
      }
      return DCP.call('submit', { assignment: assignment });
    }).then(function (res) {
      if (res && res.ok) { goTo(completePage); return; }
      if (res && (res.error === 'session_expired' || res.error === 'no_access')) { showProblem(res); return; }
      throw res;
    }).catch(function (err) {
      showSubmitMessage((err && err.message) || 'Your survey could not be submitted. Your answers are saved; please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
    });
  });

  // ── Load saved answers ──
  fields.forEach(function (el) { el.disabled = true; });
  submitBtn.disabled = true;

  DCP.call('getState', { assignment: assignment, section: section, page: 'survey' }).then(function (state) {
    if (!state || state.error) { showProblem(state); return; }
    if (state.submitted) { goTo(completePage); return; }

    const saved = state.responses || {};
    fields.forEach(function (el) {
      // Answers still waiting to be sent from an earlier visit take priority.
      const value = el.name in pending ? pending[el.name] : saved[el.name];
      if (value !== undefined && value !== null && value !== '') el.value = String(value);
      el.disabled = false;
    });

    const nameField = config.prefillName ? form.querySelector('[name="' + config.prefillName + '"]') : null;
    if (nameField && !nameField.value && state.respondent && state.respondent.name) {
      nameField.value = state.respondent.name;
      queue(nameField.name, nameField.value);
    }

    refreshRanks();
    submitBtn.disabled = false;
    const loading = document.getElementById('dcsLoading');
    if (loading) loading.style.display = 'none';
    if (!busy()) setStatus('', '');
    flush(); // send anything left over from an earlier visit
  }).catch(function () { showProblem(null); });
}

/** For the confirmation page: shows the submission date, or sends people back if not submitted. */
function dcsInitComplete(config) {
  const surveyPage = (config && config.surveyPage) || 'index.html';
  const folderKey = 'dcs_a:' + window.location.pathname.replace(/[^/]*$/, '');
  let assignment = new URLSearchParams(window.location.search).get('a');
  try { if (!assignment) assignment = sessionStorage.getItem(folderKey); } catch (e) {}
  if (!DCP.isSignedIn() || !assignment) { window.location.href = DCP.root; return; }

  DCP.call('getState', { assignment: assignment, section: 'none' }).then(function (state) {
    if (!state || state.error) { window.location.href = DCP.root; return; }
    if (!state.submitted) {
      const u = new URL(surveyPage, window.location.href);
      u.searchParams.set('a', assignment);
      window.location.replace(u.toString());
      return;
    }
    const when = DCP.formatDate(state.date_submitted);
    document.getElementById('dcsSubmittedOn').textContent =
      (when ? 'Submitted on ' + when + '. ' : '') + 'Your answers are now final and can no longer be changed.';
    document.getElementById('dcsLoading').style.display = 'none';
    document.getElementById('dcsContent').style.display = '';
  }).catch(function () { window.location.href = DCP.root; });
}
