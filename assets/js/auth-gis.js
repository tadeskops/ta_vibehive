/* VibeHive Google Identity Services (GIS) shim.
 *
 * Mirrors the ta-society-helpdesk pattern (docs/assets/js/auth.js) —
 * different from the OAuth-code+PKCE flow that this repo shipped
 * originally. The GIS flow is cleaner for our "just validate the
 * email" use case:
 *   - No redirect (GIS uses a popup + FedCM),
 *   - No client_secret,
 *   - Returns a signed ID token (JWT) that VibeHive decodes locally,
 *   - Reuses the same OAuth "Web application" client as tsh because
 *     both apps share the origin https://tadeskops.github.io/.
 *
 * Consumer surface (all sync unless noted):
 *   await Auth.init({ clientId: '<GOOGLE_OAUTH_CLIENT_ID>' });
 *   Auth.onChange((state) => { ... });         // { signedIn, token, email, name, picture }
 *   await Auth.signIn();                        // opens GIS prompt / rendered button
 *   Auth.signOut();
 *   Auth.token();                               // current bearer or null
 *   Auth.hasSession();                          // sync bool
 *
 * localStorage keys used (namespaced `tvh_`, mirrors tsh's `tsh_`):
 *   tvh_id_token   — the raw Google ID token JWT
 *   tvh_signed_in  — '1' hint so a fresh tab can attempt silent re-auth
 *
 * Nothing else is persisted. No refresh token, no PII beyond what's
 * inside the JWT itself (email/name/picture/sub).
 */
