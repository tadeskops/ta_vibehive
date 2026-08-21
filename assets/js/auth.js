/* Auth adapter.
 * Demo tier: pick-a-user selector (localStorage). Production tier will swap in
 * OTP via GitHub Action + signed JWT — same `session()` + `login()` surface.
 * Nothing outside this module reads/writes the session directly.
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

export function logout() {
  const u = state.currentUser();
  if (u) state.audit({ actor: u.id, action: 'auth.logout' });
  state.setCurrentUser(null);
}

export function isLoggedIn() { return !!state.currentUser(); }
