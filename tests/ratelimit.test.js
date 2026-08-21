// ta_vibehive · ratelimit tests (G0-04)
// node --test tests/ratelimit.test.js

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class MemStore {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
}
globalThis.localStorage = new MemStore();

const { checkRate, peekRate, resetBucket } = await import('../assets/js/ratelimit.js');

const HOUR = 3_600_000;
const T0 = 1_745_000_000_000; // arbitrary fixed epoch inside an hour boundary

beforeEach(() => { globalThis.localStorage.clear(); });

test('first call consumes one slot', () => {
  const r = checkRate('login', 5, T0);
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 4);
  assert.equal(peekRate('login', T0), 1);
});

test('exhausting the bucket blocks further calls in the same hour', () => {
  for (let i = 0; i < 5; i++) checkRate('login', 5, T0);
  const denied = checkRate('login', 5, T0);
  assert.equal(denied.ok, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.resetInSec > 0 && denied.resetInSec <= 3600);
});

test('bucket resets at the next hour boundary', () => {
  for (let i = 0; i < 5; i++) checkRate('login', 5, T0);
  assert.equal(checkRate('login', 5, T0).ok, false);
  // jump into the next hour
  const next = T0 + HOUR + 1000;
  const r = checkRate('login', 5, next);
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 4);
});

test('separate buckets do not interfere', () => {
  for (let i = 0; i < 3; i++) checkRate('resend', 3, T0);
  const r = checkRate('login', 5, T0);
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 4);
});

test('resetBucket clears the counter', () => {
  for (let i = 0; i < 5; i++) checkRate('login', 5, T0);
  resetBucket('login');
  assert.equal(peekRate('login', T0), 0);
  assert.equal(checkRate('login', 5, T0).ok, true);
});

test('rejects zero or negative maxPerHour', () => {
  assert.throws(() => checkRate('login', 0, T0));
  assert.throws(() => checkRate('login', -1, T0));
});

test('rejects empty bucket name', () => {
  assert.throws(() => checkRate('', 5, T0));
});

test('malformed stored counter -> reset to fresh window', () => {
  globalThis.localStorage.setItem('tvh.rl.login', 'garbage');
  const r = checkRate('login', 5, T0);
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 4);
});
