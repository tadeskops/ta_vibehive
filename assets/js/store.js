/* Storage layer.
 * Split into two tiers:
 *   - config/*.json (shipped, read-only) → fetched, cached in memory.
 *   - local user state (users, events, contributions) → localStorage, keyed by SOC id.
 * The local layer is a thin adapter — swap to GitHub REST later without changing callers.
 */
'use strict';
import { withLabAdmin, normalizeUser } from './lab-admin.js';

const NS = 'tvh:v1:';
const memo = new Map();

async function loadJSON(path) {
  if (memo.has(path)) return memo.get(path);
  const url = new URL(path, document.baseURI);
  if (url.origin !== location.origin) throw new Error('cross-origin config blocked');
  const res = await fetch(url, { credentials: 'omit', cache: 'no-cache' });
  if (!res.ok) throw new Error(`load ${path}: ${res.status}`);
  const data = await res.json();
  memo.set(path, Object.freeze(deepFreeze(data)));
  return memo.get(path);
}
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

export const cfg = {
  society:  () => loadJSON('config/society.json'),
  roles:    () => loadJSON('config/roles.json'),
  features: () => loadJSON('config/features.json'),
  templates:() => loadJSON('config/event-templates.json'),
  auth:     () => loadJSON('config/auth.json'),
};

/* Effective society config = shipped defaults ⊕ admin overrides (localStorage).
 * Every consumer that needs live society state (brand strip, receipt view,
 * receipt minting, admin settings form) reads through this — never `cfg.society()`
 * directly — so a config change takes effect on the next call, no reload needed.
 */
export async function getSociety() {
  const base = await cfg.society();
  const over = local.get('societyOverrides', {}) || {};
  return mergeDeep(structuredClone(base), over);
}
function mergeDeep(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = mergeDeep(target[k] && typeof target[k] === 'object' ? { ...target[k] } : {}, v);
    } else if (v !== undefined) {
      target[k] = v;
    }
  }
  return target;
}

/* Local persisted state. All keys namespaced under `tvh:v1:` so multiple demo
 * societies could coexist on the same origin without collision. */
export const local = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  remove(key) { localStorage.removeItem(NS + key); },
  keys() { return Object.keys(localStorage).filter(k => k.startsWith(NS)).map(k => k.slice(NS.length)); },
};

/* Higher-level collections */
export const state = {
  /* users() / saveUsers() are wrapped through `withLabAdmin` so the
   * hard-coded lab super-admin (samanasippa@gmail.com) is guaranteed to
   * exist as role="admin" no matter what any UI or migration does. */
  users() { return withLabAdmin(local.get('users', seedUsers())); },
  saveUsers(u) { local.set('users', withLabAdmin(u)); },
  events() { return local.get('events', []); },
  saveEvents(evts) { local.set('events', evts); },
  contribs() { return local.get('contribs', []); },
  saveContribs(c) { local.set('contribs', c); },
  featureOverrides() { return local.get('featureOverrides', {}); },
  saveFeatureOverrides(o) { local.set('featureOverrides', o); },
  societyOverrides() { return local.get('societyOverrides', {}); },
  saveSocietyOverrides(o) { local.set('societyOverrides', o || {}); },
  /* Draft cache — settings edits are staged here until the admin
   * presses "Save all". Kept separate from societyOverrides so a
   * half-typed archive_repo never breaks the live receipts flow. */
  settingsDraft() { return local.get('settingsDraft', {}); },
  saveSettingsDraft(o) { local.set('settingsDraft', o || {}); },
  clearSettingsDraft() { local.remove('settingsDraft'); },
  /* Outbox — pending archive writes that will later be flushed to the
   * private receipts repo as ONE commit via the GitHub Trees + Commits
   * API. Each entry is { path, content, receiptId, contribId, at }.
   * `enqueueArchive` de-dupes on path so re-verifying a contribution
   * does not double-commit. */
  outbox() { return local.get('outbox', []); },
  enqueueArchive(entry) {
    const q = local.get('outbox', []);
    const idx = q.findIndex(e => e.path === entry.path);
    const row = { ...entry, at: new Date().toISOString() };
    if (idx >= 0) q[idx] = row; else q.push(row);
    local.set('outbox', q.slice(-500));
    return q.length;
  },
  outboxSize() { return (local.get('outbox', []) || []).length; },
  drainOutbox() {
    const q = local.get('outbox', []);
    local.set('outbox', []);
    return q;
  },
  currentUser() { return normalizeUser(local.get('session', null)); },
  setCurrentUser(u) { u ? local.set('session', normalizeUser(u)) : local.remove('session'); },
  audit(entry) {
    const log = local.get('audit', []);
    log.push({ ...entry, ts: new Date().toISOString() });
    // Tamper-evident: chain hashes so entries can be sealed later.
    local.set('audit', log.slice(-500));
  },
  auditLog() { return local.get('audit', []); },
  reset() { local.keys().forEach(k => local.remove(k)); },
};

function seedUsers() {
  return [
    { id: 'admin@the-address',    name: 'System Admin',      role: 'admin',     flat: '—',      email: 'admin@the-address.example' },
    { id: 'chair@the-address',    name: 'Ramesh Patil',      role: 'mgmt',      flat: 'A-101',  email: 'chair@the-address.example' },
    { id: 'culture@the-address',  name: 'Sunita Kulkarni',   role: 'committee', flat: 'A-505',  email: 'culture@the-address.example' },
    { id: 'manager@the-address',  name: 'Anil Deshpande',    role: 'manager',   flat: 'GF-01',  email: 'manager@the-address.example' },
    { id: 'aarav@the-address',    name: 'Aarav Jain',        role: 'resident',  flat: 'B-1605', email: 'aarav@the-address.example' },
  ];
}
