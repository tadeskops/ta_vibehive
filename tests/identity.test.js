// ta_vibehive · identity + role tests (G0-04)
// node --test tests/identity.test.js

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage polyfill for Node (no jsdom).
class MemStore {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
}
globalThis.localStorage = new MemStore();

const { getIdentity, setIdentity, clearIdentity, hasCommitteeToken,
        setCommitteeToken, currentRole } = await import('../assets/js/identity.js');
const { ROLES } = await import('../assets/js/rbac.js');

beforeEach(() => { globalThis.localStorage.clear(); });

test('no identity stored -> role ANON', () => {
  assert.equal(getIdentity(), null);
  assert.equal(currentRole(), ROLES.ANON);
});

test('setIdentity round-trips name/flat/anonymous', () => {
  setIdentity({ name: 'Aarav Patil', flat: 'A-101', anonymous: false });
  const id = getIdentity();
  assert.equal(id.name, 'Aarav Patil');
  assert.equal(id.flat, 'A-101');
  assert.equal(id.anonymous, false);
  assert.ok(typeof id.savedAt === 'number');
});

test('setIdentity normalizes flat to upper-case + trims name', () => {
  setIdentity({ name: '  Priya K  ', flat: 'a-101' });
  const id = getIdentity();
  assert.equal(id.name, 'Priya K');
  assert.equal(id.flat, 'A-101');
});

test('setIdentity accepts various flat formats', () => {
  const good = ['A-101', 'B-2003', '1401', 'a-1', 'C-9999'];
  for (const flat of good) {
    setIdentity({ name: 'x', flat });
    assert.equal(getIdentity().flat, flat.toUpperCase());
  }
});

test('setIdentity rejects invalid flat', () => {
  const bad = ['abc', 'A101B', '', '   ', '99999', '-101', 'A-'];
  for (const flat of bad) {
    assert.throws(() => setIdentity({ name: 'x', flat }), /flat/);
  }
});

test('setIdentity rejects empty or too-long name', () => {
  assert.throws(() => setIdentity({ name: '', flat: 'A-1' }));
  assert.throws(() => setIdentity({ name: '   ', flat: 'A-1' }));
  assert.throws(() => setIdentity({ name: 'x'.repeat(81), flat: 'A-1' }));
});

test('anonymous flag preserved', () => {
  setIdentity({ name: 'Priya K', flat: 'A-101', anonymous: true });
  assert.equal(getIdentity().anonymous, true);
});

test('identity present -> role RESIDENT (no committee token)', () => {
  setIdentity({ name: 'Aarav', flat: 'A-101' });
  assert.equal(currentRole(), ROLES.RESIDENT);
});

test('valid committee token overrides identity -> COMMITTEE', () => {
  const future = Date.now() + 3600_000;
  setCommitteeToken('gho_dummy', future);
  assert.equal(currentRole(), ROLES.COMMITTEE);
});

test('expired committee token does not grant COMMITTEE', () => {
  assert.throws(() => setCommitteeToken('gho_x', Date.now() - 1));
});

test('committee token TTL respected on read', () => {
  const near = Date.now() + 100;
  setCommitteeToken('gho_dummy', near);
  assert.equal(hasCommitteeToken(Date.now()), true);
  assert.equal(hasCommitteeToken(Date.now() + 200), false);
});

test('setCommitteeToken rejects empty / non-string', () => {
  assert.throws(() => setCommitteeToken('', Date.now() + 1000));
  assert.throws(() => setCommitteeToken(null, Date.now() + 1000));
});

test('clearIdentity removes identity + committee token', () => {
  setIdentity({ name: 'x', flat: 'A-1' });
  setCommitteeToken('gho_x', Date.now() + 3600_000);
  clearIdentity();
  assert.equal(getIdentity(), null);
  assert.equal(hasCommitteeToken(), false);
  assert.equal(currentRole(), ROLES.ANON);
});

test('malformed localStorage payload -> null identity (defensive parse)', () => {
  globalThis.localStorage.setItem('tvh.identity', '{not json');
  assert.equal(getIdentity(), null);
});

test('partial localStorage payload -> null identity', () => {
  globalThis.localStorage.setItem('tvh.identity', JSON.stringify({ name: 'x' }));
  assert.equal(getIdentity(), null);
});
