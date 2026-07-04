// =============================================================
// Password gate for the whole dashboard. Every page loads this as the
// very first <script> in <head>.
//
// Unlike the old lock.js (deleted, but every page still referenced it
// by filename — meaning the site had NO password screen at all until
// this file existed again), the password itself is never shipped to
// the browser: this just asks the server (/api/session-login) to
// check it against DASHBOARD_PASSWORD and, on success, relies on a
// signed httpOnly cookie the server sets — this script can't read or
// forge that cookie, only the server can verify it.
// =============================================================
(function () {
  'use strict';

  // Hide the page the instant parsing reaches this line — before body
  // even exists — so there's no flash of real content pre-auth-check.
  document.write('<style id="lock-hide">body{display:none!important}</style>');

  function reveal() {
    const style = document.getElementById('lock-hide');
    if (style) style.remove();
    if (document.body) document.body.style.display = '';
  }

  function showLoginOverlay(message) {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', function () { showLoginOverlay(message); });
      return;
    }
    reveal();
    const overlay = document.createElement('div');
    overlay.id = 'lock-overlay';
    overlay.innerHTML =
      '<style>' +
      '#lock-overlay{position:fixed;inset:0;z-index:2147483647;background:#050a0f;' +
      'display:flex;align-items:center;justify-content:center;' +
      'font-family:ui-monospace,"Share Tech Mono","JetBrains Mono",monospace;}' +
      '#lock-box{width:100%;max-width:300px;padding:28px;text-align:center;box-sizing:border-box;}' +
      '#lock-box h1{color:#e6f7fb;font-size:14px;letter-spacing:0.14em;margin:0 0 18px;font-weight:700;}' +
      '#lock-box input{width:100%;box-sizing:border-box;padding:12px 14px;' +
      'background:rgba(63,217,255,0.05);border:1px solid rgba(63,217,255,0.3);' +
      'color:#e6f7fb;font-family:inherit;font-size:15px;outline:none;margin-bottom:12px;}' +
      '#lock-box input:focus{border-color:#3fd9ff;}' +
      '#lock-box button{width:100%;padding:12px;background:rgba(63,217,255,0.15);' +
      'border:1px solid #3fd9ff;color:#e6f7fb;font-family:inherit;font-size:13px;' +
      'font-weight:700;letter-spacing:0.06em;cursor:pointer;}' +
      '#lock-box button:hover{background:rgba(63,217,255,0.25);}' +
      '#lock-box button:disabled{opacity:0.5;cursor:default;}' +
      '#lock-err{color:#e0605c;font-size:12px;margin-top:10px;min-height:16px;}' +
      '</style>' +
      '<div id="lock-box">' +
      '<h1>enter password</h1>' +
      '<input id="lock-input" type="password" autocomplete="current-password">' +
      '<button id="lock-submit" type="button">Unlock</button>' +
      '<div id="lock-err"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    const input = document.getElementById('lock-input');
    const btn = document.getElementById('lock-submit');
    const err = document.getElementById('lock-err');
    if (message) err.textContent = message;

    function submit() {
      const pass = input.value;
      btn.disabled = true;
      err.textContent = '';
      fetch('/api/session-login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass }),
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok) {
            window.location.reload();
          } else {
            btn.disabled = false;
            err.textContent = 'Wrong password.';
            input.value = '';
            input.focus();
          }
        })
        .catch(function () {
          btn.disabled = false;
          err.textContent = 'Network error — try again.';
        });
    }
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    input.focus();
  }

  fetch('/api/session-check', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.ok) reveal();
      else showLoginOverlay();
    })
    .catch(function () {
      // Fail closed — if we can't verify, don't show the page.
      showLoginOverlay('Could not verify session — enter password.');
    });
})();
