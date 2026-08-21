// ta_vibehive · tests/event.test.js (G1-01)
// Tests the pure validator + formatters exported from assets/js/event.js.
// The Alpine component itself needs a DOM harness (Playwright, deferred to G2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateEventConfig,
  formatINR,
  formatDate,
  clusterClass,
} from '../assets/js/event.js';

const validConfig = {
  id: 'ganpati-2026',
  title: 'Ganesh Chaturthi 2026',
  purpose: 'Community celebration',
  goal_inr: 250000,
  cluster: 'A',
  dates: { start: '2026-09-14', end: '2026-09-24' },
  tiers_inr: [1001, 2101, 5101],
};

test('validateEventConfig accepts the shipped ganpati_2026.json unchanged', () => {
  const raw = JSON.parse(readFileSync(new URL('../config/ganpati_2026.json', import.meta.url), 'utf8'));
  const cfg = validateEventConfig(raw);
  assert.equal(cfg.id, 'ganpati-2026');
  assert.equal(cfg.cluster, 'A');
  assert.ok(cfg.goal_inr > 0);
  assert.ok(Array.isArray(cfg.tiers_inr) && cfg.tiers_inr.length >= 1);
});

test('validateEventConfig accepts a minimal valid config', () => {
  const cfg = validateEventConfig({ ...validConfig });
  assert.deepEqual(cfg, validConfig);
});

test('validateEventConfig rejects non-object input', () => {
  for (const bad of [null, undefined, 42, 'string', []]) {
    assert.throws(() => validateEventConfig(bad), /config must be an object/);
  }
});

test('validateEventConfig rejects missing required keys', () => {
  const required = ['id', 'title', 'purpose', 'goal_inr', 'cluster', 'dates', 'tiers_inr'];
  for (const k of required) {
    const bad = { ...validConfig };
    delete bad[k];
    assert.throws(() => validateEventConfig(bad), new RegExp(`missing required key '${k}'`));
  }
});

test('validateEventConfig rejects malformed id (uppercase/space/too long)', () => {
  for (const bad of ['Ganpati', 'ganpati 2026', 'ab', 'a'.repeat(50), 'foo_bar']) {
    assert.throws(() => validateEventConfig({ ...validConfig, id: bad }), /id must be lowercase-kebab/);
  }
});

test('validateEventConfig rejects empty / oversized title', () => {
  assert.throws(() => validateEventConfig({ ...validConfig, title: '' }), /title must be/);
  assert.throws(() => validateEventConfig({ ...validConfig, title: '   ' }), /title must be/);
  assert.throws(() => validateEventConfig({ ...validConfig, title: 'x'.repeat(121) }), /title must be/);
});

test('validateEventConfig rejects oversized purpose', () => {
  assert.throws(() => validateEventConfig({ ...validConfig, purpose: 'x'.repeat(401) }), /purpose must be/);
});

test('validateEventConfig rejects bad goal amounts', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '250000', 100_000_001]) {
    assert.throws(() => validateEventConfig({ ...validConfig, goal_inr: bad }), /goal_inr/);
  }
});

test('validateEventConfig rejects bad cluster', () => {
  for (const bad of ['E', 'a', '1', '', 'AA']) {
    assert.throws(() => validateEventConfig({ ...validConfig, cluster: bad }), /cluster must be/);
  }
});

test('validateEventConfig rejects bad date formats', () => {
  assert.throws(() => validateEventConfig({ ...validConfig, dates: { start: '2026/09/14', end: '2026-09-24' } }), /YYYY-MM-DD/);
  assert.throws(() => validateEventConfig({ ...validConfig, dates: { start: '2026-9-14', end: '2026-09-24' } }), /YYYY-MM-DD/);
  assert.throws(() => validateEventConfig({ ...validConfig, dates: { start: '2026-09-14' } }), /YYYY-MM-DD/);
  assert.throws(() => validateEventConfig({ ...validConfig, dates: null }), /YYYY-MM-DD/);
});

test('validateEventConfig rejects end-before-start', () => {
  assert.throws(
    () => validateEventConfig({ ...validConfig, dates: { start: '2026-09-24', end: '2026-09-14' } }),
    /start must be ≤/
  );
});

test('validateEventConfig rejects empty / oversized tiers', () => {
  assert.throws(() => validateEventConfig({ ...validConfig, tiers_inr: [] }), /tiers_inr/);
  assert.throws(() => validateEventConfig({ ...validConfig, tiers_inr: [1, 2, 3, 4, 5, 6, 7] }), /tiers_inr/);
  assert.throws(() => validateEventConfig({ ...validConfig, tiers_inr: 'not-an-array' }), /tiers_inr/);
});

test('validateEventConfig rejects bad tier values', () => {
  for (const bad of [0, -1, 1_000_001, 1.5, '1001']) {
    assert.throws(() => validateEventConfig({ ...validConfig, tiers_inr: [bad] }), /each tier/);
  }
});

test('formatINR uses Indian grouping', () => {
  assert.equal(formatINR(1),        '₹1');
  assert.equal(formatINR(101),      '₹101');
  assert.equal(formatINR(1000),     '₹1,000');
  assert.equal(formatINR(10000),    '₹10,000');
  assert.equal(formatINR(100000),   '₹1,00,000');
  assert.equal(formatINR(250000),   '₹2,50,000');
  assert.equal(formatINR(2500000),  '₹25,00,000');
  assert.equal(formatINR(10000000), '₹1,00,00,000');
});

test('formatINR handles rounding and bad input', () => {
  assert.equal(formatINR(1000.4), '₹1,000');
  assert.equal(formatINR(1000.6), '₹1,001');
  assert.equal(formatINR(NaN),    '');
  assert.equal(formatINR('1000'), '');
  assert.equal(formatINR(null),   '');
});

test('formatDate produces human "14 Sept 2026" form', () => {
  assert.equal(formatDate('2026-09-14'), '14 Sept 2026');
  assert.equal(formatDate('2026-01-01'), '1 Jan 2026');
  assert.equal(formatDate('2026-12-31'), '31 Dec 2026');
});

test('formatDate rejects bad input', () => {
  for (const bad of ['', '2026/09/14', '2026-13-14', 'yesterday', null, 42]) {
    assert.equal(formatDate(bad), '');
  }
});

test('clusterClass maps A/B/C/D to tint tokens', () => {
  assert.equal(clusterClass('A'), 'is-terra');
  assert.equal(clusterClass('B'), 'is-sage');
  assert.equal(clusterClass('C'), 'is-gold');
  assert.equal(clusterClass('D'), 'is-ink');
  assert.equal(clusterClass('Z'), 'is-terra');   // safe fallback
  assert.equal(clusterClass(undefined), 'is-terra');
});
