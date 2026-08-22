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
   * hard-coded bootstrap admins (see lab-admin.js) are guaranteed to
   * exist as role="admin" no matter what any UI or migration does.
   *
   * On read we ALSO strip any leftover pre-production placeholder
   * users (emails ending in `.example`) so a browser that touched an
   * older dev build doesn't leak Aarav Jain / Ramesh Patil / etc.
   * into the live admin console. Newly-provisioned residents come in
   * via `auth.js/loginWithProfile` from a Google-signed JWT and never
   * have a `.example` email. */
  users() {
    const stored = local.get('users', null);
    const list = Array.isArray(stored)
      ? stored.filter(u => u && !/\.example$/i.test(String(u.email || '')))
      : [];
    return withLabAdmin(list);
  },
  saveUsers(u) {
    const cleaned = Array.isArray(u)
      ? u.filter(x => x && !/\.example$/i.test(String(x.email || '')))
      : [];
    local.set('users', withLabAdmin(cleaned));
  },
  events() { return local.get('events', []); },
  saveEvents(evts) { local.set('events', evts); },
  contribs() { return local.get('contribs', []); },
  saveContribs(c) { local.set('contribs', c); },
  /* Expenses — per-event outflows recorded by committee/manager. Each
   * row: { id, event_id, amount, category, description, receipt_url,
   * created_at, created_by, visible_to_residents }.  Aggregated in
   * reports.js + shown inline on the event detail page (respecting the
   * visibility flag). Not archived — kept local until the future
   * treasury integration lands. */
  expenses() { return local.get('expenses', []); },
  saveExpenses(list) { local.set('expenses', Array.isArray(list) ? list : []); },
  /* Receipt templates — society may keep multiple presets (e.g. one
   * for festival donations, one for maintenance dues) and pick which
   * one is active from settings. Only the active_id (stored in
   * societyOverrides.receipts.active_template_id) drives rendering;
   * inactive templates stay around for quick swap during a campaign.
   * Each template: { id, name, header_note, thank_you_line,
   * footer_note, show_qr, show_verify_grid, show_watermark,
   * seal_glyph, created_at }. */
  receiptTemplates() { return local.get('receiptTemplates', []); },
  saveReceiptTemplates(list) { local.set('receiptTemplates', Array.isArray(list) ? list : []); },
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
  /* Event moderator history. Each row is an immutable append-only fact
   * captured only when the event has history enabled and a moderator-
   * class role performs a tracked action. This keeps review surfaces
   * event-scoped and cheap to query. */
  eventHistory() { return local.get('eventHistory', []); },
  saveEventHistory(list) { local.set('eventHistory', Array.isArray(list) ? list : []); },
  addEventHistory(entry) {
    const list = local.get('eventHistory', []);
    list.push({ ...entry, ts: new Date().toISOString() });
    local.set('eventHistory', list.slice(-2000));
    return list.length;
  },
  /* Draft cache for contribute forms so refresh/navigation does not
   * wipe in-progress payment refs / notes / proof choices. */
  contribDrafts() { return local.get('contribDrafts', {}); },
  contribDraft(eventId) {
    const all = local.get('contribDrafts', {});
    return all && eventId ? (all[eventId] || null) : null;
  },
  saveContribDraft(eventId, draft) {
    if (!eventId) return;
    const all = local.get('contribDrafts', {});
    all[eventId] = draft;
    local.set('contribDrafts', all);
  },
  clearContribDraft(eventId) {
    if (!eventId) return;
    const all = local.get('contribDrafts', {});
    delete all[eventId];
    local.set('contribDrafts', all);
  },
  currentUser() {
    const raw = local.get('session', null);
    /* Drop any stale demo-persona session left over from a pre-production
     * dev build (fake emails end in `.example`). Forces the sign-in gate
     * for the affected browser instead of silently keeping "Aarav Jain"
     * signed in against a live deploy. */
    if (raw && /\.example$/i.test(String(raw.email || ''))) {
      local.remove('session');
      return null;
    }
    return normalizeUser(raw);
  },
  setCurrentUser(u) { u ? local.set('session', normalizeUser(u)) : local.remove('session'); },
  audit(entry) {
    const log = local.get('audit', []);
    log.push({ ...entry, ts: new Date().toISOString() });
    // Tamper-evident: chain hashes so entries can be sealed later.
    local.set('audit', log.slice(-500));
  },
  auditLog() { return local.get('audit', []); },
  /* Site-bug reports captured by `assets/js/footer.js` on every Send
   * — persisted locally so admins can review + export them even when
   * the reporter closed the GitHub tab without submitting. Screenshot
   * blobs are NOT stored here; only their filenames + count. Keyed
   * under `bug_reports` in the same namespaced localStorage as every
   * other collection. The footer script writes this key directly (it
   * is a plain non-module script — see the "Backend note" in
   * footer.js for the rationale) so the shape MUST stay stable. */
  bugReports() {
    const raw = local.get('bug_reports', []);
    return Array.isArray(raw) ? raw : [];
  },
  saveBugReports(list) { local.set('bug_reports', Array.isArray(list) ? list : []); },
  clearBugReports() { local.remove('bug_reports'); },
  reset() { local.keys().forEach(k => local.remove(k)); },
};

function seedUsers() {
  /* Production seed = empty. The bootstrap admins from lab-admin.js are
   * always injected on top by `withLabAdmin(...)`. Real residents get
   * auto-provisioned by `auth.js/loginWithProfile` when they first tap
   * "Continue with Google". */
  return [];
}
