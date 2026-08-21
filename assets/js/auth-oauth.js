/* OAuth 2.0 Authorization Code + PKCE (RFC 7636).
 * No client_secret, no third-party SDK — pure Web Crypto API + fetch.
 * Works entirely from a static site; the provider is contacted directly
 * from the user's browser.
 *
 * Flow:
 *   beginLogin(provider)   → generate PKCE pair, stash verifier, redirect to provider.
 *   completeLogin(code, s) → look up verifier by state, POST token, fetch userinfo, return profile.
 */
'use strict';

const NS = 'tvh:v1:oauth:';

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
async function sha256Bytes(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(digest);
}

/** Compute the redirect_uri the provider must be configured with. It is the
 *  origin + path of the SPA (no fragment, no query) so provider consoles
 *  accept it. Example: https://tadeskops.github.io/ta_vibehive/. */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/** Persist tiny state per authorization request. Uses sessionStorage so the
 *  verifier is discarded when the tab closes. */
function stash(state, entry) { sessionStorage.setItem(NS + state, JSON.stringify(entry)); }
function claim(state) {
  const key = NS + state;
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  sessionStorage.removeItem(key);
  try { return JSON.parse(raw); } catch { return null; }
}

/** Start the OAuth dance. Redirects the whole tab to the provider's
 *  authorize endpoint. On return the provider will bounce back to
 *  redirectUri() with ?code=…&state=… appended. */
export async function beginLogin(provider) {
  if (!provider || !provider.clientId) throw new Error('Provider not configured');
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const challenge = b64url(await sha256Bytes(verifier));
  stash(state, { verifier, provider: provider.id, nonce, ts: Date.now() });
  const params = new URLSearchParams({
    client_id:             provider.clientId,
    response_type:         'code',
    redirect_uri:          redirectUri(),
    scope:                 provider.scope || 'openid email profile',
    state,
    nonce,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    prompt:                'select_account',
  });
  for (const [k, v] of Object.entries(provider.extraAuthorizeParams || {})) params.set(k, String(v));
  const url = provider.authorizeUrl + (provider.authorizeUrl.includes('?') ? '&' : '?') + params.toString();
  location.assign(url);
}

/** Exchange the code for a token, then fetch the user profile. Returns
 *  { email, name, sub, provider } or throws. */
export async function completeLogin(providers, code, state) {
  const stashed = claim(state);
  if (!stashed) throw new Error('Login state expired. Please try again.');
  const provider = (providers || []).find(p => p.id === stashed.provider);
  if (!provider) throw new Error('Unknown provider in login state.');
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     provider.clientId,
    redirect_uri:  redirectUri(),
    code_verifier: stashed.verifier,
  });
  const tokRes = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body,
    credentials: 'omit',
  });
  if (!tokRes.ok) throw new Error('Token exchange failed (' + tokRes.status + ')');
  const tok = await tokRes.json();
  if (!tok.access_token) throw new Error('Provider did not return access_token');
  const uiRes = await fetch(provider.userinfoUrl, {
    headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Accept': 'application/json' },
    credentials: 'omit',
  });
  if (!uiRes.ok) throw new Error('Userinfo fetch failed (' + uiRes.status + ')');
  const info = await uiRes.json();
  const email = info.email || info.preferred_username || info.upn || '';
  const name  = info.name  || info.given_name || (email ? email.split('@')[0] : 'User');
  const sub   = info.sub   || email;
  if (!email) throw new Error('Provider did not return an email address.');
  return { email: email.toLowerCase(), name, sub, provider: provider.id };
}

/** True when the current URL is a provider callback with code+state. Called
 *  during bootstrap; if true, app.js hands off to the auth-callback view. */
export function isCallbackHit() {
  const q = new URLSearchParams(location.search);
  return q.has('code') && q.has('state');
}
