// ta_vibehive · rbac tests (G0-02)
// Node's built-in test runner — no jest, no vitest.
// Run: node --test tests/rbac.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, cannot, requirePermission, ROLES, PERMISSIONS as P } from '../assets/js/rbac.js';

test('anon can view the public dashboard', () => {
  assert.equal(can(ROLES.ANON, P.VIEW_PUBLIC_DASHBOARD), true);
});

test('anon cannot submit a contribution', () => {
  assert.equal(can(ROLES.ANON, P.SUBMIT_CONTRIBUTION), false);
});

test('anon cannot view own contributions (no identity)', () => {
  assert.equal(can(ROLES.ANON, P.VIEW_OWN_CONTRIBUTIONS), false);
});

test('resident can submit a contribution', () => {
  assert.equal(can(ROLES.RESIDENT, P.SUBMIT_CONTRIBUTION), true);
});

test('resident can view own contributions', () => {
  assert.equal(can(ROLES.RESIDENT, P.VIEW_OWN_CONTRIBUTIONS), true);
});

test('resident cannot verify contributions', () => {
  assert.equal(can(ROLES.RESIDENT, P.VERIFY_CONTRIBUTION), false);
});

test('resident cannot view all contributions', () => {
  assert.equal(can(ROLES.RESIDENT, P.VIEW_ALL_CONTRIBUTIONS), false);
});

test('resident cannot view the audit log', () => {
  assert.equal(can(ROLES.RESIDENT, P.VIEW_AUDIT_LOG), false);
});

test('resident cannot export reconciliation CSV', () => {
  assert.equal(can(ROLES.RESIDENT, P.EXPORT_RECONCILIATION_CSV), false);
});

test('committee can verify contributions', () => {
  assert.equal(can(ROLES.COMMITTEE, P.VERIFY_CONTRIBUTION), true);
});

test('committee can view all contributions', () => {
  assert.equal(can(ROLES.COMMITTEE, P.VIEW_ALL_CONTRIBUTIONS), true);
});

test('committee can export reconciliation CSV', () => {
  assert.equal(can(ROLES.COMMITTEE, P.EXPORT_RECONCILIATION_CSV), true);
});

test('committee can view audit log', () => {
  assert.equal(can(ROLES.COMMITTEE, P.VIEW_AUDIT_LOG), true);
});

test('committee can also submit a contribution (they are residents too)', () => {
  assert.equal(can(ROLES.COMMITTEE, P.SUBMIT_CONTRIBUTION), true);
});

test('unknown role has no permissions', () => {
  assert.equal(can('godmode', P.SUBMIT_CONTRIBUTION), false);
  assert.equal(can(undefined, P.SUBMIT_CONTRIBUTION), false);
  assert.equal(can(null, P.VIEW_PUBLIC_DASHBOARD), false);
});

test('unknown permission is never granted', () => {
  assert.equal(can(ROLES.COMMITTEE, 'db:drop-all'), false);
  assert.equal(can(ROLES.RESIDENT, 'sudo'), false);
});

test('cannot() is the inverse of can()', () => {
  assert.equal(cannot(ROLES.RESIDENT, P.VERIFY_CONTRIBUTION), true);
  assert.equal(cannot(ROLES.COMMITTEE, P.VERIFY_CONTRIBUTION), false);
});

test('requirePermission throws E_FORBIDDEN for missing perms', () => {
  assert.throws(
    () => requirePermission(ROLES.RESIDENT, P.VERIFY_CONTRIBUTION),
    (err) => err.code === 'E_FORBIDDEN',
  );
});

test('requirePermission is silent for valid perms', () => {
  assert.doesNotThrow(
    () => requirePermission(ROLES.COMMITTEE, P.VERIFY_CONTRIBUTION),
  );
});

test('permissions map is frozen (no runtime tampering)', () => {
  assert.throws(() => { P.NEW_PERM = 'foo'; }, TypeError);
  assert.throws(() => { ROLES.SUPERADMIN = 'x'; }, TypeError);
});
