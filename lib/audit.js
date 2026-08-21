// ta_vibehive · audit-log-lite (G0-03)
//
// Append-only, tamper-evident event log.
//
// Storage model (per tvh_architecture.md 8.3):
//   audit/<yyyy-mm>.json  is a JSON array of entries. Each entry:
//     {
//       "seq":  <number, monotonic within the month>,
//       "ts":   "<ISO-8601 UTC>",
//       "actor":  "resident:aarav-p" | "committee:priya-k" | "system",
//       "action": "contribution.submit" | "contribution.verify" | ...,
//       "target": "contribution:2026-ganpati:0001",
//       "meta":   { arbitrary sanitized payload },
//       "prev":   "<hex sha256 of previous entry's hash, or 64-zeros for seq=1>",
//       "hash":   "<hex sha256 of canonical(entry-without-hash) + prev>"
//     }
//
// Guarantees:
//   - Append-only: entries are only added at the end. The verifier checks
//     that seq is strictly monotonic and that hash chains back to the genesis.
//   - Tamper-evident: any change to any past entry breaks the chain from
//     that point forward. `verify()` returns the seq at which the break
//     happened, or 0 if the whole chain is intact.
//   - No secrets: this is a local helper. Server-side re-runs happen in
//     GitHub Actions with the same code.

import { createHash } from 'node:crypto';

const GENESIS_PREV = '0'.repeat(64);

/** Canonical JSON: keys sorted, no whitespace, arrays preserved in place. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Compute the hash of an entry given its prev. Ignores an existing hash field. */
export function computeHash(entry) {
  const { hash: _ignored, ...rest } = entry;
  return sha256Hex(canonicalize(rest));
}

/**
 * Append a new entry to the chain and return the full entry.
 * `chain` is an array of prior entries (may be empty).
 */
export function append(chain, { actor, action, target, meta = {}, ts, seq }) {
  if (!actor || typeof actor !== 'string') throw new Error('audit.append: actor required');
  if (!action || typeof action !== 'string') throw new Error('audit.append: action required');
  if (!target || typeof target !== 'string') throw new Error('audit.append: target required');

  const prev = chain.length === 0 ? GENESIS_PREV : chain[chain.length - 1].hash;
  const nextSeq = seq ?? (chain.length === 0 ? 1 : chain[chain.length - 1].seq + 1);
  const nextTs = ts ?? new Date().toISOString();

  const draft = {
    seq: nextSeq,
    ts: nextTs,
    actor,
    action,
    target,
    meta,
    prev,
  };
  const hash = computeHash(draft);
  return { ...draft, hash };
}

/**
 * Verify chain integrity.
 * Returns { ok: true } if intact, or { ok: false, brokenAt: <seq> } on first
 * mismatch. The chain is empty-valid.
 */
export function verify(chain) {
  let prev = GENESIS_PREV;
  let lastSeq = 0;
  for (const entry of chain) {
    if (typeof entry.seq !== 'number' || entry.seq !== lastSeq + 1) {
      return { ok: false, brokenAt: entry.seq ?? -1, reason: 'seq-not-monotonic' };
    }
    if (entry.prev !== prev) {
      return { ok: false, brokenAt: entry.seq, reason: 'prev-mismatch' };
    }
    const recomputed = computeHash(entry);
    if (recomputed !== entry.hash) {
      return { ok: false, brokenAt: entry.seq, reason: 'hash-mismatch' };
    }
    prev = entry.hash;
    lastSeq = entry.seq;
  }
  return { ok: true };
}

/** Tail hash — useful for public "chain fingerprint" display. */
export function tailHash(chain) {
  return chain.length === 0 ? GENESIS_PREV : chain[chain.length - 1].hash;
}

export const _internals = { GENESIS_PREV };
