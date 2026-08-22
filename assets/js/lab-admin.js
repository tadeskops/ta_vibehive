/*!
 * Hard-coded bootstrap admins.
 *
 * The emails below belong to the maintainers of this project. They are
 * baked into the code (never read from config) so that regardless of
 * what any localStorage/roles.json/committee list looks like, these
 * identities are always resolved to role="admin" and cannot be
 * demoted, deleted, or renamed from any UI screen. If a row is missing
 * when users are read, we inject it; if a caller tries to persist a
 * user list without one (or with a downgraded copy of one), we heal
 * the payload before it lands in storage. Any session that binds one
 * of these emails is also normalised to admin on both read and write.
 *
 * This is intentionally client-side only (matches the rest of the SPA);
 * once a real backend is wired the same identities should be enforced
 * server-side as well.
 *
 * Bootstrapping model — a fresh production deploy has no residents in
 * localStorage, so the FIRST Google-authenticated user auto-provisions
 * as `resident` (see auth.js `loginWithProfile`). Nobody would be able
 * to reach the admin console. To break that chicken-and-egg the two
 * emails below always resolve to admin on sign-in.
 */
'use strict';

/** Immutable — DO NOT parameterise. Order matters only for the
 *  "canonical" row shown in admin UIs (the first entry wins when the
 *  admin console renders the locked row). */
export const LAB_ADMIN_EMAILS = Object.freeze([
  'samanasippa@gmail.com',
  'ta.deskops@gmail.com',
]);

/** Canonical rows. Marked `locked:true` so admin UIs can grey out the
 *  row's edit/delete affordances. */
export const LAB_ADMINS = Object.freeze([
  Object.freeze({
    id: 'lab:samanasippa@gmail.com',
    name: 'Samana Sippa (Lab)',
    role: 'admin',
    flat: '—',
    email: 'samanasippa@gmail.com',
    provider: 'lab',
    locked: true,
  }),
  Object.freeze({
    id: 'lab:ta.deskops@gmail.com',
    name: 'TA DeskOps (Maintainer)',
    role: 'admin',
    flat: '—',
    email: 'ta.deskops@gmail.com',
    provider: 'lab',
    locked: true,
  }),
]);

/** Back-compat single-value re-exports. Kept because a few call sites
 *  in early views imported the singular names before the list existed. */
export const LAB_ADMIN_EMAIL = LAB_ADMINS[0].email;
export const LAB_ADMIN = LAB_ADMINS[0];

export function isLabAdmin(email) {
  const e = String(email || '').toLowerCase().trim();
  return LAB_ADMIN_EMAILS.includes(e);
}

/** Normalise a single user object: if its email matches a lab admin,
 *  clamp role to "admin" and mark it locked. Returns the same reference
 *  when no change is needed so identity checks upstream still work. */
export function normalizeUser(u) {
  if (!u || !isLabAdmin(u.email)) return u;
  if (u.role === 'admin' && u.locked === true) return u;
  return { ...u, role: 'admin', locked: true };
}

/** Return a users array with every lab admin guaranteed to exist
 *  exactly once and correctly shaped. Preserves any custom display
 *  name the caller had already given a row. Non-mutating. */
export function withLabAdmin(users) {
  const list = Array.isArray(users) ? users.slice() : [];
  for (const canonical of LAB_ADMINS) {
    const target = canonical.email;
    const idx = list.findIndex(u => u && String(u.email || '').toLowerCase().trim() === target);
    if (idx >= 0) {
      const prior = list[idx] || {};
      list[idx] = {
        ...canonical,
        /* Keep any admin-chosen display name, but fall back to the
         * canonical name if the stored one is blank. */
        name: (prior.name && String(prior.name).trim()) || canonical.name,
      };
    } else {
      list.push({ ...canonical });
    }
  }
  return list;
}
