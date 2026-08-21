/*!
 * Hard-coded lab super-admin.
 *
 * The email below belongs to the lab developing this project. It is baked
 * into the code (never read from config) so that regardless of what any
 * localStorage/roles.json/committee list looks like, this identity is
 * always resolved to role="admin" and cannot be demoted, deleted, or
 * renamed from any UI screen. If the row is missing when users are read,
 * we inject it; if a caller tries to persist a user list without it (or
 * with a downgraded copy of it), we heal the payload before it lands in
 * storage. Any session that binds this email is also normalized to admin
 * on both read and write.
 *
 * This is intentionally client-side only (matches the rest of the SPA);
 * once a real backend is wired the same identity should be enforced
 * server-side as well.
 */
'use strict';

/** Immutable — DO NOT parameterise. */
export const LAB_ADMIN_EMAIL = 'samanasippa@gmail.com';

/** Canonical row. Marked `locked:true` so admin UIs can grey out the
 *  row's edit/delete affordances. */
export const LAB_ADMIN = Object.freeze({
  id: 'lab:samanasippa@gmail.com',
  name: 'Samana Sippa (Lab)',
  role: 'admin',
  flat: '—',
  email: LAB_ADMIN_EMAIL,
  provider: 'lab',
  locked: true,
});

export function isLabAdmin(email) {
  return String(email || '').toLowerCase().trim() === LAB_ADMIN_EMAIL;
}

/** Normalize a single user object: if its email matches the lab admin,
 *  clamp role to "admin" and mark it locked. Returns the same reference
 *  when no change is needed so identity checks upstream still work. */
export function normalizeUser(u) {
  if (!u || !isLabAdmin(u.email)) return u;
  if (u.role === 'admin' && u.locked === true) return u;
  return { ...u, role: 'admin', locked: true };
}

/** Return a users array with the lab admin guaranteed to exist exactly
 *  once and correctly shaped. Preserves any custom display name the
 *  caller had already given the row. Non-mutating. */
export function withLabAdmin(users) {
  const list = Array.isArray(users) ? users.slice() : [];
  const idx = list.findIndex(u => isLabAdmin(u && u.email));
  if (idx >= 0) {
    const prior = list[idx] || {};
    list[idx] = {
      ...LAB_ADMIN,
      /* Keep any admin-chosen display name, but only if it's not the
       * seed placeholder for another row. */
      name: (prior.name && String(prior.name).trim()) || LAB_ADMIN.name,
    };
  } else {
    list.push({ ...LAB_ADMIN });
  }
  return list;
}
