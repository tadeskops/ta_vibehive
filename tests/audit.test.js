// ta_vibehive · audit-log-lite tests (G0-03)
// node --test tests/audit.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  append, verify, computeHash, canonicalize, tailHash, _internals,
} from '../lib/audit.js';

const FIXED_TS = '2026-08-22T10:00:00.000Z';

function seed() {
  let c = [];
  c = [...c, append(c, { actor: 'system', action: 'chain.init', target: 'audit:2026-08', ts: FIXED_TS })];
  c = [...c, append(c, { actor: 'resident:aarav-p', action: 'contribution.submit', target: 'contribution:2026-ganpati:0001', ts: FIXED_TS, meta: { amount: 2101 } })];
  c = [...c, append(c, { actor: 'committee:priya-k', action: 'contribution.verify', target: 'contribution:2026-ganpati:0001', ts: FIXED_TS, meta: { utr: 'ABC123' } })];
  return c;
}

test('empty chain is valid', () => {
  assert.deepEqual(verify([]), { ok: true });
});

test('append rejects missing fields', () => {
  assert.throws(() => append([], { action: 'x', target: 'y' }), /actor required/);
  assert.throws(() => append([], { actor: 'x', target: 'y' }), /action required/);
  assert.throws(() => append([], { actor: 'x', action: 'y' }), /target required/);
});

test('first entry chains from genesis (64 zeros)', () => {
  const chain = [append([], { actor: 'system', action: 'x', target: 'y', ts: FIXED_TS })];
  assert.equal(chain[0].seq, 1);
  assert.equal(chain[0].prev, _internals.GENESIS_PREV);
  assert.match(chain[0].hash, /^[0-9a-f]{64}$/);
});

test('monotonic seq numbering', () => {
  const chain = seed();
  assert.equal(chain[0].seq, 1);
  assert.equal(chain[1].seq, 2);
  assert.equal(chain[2].seq, 3);
});

test('each entry.prev equals previous entry.hash', () => {
  const chain = seed();
  assert.equal(chain[1].prev, chain[0].hash);
  assert.equal(chain[2].prev, chain[1].hash);
});

test('unmodified chain verifies ok', () => {
  const chain = seed();
  assert.deepEqual(verify(chain), { ok: true });
});

test('tampering with an entry.meta breaks the chain', () => {
  const chain = seed();
  chain[1] = { ...chain[1], meta: { amount: 999999 } }; // tamper
  const result = verify(chain);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 2);
  assert.equal(result.reason, 'hash-mismatch');
});

test('tampering with an entry.actor breaks the chain', () => {
  const chain = seed();
  chain[2] = { ...chain[2], actor: 'system' };
  const result = verify(chain);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 3);
});

test('deleting a middle entry breaks the chain', () => {
  const chain = seed();
  const broken = [chain[0], chain[2]];
  const result = verify(broken);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 3); // seq skipped from 1 to 3
  assert.equal(result.reason, 'seq-not-monotonic');
});

test('reordering entries breaks the chain', () => {
  const chain = seed();
  const swapped = [chain[0], chain[2], chain[1]];
  const result = verify(swapped);
  assert.equal(result.ok, false);
});

test('re-hashing a tampered entry does not repair the chain (prev mismatch on next)', () => {
  const chain = seed();
  chain[1] = { ...chain[1], meta: { amount: 999999 } };
  chain[1] = { ...chain[1], hash: computeHash(chain[1]) }; // attacker recomputes hash
  const result = verify(chain);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 3);
  assert.equal(result.reason, 'prev-mismatch');
});

test('canonicalize is stable regardless of key order', () => {
  const a = canonicalize({ a: 1, b: 2, c: { x: 1, y: 2 } });
  const b = canonicalize({ c: { y: 2, x: 1 }, b: 2, a: 1 });
  assert.equal(a, b);
});

test('tailHash returns genesis for empty chain, last hash otherwise', () => {
  assert.equal(tailHash([]), _internals.GENESIS_PREV);
  const chain = seed();
  assert.equal(tailHash(chain), chain[chain.length - 1].hash);
});

test('appending after verify() still chains correctly', () => {
  const chain = seed();
  const next = append(chain, { actor: 'system', action: 'chain.mark', target: 'audit:2026-08', ts: FIXED_TS });
  const extended = [...chain, next];
  assert.deepEqual(verify(extended), { ok: true });
  assert.equal(next.seq, 4);
  assert.equal(next.prev, chain[2].hash);
});
