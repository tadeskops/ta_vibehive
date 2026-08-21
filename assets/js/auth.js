/* Auth adapter.
 * Two tiers:
 *   - OAuth 2.0 (Google / Microsoft / Yahoo) via PKCE → real identity.
 *   - Demo persona picker (localhost / when no provider is configured)
 *     → keeps the app usable without any provider setup.
 * Both funnel through `state.setCurrentUser` so callers never care.
 */
'use strict';
import { state } from './store.js';

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
  const email = String(profile.email || '').toLowerCase();
  if (!email) throw new Error('provider returned no email');
  const existing = users.find(u => (u.email || '').toLowerCase() === email);
  let user;
  if (existing) {
    user = { ...existing };
    if (profile.name && (!existing.name || existing.name === existing.email)) user.name = profile.name;
    if (!user.provider) user.provider = profile.provider;
  } else {
    user = {
      id: 'oauth:' + profile.provider + ':' + email,
      name: profile.name || email.split('@')[0],
      role: 'resident',
      flat: '',
      email,
      provider: profile.provider,
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
}

export function isLoggedIn() { return !!state.currentUser(); }

