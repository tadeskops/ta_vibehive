// ta_vibehive · tests/contribute.test.js (G1-02)
// Pure validator + draft persistence tests. Alpine submit flow is DOM-level and
// covered by G2 Playwright suite.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAmount,
  saveDraft,
  readDraft,
  clearDraft,
  CONTRIB_MIN_INR,
  CONTRIB_MAX_INR,
} from '../assets/js/contribute.js';

// Fake localStorage compatible with our helpers.
class MemStore {
  constructor() { this.m = new Map(); }
  getItem(k)      { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v)   { this.m.set(k, String(v)); }
  removeItem(k)   { this.m.delete(k); }
}

let store;
beforeEach(() => { store = new MemStore(); });

test('validateAmount accepts a plain integer', () => {
  assert.equal(validateAmount(1001), 1001);
  assert.equal(validateAmount('1001'), 1001);
  assert.equal(validateAmount(CONTRIB_MIN_INR), CONTRIB_MIN_INR);
  assert.equal(validateAmount(CONTRIB_MAX_INR), CONTRIB_MAX_INR);
});

test('validateAmount rejects empty / null / undefined', () => {
  for (const bad of ['', null, undefined]) {
    assert.throws(() => validateAmount(bad), /amount required/);
  }
});

test('validateAmount rejects non-integer / decimals / negatives / signs', () => {
  for (const bad of ['1000.5', '-100', '1e3', '1,001', '  ', 'abc', '+101', '100 ', ' 100']) {
    assert.throws(() => validateAmount(bad), /whole rupee integer/);
  }
});

test('validateAmount enforces minimum floor', () => {
  assert.throws(() => validateAmount(1), /minimum is/);
  assert.throws(() => validateAmount(100), /minimum is/);
});

test('validateAmount enforces maximum ceiling', () => {
  assert.throws(() => validateAmount(CONTRIB_MAX_INR + 1), /maximum is/);
  assert.throws(() => validateAmount(9999999), /maximum is/);
});

test('validateAmount honors custom min/max overrides', () => {
  assert.equal(validateAmount(50, { min: 50, max: 100 }), 50);
  assert.throws(() => validateAmount(49, { min: 50, max: 100 }), /minimum/);
  assert.throws(() => validateAmount(101, { min: 50, max: 100 }), /maximum/);
});

test('saveDraft and readDraft round-trip', () => {
  assert.equal(readDraft(store), null);
  const ok = saveDraft(store, { eventId: 'ganpati-2026', amountInr: 2101, anonymous: false });
  assert.equal(ok, true);
  const d = readDraft(store);
  assert.equal(d.eventId, 'ganpati-2026');
  assert.equal(d.amountInr, 2101);
  assert.equal(d.anonymous, false);
  assert.ok(typeof d.ts === 'number' && d.ts > 0);
});

test('saveDraft coerces types defensively', () => {
  saveDraft(store, { eventId: 42, amountInr: '1001', anonymous: 'yes' });
  const d = readDraft(store);
  assert.equal(d.eventId, '42');
  assert.equal(d.amountInr, 1001);
  assert.equal(d.anonymous, true);
});

test('readDraft returns null on malformed payload', () => {
  store.setItem('tvh.contrib.draft', '{not json');
  assert.equal(readDraft(store), null);
  store.setItem('tvh.contrib.draft', 'null');
  assert.equal(readDraft(store), null);
  store.setItem('tvh.contrib.draft', '{"eventId":123}');
  assert.equal(readDraft(store), null);
});

test('clearDraft removes the entry', () => {
  saveDraft(store, { eventId: 'x', amountInr: 500, anonymous: true });
  assert.ok(readDraft(store));
  clearDraft(store);
  assert.equal(readDraft(store), null);
});

test('readDraft is safe when store is empty / missing', () => {
  assert.equal(readDraft(new MemStore()), null);
});