(function (root) {
  'use strict';

  const state = {
    clientId: null,
    token: null,   // raw JWT
    email: null,
    name: null,
    picture: null,
    expiry: 0,     // ms epoch
  };
  const listeners = new Set();

  function notify() {
    const snap = {
      signedIn: !!state.token,
      token: state.token,
      email: state.email,
      name: state.name,
      picture: state.picture,
    };
    for (const fn of listeners) {
      try { fn(snap); } catch (e) { console.error(e); }
    }
  }

  function decodeJwt(jwt) {
    try {
      const [, payload] = jwt.split('.');
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decodeURIComponent(escape(json)));
    } catch (_e) {
      return null;
    }
  }

  const STORAGE_KEY = 'tvh_id_token';
  const HINT_KEY    = 'tvh_signed_in';

  const STORE = (function () {
    try {
      const t = '__tvh_probe__';
      localStorage.setItem(t, '1'); localStorage.removeItem(t);
      return localStorage;
    } catch (_e) {
      try { return sessionStorage; } catch (_e2) { return null; }
    }
  })();

  function safeRead(key) {
    if (!STORE) return '';
    try { return STORE.getItem(key) || ''; } catch (_e) { return ''; }
  }
  function safeWrite(key, val) {
    if (!STORE) return;
    try { STORE.setItem(key, val); } catch (_e) { /* ignore quota / SecurityError */ }
  }
  function safeRemove(key) {
    if (!STORE) return;
    try { STORE.removeItem(key); } catch (_e) { /* ignore */ }
  }

  function applyToken(jwt) {
    const claims = decodeJwt(jwt);
    if (!claims || !claims.email) {
      console.warn('TVH auth: invalid id_token');
      return;
    }
    state.token = jwt;
    state.email = String(claims.email).toLowerCase();
    state.name = claims.name || null;
    state.picture = claims.picture || null;
    state.expiry = (claims.exp || 0) * 1000;
    safeWrite(HINT_KEY, '1');
    safeWrite(STORAGE_KEY, jwt);
    notify();
  }

  function clear() {
    state.token = null;
    state.email = null;
    state.name = null;
    state.picture = null;
    state.expiry = 0;
    safeRemove(HINT_KEY);
    safeRemove(STORAGE_KEY);
    notify();
  }

  function restoreFromStorage() {
    const jwt = safeRead(STORAGE_KEY);
    if (!jwt) return false;
    const claims = decodeJwt(jwt);
    if (!claims || !claims.exp) return false;
    const expMs = claims.exp * 1000;
    if (Date.now() > expMs - 60_000) {
      safeRemove(STORAGE_KEY);
      safeRemove(HINT_KEY);
      return false;
    }
    state.token = jwt;
    state.email = String(claims.email || '').toLowerCase();
    state.name = claims.name || null;
    state.picture = claims.picture || null;
    state.expiry = expMs;
    return true;
  }

  function hasSession() {
    if (state.token && Date.now() < state.expiry - 30_000) return true;
    const jwt = safeRead(STORAGE_KEY);
    if (!jwt) return false;
    const claims = decodeJwt(jwt);
    if (!claims || !claims.exp) return false;
    return Date.now() < (claims.exp * 1000) - 30_000;
  }

  async function loadGisScript() {
    if (window.google && window.google.accounts && window.google.accounts.id) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('GIS script failed to load'));
      document.head.appendChild(s);
    });
  }

  async function init(opts) {
    state.clientId = opts.clientId;

    const restored = restoreFromStorage();

    await loadGisScript();
    window.google.accounts.id.initialize({
      client_id: state.clientId,
      callback: (resp) => { if (resp && resp.credential) applyToken(resp.credential); },
      auto_select: true,
      cancel_on_tap_outside: true,
      use_fedcm_for_prompt: true,
      itp_support: true,
    });

    let hint = safeRead(HINT_KEY);
    if (!restored && hint === '1') {
      await new Promise((resolve) => {
        let done = false;
        const off = onChange((s) => {
          if (done || !s.signedIn) return;
          done = true;
          try { off(); } catch (_e) { /* ignore */ }
          resolve();
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { off(); } catch (_e) { /* ignore */ }
          resolve();
        }, 2500);
        try {
          window.google.accounts.id.prompt((notification) => {
            if (done) return;
            if (notification && (
              (typeof notification.isNotDisplayed === 'function' && notification.isNotDisplayed()) ||
              (typeof notification.isSkippedMoment === 'function' && notification.isSkippedMoment())
            )) {
              done = true;
              clearTimeout(timer);
              try { off(); } catch (_e) { /* ignore */ }
              safeRemove(HINT_KEY);
              resolve();
            }
          });
        } catch (_e) {
          done = true;
          clearTimeout(timer);
          try { off(); } catch (_e2) { /* ignore */ }
          resolve();
        }
      });
    }
    notify();
  }

  /* Fallback: rendered Google Sign-In button clicked programmatically
   * when One Tap is suppressed (FedCM off / third-party cookies blocked
   * / GIS backoff after a dismissal). The rendered button opens the
   * OAuth popup directly, so it's more reliable than the One Tap prompt.
   */
  let renderedBtnHost = null;

  function ensureRenderedButton() {
    if (renderedBtnHost && document.body.contains(renderedBtnHost)) return renderedBtnHost;
    if (!window.google || !window.google.accounts || !window.google.accounts.id) return null;
    renderedBtnHost = document.createElement('div');
    renderedBtnHost.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:auto;';
    renderedBtnHost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(renderedBtnHost);
    try {
      window.google.accounts.id.renderButton(renderedBtnHost, {
        type: 'standard', theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'rectangular',
      });
    } catch (e) {
      console.warn('TVH auth: renderButton failed', e);
    }
    return renderedBtnHost;
  }

  function clickRenderedButton() {
    const host = ensureRenderedButton();
    if (!host) return false;
    const target =
      host.querySelector('div[role="button"]') ||
      host.querySelector('button') ||
      host.querySelector('div[tabindex]') ||
      host.firstElementChild;
    if (!target) return false;
    try { target.click(); return true; } catch (_e) { return false; }
  }

  async function signIn() {
    if (!state.clientId) throw new Error('Auth.init() not called');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; resolve(ok); };

      const off = onChange((s) => {
        if (s.signedIn) { try { off(); } catch (_e) {} finish(true); }
      });

      let promptTried = false;
      try {
        window.google.accounts.id.prompt((notification) => {
          const blocked =
            (notification && (
              (typeof notification.isNotDisplayed === 'function' && notification.isNotDisplayed()) ||
              (typeof notification.isSkippedMoment === 'function' && notification.isSkippedMoment()) ||
              (typeof notification.isDismissedMoment === 'function' && notification.isDismissedMoment())
            ));
          if (blocked && !settled) {
            const clicked = clickRenderedButton();
            if (!clicked) { try { off(); } catch (_e) {} finish(false); }
          }
        });
        promptTried = true;
      } catch (_e) {
        const clicked = clickRenderedButton();
        if (!clicked) { try { off(); } catch (_e2) {} finish(false); }
      }

      setTimeout(() => {
        if (settled) return;
        if (promptTried) clickRenderedButton();
        setTimeout(() => { try { off(); } catch (_e) {} finish(false); }, 4000);
      }, 4000);
    });
  }

  function signOut() {
    try {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        window.google.accounts.id.disableAutoSelect();
      }
    } catch (_e) { /* ignore */ }
    clear();
  }

  function tokenIfFresh() {
    if (!state.token) return null;
    if (Date.now() > state.expiry - 30_000) {
      clear();
      return null;
    }
    return state.token;
  }

  function onChange(fn) {
    listeners.add(fn);
    try { fn({ signedIn: !!state.token, token: state.token, email: state.email, name: state.name, picture: state.picture }); }
    catch (e) { console.error(e); }
    return () => listeners.delete(fn);
  }

  root.Auth = { init, signIn, signOut, token: tokenIfFresh, hasSession, onChange, email: () => state.email };
})(window);
