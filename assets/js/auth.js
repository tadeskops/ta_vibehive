/* Auth adapter.
 * Two tiers:
 *   - Google Identity Services (GIS) via window.Auth (assets/js/auth-gis.js)
 *     → real identity. Signed JWT decoded client-side, no server needed.
 *   - Demo persona picker (LOCALHOST ONLY — see views/login.js) → keeps
 *     the app usable for local iteration without going through Google
 *     every time. Never reachable from a live deploy.
 * Both funnel through `state.setCurrentUser` so callers never care.
 */
'use strict';
import { state } from './store.js';

function pick(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}
function roleFromEmailMap(email) {
  const over = state.societyOverrides() || {};
  const map = pick(over, 'access.email_roles') || {};
  const role = map[email];
  return typeof role === 'string' ? role : null;
}
function isVerifiedResidentEmail(email) {
  const over = state.societyOverrides() || {};
  const list = pick(over, 'residents.allowed_gmail') || [];
  if (!Array.isArray(list)) return false;
  return list.map(normalizeEmail).includes(email);
}

export function session() { return state.currentUser(); }

export function loginAs(userId) {
  const user = state.users().find(u => u.id === userId);
  if (!user) throw new Error('unknown user');
  state.setCurrentUser({ id: user.id, name: user.name, role: user.role, flat: user.flat, email: user.email });
  state.audit({ actor: user.id, action: 'auth.login' });
  return user;
}

/** Upsert a user from an OAuth profile, then sign them in.
 *  Existing users (matched by email, case-insensitive) keep their role
 *  and flat; new users are auto-provisioned as `resident` with a blank
 *  flat that they can complete on their profile page later. */
export function loginWithProfile(profile) {
  const users = state.users();
  const email = normalizeEmail(profile.email);
  if (!email) throw new Error('provider returned no email');
  const mappedRole = roleFromEmailMap(email);
  const verifiedResident = isVerifiedResidentEmail(email);
  const existing = users.find(u => (u.email || '').toLowerCase() === email);
  let user;
  if (existing) {
    user = { ...existing };
    if (profile.name && (!existing.name || existing.name === existing.email)) user.name = profile.name;
    if (!user.provider) user.provider = profile.provider;
    if (mappedRole) user.role = mappedRole;
    user.is_verified_resident = verifiedResident;
    const idx = users.findIndex(u => u.id === existing.id);
    if (idx >= 0) users[idx] = user;
    state.saveUsers(users);
  } else {
    user = {
      id: 'oauth:' + profile.provider + ':' + email,
      name: profile.name || email.split('@')[0],
      role: mappedRole || 'resident',
      flat: '',
      email,
      provider: profile.provider,
      is_verified_resident: verifiedResident,
    };
    users.push(user);
    state.saveUsers(users);
    state.audit({ actor: user.id, action: 'user.provision', detail: profile.provider });
  }
  state.setCurrentUser({ id: user.id, name: user.name, role: user.role, flat: user.flat, email: user.email });
  state.audit({ actor: user.id, action: 'auth.login', detail: profile.provider });
  return user;
}

export function logout() {
  const u = state.currentUser();
  if (u) state.audit({ actor: u.id, action: 'auth.logout' });
  state.setCurrentUser(null);
  // Also drop the GIS JWT so a follow-up sign-in re-prompts.
  try { if (window.Auth && typeof window.Auth.signOut === 'function') window.Auth.signOut(); }
  catch (_e) { /* ignore */ }
}

export function isLoggedIn() { return !!state.currentUser(); }

/** Bridge Google Identity Services → VibeHive session.
 *  Called once at app boot from app.js. Idempotent: subsequent calls
 *  are no-ops. Listens for GIS token arrivals and upserts the user
 *  via loginWithProfile. Never fires on plain page loads unless GIS
 *  actually restores a persisted JWT. */
let _gisBound = false;
export function bindGis() {
  if (_gisBound) return;
  if (typeof window === 'undefined' || !window.Auth || typeof window.Auth.onChange !== 'function') return;
  _gisBound = true;
  window.Auth.onChange((snap) => {
    if (!snap || !snap.signedIn || !snap.email) return;
    const current = state.currentUser();
    // Don't clobber an active demo persona picker session — only auto-sign
    // in from GIS if there's no session, or the session belongs to a
    // previously-provisioned Google account.
    if (current && !String(current.id || '').startsWith('oauth:google')) return;
    try {
      loginWithProfile({
        email: snap.email,
        name: snap.name || snap.email.split('@')[0],
        sub: null,
        provider: 'google',
      });
    } catch (e) { console.warn('bindGis: upsert failed', e); }
  });
}


