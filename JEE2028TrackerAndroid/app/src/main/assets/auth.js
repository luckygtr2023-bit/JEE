/* Optional self-hosted account + cross-device sync layer. The tracker remains fully usable offline. */
(function () {
  'use strict';
  const API_KEY = 'jee.api.base';
  const TOKEN_KEY = 'jee.api.token';
  const USER_KEY = 'jee.api.user';
  let busy = false;
  let message = '';
  let refreshTimer;

  const esc = value => String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const apiBase = () => (localStorage.getItem(API_KEY) || '').trim().replace(/\/+$/, '');
  const user = () => { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (_) { return null; } };
  const token = () => {
    try { if (window.AndroidJeeAuth && window.AndroidJeeAuth.getSession) { const saved = window.AndroidJeeAuth.getSession(); if (saved) return saved; } } catch (_) {}
    return localStorage.getItem(TOKEN_KEY) || '';
  };
  function storeToken(value) {
    try { if (window.AndroidJeeAuth && window.AndroidJeeAuth.saveSession && window.AndroidJeeAuth.saveSession(value)) { localStorage.removeItem(TOKEN_KEY); return; } } catch (_) {}
    localStorage.setItem(TOKEN_KEY, value);
  }
  const configured = () => /^https:\/\//i.test(apiBase()) || /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(apiBase());
  async function request(path, opts = {}) {
    if (!configured()) throw new Error('Set a valid HTTPS API URL first. HTTP is allowed only for local development.');
    const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
    if (token()) headers.authorization = 'Bearer ' + token();
    let response;
    try { response = await fetch(apiBase() + path, Object.assign({}, opts, { headers, cache: 'no-store' })); }
    catch (_) { throw new Error('Could not reach the API. Check the URL and internet connection.'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || ('Request failed (' + response.status + ')'));
    return body;
  }
  function setSession(result) {
    storeToken(result.token);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
    message = 'Signed in as ' + result.user.email;
    updateBadge(); closeDialog(); sync();
  }
  function updateBadge() {
    const button = document.getElementById('jee-account-button'); if (!button) return;
    const u = user(); button.textContent = u ? '☻ ' + (u.name || 'Account') : 'Sign in';
    button.setAttribute('aria-label', u ? 'Account: ' + u.email : 'Sign in or create account');
  }
  function closeDialog() { const e = document.getElementById('jee-auth-dialog'); if (e) e.remove(); }
  function renderDialog() {
    closeDialog();
    const u = user(); const api = esc(apiBase());
    const root = document.createElement('div'); root.id = 'jee-auth-dialog'; root.className = 'jee-auth-backdrop';
    root.innerHTML = '<section class="jee-auth-card" role="dialog" aria-modal="true" aria-labelledby="jee-auth-title">' +
      '<button class="jee-auth-close" type="button" aria-label="Close">×</button><h2 id="jee-auth-title">' + (u ? 'Your account' : 'Account & sync') + '</h2>' +
      '<p class="jee-auth-lead">Your tracker works offline. Connect your own API to sync progress across devices.</p>' +
      '<label class="jee-auth-label" for="jee-api-url">Self-hosted API URL</label><input id="jee-api-url" type="url" autocomplete="url" placeholder="https://api.example.com" value="' + api + '">' +
      '<div class="jee-auth-actions"><button id="jee-save-api" type="button" class="jee-primary">Save API URL</button><button id="jee-test-api" type="button" class="jee-secondary">Test connection</button></div>' +
      (u ? '<div class="jee-auth-user"><b>' + esc(u.name) + '</b><span>' + esc(u.email) + '</span></div><div class="jee-auth-actions"><button id="jee-sync-now" class="jee-primary" type="button">Sync now</button><button id="jee-signout" class="jee-secondary" type="button">Sign out</button></div>' :
      '<div class="jee-auth-tabs"><button type="button" class="active" data-mode="login">Sign in</button><button type="button" data-mode="register">Create account</button></div>' +
      '<form id="jee-auth-form"><div id="jee-name-wrap" hidden><label class="jee-auth-label" for="jee-name">Name</label><input id="jee-name" autocomplete="name" maxlength="80"></div>' +
      '<label class="jee-auth-label" for="jee-email">Email</label><input id="jee-email" type="email" autocomplete="email" required maxlength="254">' +
      '<label class="jee-auth-label" for="jee-password">Password</label><input id="jee-password" type="password" autocomplete="current-password" required minlength="10" maxlength="128">' +
      '<button id="jee-submit" type="submit" class="jee-primary jee-full">Sign in</button></form>' +
      '<div class="jee-auth-divider"><span>or</span></div><button id="jee-google" type="button" class="jee-secondary jee-full">Continue with Google</button>') +
      '<p id="jee-auth-message" class="jee-auth-message" role="status">' + esc(message || 'Connect to your own API to enable accounts and cross-device sync.') + '</p>' +
      '<p class="jee-auth-foot">Use only a server you trust. Account passwords are sent over HTTPS and never stored on this device.</p></section>';
    document.body.appendChild(root);
    root.addEventListener('click', e => { if (e.target === root || e.target.closest('.jee-auth-close')) closeDialog(); });
    const say = text => { const el = root.querySelector('#jee-auth-message'); if (el) el.textContent = text; };
    root.querySelector('#jee-save-api').onclick = () => {
      const value = root.querySelector('#jee-api-url').value.trim().replace(/\/+$/, '');
      if (value && !(/^https:\/\//i.test(value) || /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(value))) return say('Use an HTTPS address, or localhost / 10.0.2.2 for local development.');
      if (value) localStorage.setItem(API_KEY, value); else localStorage.removeItem(API_KEY);
      say(value ? 'API URL saved.' : 'API URL cleared.');
    };
    root.querySelector('#jee-test-api').onclick = async () => {
      try { if (!configured()) throw new Error('Set a valid API URL first.'); const res = await fetch(apiBase() + '/health', { cache: 'no-store' }); if (!res.ok) throw new Error('Health check failed (' + res.status + ')'); say('Connected to ' + apiBase()); }
      catch (e) { say(e.message); }
    };
    if (u) {
      root.querySelector('#jee-sync-now').onclick = async () => { try { await sync(true); say('Sync complete.'); } catch (e) { say(e.message); } };
      root.querySelector('#jee-signout').onclick = async () => { try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); } catch (_) {} clearSession(); say('Signed out. Your local tracker data is unchanged.'); renderDialog(); };
      return;
    }
    let mode = 'login';
    root.querySelectorAll('[data-mode]').forEach(btn => btn.onclick = () => {
      mode = btn.dataset.mode; root.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x === btn));
      root.querySelector('#jee-name-wrap').hidden = mode !== 'register';
      root.querySelector('#jee-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
      root.querySelector('#jee-submit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
    });
    root.querySelector('#jee-auth-form').onsubmit = async e => {
      e.preventDefault(); if (busy) return; busy = true;
      const submit = root.querySelector('#jee-submit'); submit.disabled = true; say('Connecting securely…');
      try {
        const payload = { email: root.querySelector('#jee-email').value.trim(), password: root.querySelector('#jee-password').value };
        if (mode === 'register') payload.name = root.querySelector('#jee-name').value.trim();
        const result = await request(mode === 'register' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
        setSession(result);
      } catch (err) { say(err.message); } finally { busy = false; if (submit.isConnected) submit.disabled = false; }
    };
    root.querySelector('#jee-google').onclick = startGoogle;
  }
  function clearSession() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); try { if (window.AndroidJeeAuth) window.AndroidJeeAuth.clearSession(); } catch (_) {} updateBadge(); }
  async function startGoogle() {
    try {
      if (!configured()) throw new Error('Set your API URL first.');
      if (!window.AndroidJeeAuth || !window.AndroidJeeAuth.openExternal) throw new Error('Google sign-in requires the Android app browser bridge.');
      const verifier = randomVerifier(); const challenge = await sha256(verifier);
      localStorage.setItem('jee.oauth.verifier', verifier);
      const result = await request('/api/auth/google/start', { method: 'POST', body: JSON.stringify({ redirectUri: 'jee2028://oauth/callback', codeChallenge: challenge }) });
      const state = new URL(result.authUrl).searchParams.get('state'); localStorage.setItem('jee.oauth.state', state);
      window.AndroidJeeAuth.openExternal(result.authUrl);
    } catch (e) { const el = document.getElementById('jee-auth-message'); if (el) el.textContent = e.message; }
  }
  function randomVerifier() {
    const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  async function sha256(text) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function handleCallback(raw) {
    try {
      const url = new URL(raw); const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
      const verifier = localStorage.getItem('jee.oauth.verifier'); const expected = localStorage.getItem('jee.oauth.state');
      localStorage.removeItem('jee.oauth.verifier'); localStorage.removeItem('jee.oauth.state');
      if (!state || !expected || state !== expected || !verifier) throw new Error('OAuth state validation failed. Please try again.');
      if (url.searchParams.has('error')) throw new Error('Google sign-in was cancelled.');
      if (!code) throw new Error('Google sign-in could not be completed. Please try again.');
      const result = await request('/api/auth/google/exchange', { method: 'POST', body: JSON.stringify({ code, state, codeVerifier: verifier }) });
      setSession(result);
    } catch (e) { message = e.message; renderDialog(); }
  }
  function mergeData(local, remote) {
    const result = Object.assign({}, remote || {}, local || {});
    result.c = Object.assign({}, remote && remote.c || {}, local && local.c || {});
    result.h = Object.assign({}, remote && remote.h || {});
    Object.keys(local && local.h || {}).forEach(month => {
      const target = result.h[month] || (result.h[month] = {});
      Object.keys(local.h[month] || {}).forEach(key => target[key] = Array.from(new Set([...(target[key] || []), ...(local.h[month][key] || [])])).sort((a, b) => a - b));
    });
    result.n = Object.assign({}, remote && remote.n || {}, local && local.n || {});
    return result;
  }
  async function sync(showError) {
    if (!user() || !token() || !configured()) return;
    const local = (() => { try { return JSON.parse(localStorage.getItem('jee26') || '{}'); } catch (_) { return {}; } })();
    try {
      const remoteResult = await request('/api/data'); const merged = mergeData(local, remoteResult.data && remoteResult.data.data);
      const saved = await request('/api/data', { method: 'PUT', body: JSON.stringify({ data: merged }) });
      localStorage.setItem('jee26', JSON.stringify(saved.data));
      if (typeof window.pushW === 'function') window.pushW();
      if (typeof window.render === 'function') window.render(0);
      message = 'Last synced just now';
    } catch (e) {
      if (/401|Session expired/i.test(e.message)) clearSession();
      if (showError) throw e;
      message = e.message;
    }
  }
  function scheduleSync() {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => sync(false), 1500);
  }
  function init() {
    const button = document.createElement('button'); button.id = 'jee-account-button'; button.className = 'jee-account-button'; button.type = 'button'; button.onclick = renderDialog;
    document.body.appendChild(button); updateBadge();
    if (user() && token()) request('/api/auth/me').catch(() => clearSession());
    const oldSave = window.sv;
    if (typeof oldSave === 'function') window.sv = function () { const out = oldSave.apply(this, arguments); scheduleSync(); return out; };
    const oldCallback = window.onJeeOAuthCallback;
    window.onJeeOAuthCallback = handleCallback;
    if (typeof oldCallback === 'function') window.onJeeOAuthCallback = url => { oldCallback(url); handleCallback(url); };
    if (user() && token()) scheduleSync();
  }
  window.JeeAuth = { handleCallback, open: renderDialog, sync };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
