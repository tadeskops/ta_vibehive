/* ta_vibehive · ratelimit.js · client-side rate limit (G0-04)
 *
 * Fixed-window counter per bucket keyed by hour. Purely a UX guard to keep the
 * user from hammering an Action that would fail on GitHub's own rate limits.
 * Not a security control (an attacker can clear localStorage). Server-side
 * throttling in G1-04 is the real defense.
 *
 * Storage: tvh.rl.<bucket> = "<hourEpoch>:<count>"
 */

const KEY_PREFIX = 'tvh.rl.';

function keyFor(bucket) { return KEY_PREFIX + bucket; }

function currentHour(now) { return Math.floor(now / 3_600_000); }

function readWindow(bucket, now) {
  const raw = safeGet(keyFor(bucket));
  if (!raw) return { hour: currentHour(now), count: 0 };
  const [h, c] = raw.split(':');
  const hour = parseInt(h, 10);
  const count = parseInt(c, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(count)) return { hour: currentHour(now), count: 0 };
  return { hour, count };
}

function writeWindow(bucket, hour, count) {
  safeSet(keyFor(bucket), hour + ':' + count);
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* no-op */ } }
function safeDel(k) { try { localStorage.removeItem(k); } catch { /* no-op */ } }

/**
 * Attempt to consume one slot in the bucket for the current hour.
 * Returns { ok: true, remaining } on success or { ok: false, resetInSec } if
 * the cap has been hit for this hour.
 */
export function checkRate(bucket, maxPerHour, now = Date.now()) {
  if (typeof bucket !== 'string' || bucket.length === 0) throw new Error('bucket required');
  if (!Number.isInteger(maxPerHour) || maxPerHour <= 0) throw new Error('maxPerHour must be positive int');

  const nowHour = currentHour(now);
  const w = readWindow(bucket, now);
  if (w.hour !== nowHour) {
    writeWindow(bucket, nowHour, 1);
    return { ok: true, remaining: maxPerHour - 1 };
  }
  if (w.count >= maxPerHour) {
    const resetAtMs = (nowHour + 1) * 3_600_000;
    return { ok: false, remaining: 0, resetInSec: Math.ceil((resetAtMs - now) / 1000) };
  }
  const next = w.count + 1;
  writeWindow(bucket, nowHour, next);
  return { ok: true, remaining: maxPerHour - next };
}

/** Reset a single bucket (test + admin path). */
export function resetBucket(bucket) {
  if (typeof bucket !== 'string') throw new Error('bucket required');
  safeDel(keyFor(bucket));
}

/** Read the current count without consuming a slot. */
export function peekRate(bucket, now = Date.now()) {
  const w = readWindow(bucket, now);
  return w.hour === currentHour(now) ? w.count : 0;
}
