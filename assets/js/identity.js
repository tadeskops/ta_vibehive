/* ta_vibehive · identity.js · client-side identity + role resolution (G0-04)
 *
 * On static Pages there is no server-side session. Identity is captured
 * client-side and travels with the contribution submission when the resident
 * hits Submit. The committee token (when present) grants COMMITTEE role;
 * absence means RESIDENT once a name is captured, or ANON otherwise.
 *
 * SECURITY BOUNDARY: This module is UX only. Every write must be re-checked
 * server-side (in the GitHub Action that opens the data-repo PR). Never trust
 * the browser to decide "am I committee".
 *
 * Storage keys (all under tvh.*):
 *   tvh.identity        = { name, flat, anonymous, savedAt } | null
 *   tvh.committee.token = <opaque GitHub App device-flow token> (set by G1-04)
 *   tvh.committee.exp   = <ms epoch when the token expires>
 */

import { ROLES } from './rbac.js';

const K_IDENTITY = 'tvh.identity';
const K_COMMITTEE_TOKEN = 'tvh.committee.token';
const K_COMMITTEE_EXP = 'tvh.committee.exp';

const FLAT_RE = /^([A-Za-z]-)?\d{1,4}$/;  // e.g. "A-101", "B-2003", "1401" (letter prefix requires dash)
const NAME_MAX = 80;

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, val) {
  try { if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val); return true; }
  catch { return false; }
}

/** Read the stored identity, or null if nothing saved. */
export function getIdentity() {
  const raw = safeRead(K_IDENTITY);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    if (typeof obj.name !== 'string' || typeof obj.flat !== 'string') return null;
    return {
      name: obj.name,
      flat: obj.flat,
      anonymous: !!obj.anonymous,
      savedAt: typeof obj.savedAt === 'number' ? obj.savedAt : Date.now(),
    };
  } catch { return null; }
}

/** Persist an identity. Validates name length + flat pattern. */
export function setIdentity({ name, flat, anonymous = false }) {
  if (typeof name !== 'string') throw new Error('identity: name required');
  const trimmedName = name.trim();
  if (trimmedName.length === 0) throw new Error('identity: name empty');
  if (trimmedName.length > NAME_MAX) throw new Error('identity: name too long');
  if (typeof flat !== 'string') throw new Error('identity: flat required');
  const trimmedFlat = flat.trim().toUpperCase();
  if (!FLAT_RE.test(trimmedFlat)) throw new Error('identity: flat format invalid');
  const payload = {
    name: trimmedName,
    flat: trimmedFlat,
    anonymous: !!anonymous,
    savedAt: Date.now(),
  };
  safeWrite(K_IDENTITY, JSON.stringify(payload));
  return payload;
}

/** Clear identity + committee token. Used by "sign out". */
export function clearIdentity() {
  safeWrite(K_IDENTITY, null);
  safeWrite(K_COMMITTEE_TOKEN, null);
  safeWrite(K_COMMITTEE_EXP, null);
}

/** Whether a non-expired committee token is present. */
export function hasCommitteeToken(now = Date.now()) {
  const tok = safeRead(K_COMMITTEE_TOKEN);
  if (!tok) return false;
  const exp = parseInt(safeRead(K_COMMITTEE_EXP) || '0', 10);
  if (!Number.isFinite(exp) || exp <= now) return false;
  return true;
}

/** Persist a committee token (G1-04 will call this after GitHub App device flow). */
export function setCommitteeToken(token, expiresAtMs) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('token required');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw new Error('exp in past');
  safeWrite(K_COMMITTEE_TOKEN, token);
  safeWrite(K_COMMITTEE_EXP, String(expiresAtMs));
}

/** Resolve the caller's role from stored state. */
export function currentRole(now = Date.now()) {
  if (hasCommitteeToken(now)) return ROLES.COMMITTEE;
  if (getIdentity()) return ROLES.RESIDENT;
  return ROLES.ANON;
}

export const _config = Object.freeze({ FLAT_RE, NAME_MAX, K_IDENTITY });
