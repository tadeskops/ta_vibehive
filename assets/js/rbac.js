/* ta_vibehive · rbac.js · client-side role model (G0-02)
 *
 * 2-role launch scope per tvh_plan.md §1.2:
 *   - RESIDENT   (default; can contribute + view public dashboard + own records)
 *   - COMMITTEE  (verify contributions + reconciliation view + audit read)
 *
 * The full 5-level RBAC (Admin > Management Committee > Volunteer > Society Manager
 * > Resident + Auditor cross-cutting) lands post-launch — see tvh_pending.md.
 * The `permissions` map here is a whitelist. Adding a new permission requires
 * adding it to the map AND to tests in tests/rbac.test.js.
 *
 * Server side (GitHub Actions) MUST re-check every permission — this client-side
 * gate is UX only. Never trust it as a security boundary.
 */

export const ROLES = Object.freeze({
  RESIDENT: 'resident',
  COMMITTEE: 'committee',
  ANON: 'anon', // signed-out visitor
});

const P = Object.freeze({
  // read
  VIEW_PUBLIC_DASHBOARD: 'dashboard:public:read',
  VIEW_OWN_CONTRIBUTIONS: 'contributions:own:read',
  VIEW_PENDING_LIST: 'contributions:pending:read',
  VIEW_ALL_CONTRIBUTIONS: 'contributions:all:read',
  VIEW_AUDIT_LOG: 'audit:read',
  // write
  SUBMIT_CONTRIBUTION: 'contributions:own:create',
  VERIFY_CONTRIBUTION: 'contributions:verify',
  EXPORT_RECONCILIATION_CSV: 'reconciliation:export',
});
export const PERMISSIONS = P;

const grid = {
  [ROLES.ANON]: new Set([
    P.VIEW_PUBLIC_DASHBOARD,
  ]),
  [ROLES.RESIDENT]: new Set([
    P.VIEW_PUBLIC_DASHBOARD,
    P.VIEW_OWN_CONTRIBUTIONS,
    P.SUBMIT_CONTRIBUTION,
  ]),
  [ROLES.COMMITTEE]: new Set([
    P.VIEW_PUBLIC_DASHBOARD,
    P.VIEW_OWN_CONTRIBUTIONS,
    P.VIEW_PENDING_LIST,
    P.VIEW_ALL_CONTRIBUTIONS,
    P.VIEW_AUDIT_LOG,
    P.SUBMIT_CONTRIBUTION,
    P.VERIFY_CONTRIBUTION,
    P.EXPORT_RECONCILIATION_CSV,
  ]),
};

/** True iff `role` has `permission`. Unknown role or permission -> false. */
export function can(role, permission) {
  const perms = grid[role];
  if (!perms) return false;
  return perms.has(permission);
}

/** Inverse of can(). */
export function cannot(role, permission) {
  return !can(role, permission);
}

/** Assert helper — throws if the current role lacks the permission. */
export function requirePermission(role, permission) {
  if (!can(role, permission)) {
    const err = new Error(`role "${role}" lacks permission "${permission}"`);
    err.code = 'E_FORBIDDEN';
    throw err;
  }
}
