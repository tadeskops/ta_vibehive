/* Boot-time sync from the Worker.
 *
 * Purpose: the frontend historically only reads from `localStorage`.
 * This module hydrates that cache from the archive repo (via the
 * Worker) so any resident opening the app sees the events an admin
 * created on a different device.
 *
 * Strategy (Slice 2 — minimal, non-invasive):
 *  - On app boot, fetch `/events` from the Worker (no auth needed for
 *    published events).
 *  - Overwrite `tvh:v1:events` in localStorage.
 *  - Fire a `hashchange` so the current view re-renders.
 *
 * Kept intentionally small. Future slices will migrate views to read
 * from the Worker directly, phasing out the localStorage business-data
 * cache entirely. Until then this is the seam that makes multi-device
 * viewing work.
 */
'use strict';
import { listEvents, listContributions, listExpenses, whoami, readSettings } from './api.js';
import { state } from './store.js';
import { applyRecoveryOverridesToState } from './events.js';

let _running = false;

// True when the user is on an editing surface OR has focus in a form
// input. Used to skip destructive background hydration + re-render so
// in-progress input (event title, contribute form, settings draft) is
// not silently wiped on the next 60 s tick or tab refocus.
function isUserEditing() {
  try {
    const hash = String(location.hash || '');
    if (/\/(edit|manage|contribute|register|settings|admin|receipt)(\/|$|\?)/i.test(hash)) return true;
    const active = document.activeElement;
    if (active) {
      const tag = String(active.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      if (active.isContentEditable) return true;
    }
    // Any form that has taken focus at some point AND has a value delta.
    // Cheap heuristic — presence of an open <details data-tvh-editing> or
    // an element flagged data-tvh-dirty by a view.
    if (document.querySelector('[data-tvh-dirty="1"], [data-tvh-editing="1"]')) return true;
    return false;
  } catch (_e) { return false; }
}

/** Local-only fields that must survive when merging with the server's
 *  authoritative record (e.g. proof attachments live only in the
 *  browser that submitted the contribution). */
function pickLocalOnly(rec) {
  const out = {};
  if (rec.proof_data_url) out.proof_data_url = rec.proof_data_url;
  if (rec.proof_name) out.proof_name = rec.proof_name;
  if (rec.proof_size) out.proof_size = rec.proof_size;
  if (rec._archive_path) out._archive_path = rec._archive_path;
  // Data-recovery migration markers — keep the locally-remapped event id
  // so background sync never re-links a migrated contribution to its
  // former (orphaned/hidden) event.
  if (rec.migrated_at) {
    if (rec.event) out.event = rec.event;
    if (rec.migrated_from) out.migrated_from = rec.migrated_from;
    out.migrated_at = rec.migrated_at;
  }
  return out;
}

/** Fetch events + identity from the Worker, hydrate localStorage cache,
 *  and trigger a re-render. Silent on network / auth failures — the
 *  local cache remains as a fallback. */
export async function syncFromWorker() {
  if (_running) return;
  _running = true;
  try {
    /* Hydrate identity when signed in — the Worker resolves role from
     * `config/access.json` so the local session's role reflects the
     * source of truth. */
    try {
      const me = await whoami();
      if (me && me.email) {
        const current = state.currentUser();
        if (current && String(current.email || '').toLowerCase() === String(me.email).toLowerCase()) {
          if (current.role !== me.role) {
            state.setCurrentUser({ ...current, role: me.role });
          }
        }
      }
    } catch (_e) { /* swallow — auth errors are handled by GIS layer */ }

    /* Hydrate events cache. */
    const events = await listEvents();
    if (Array.isArray(events)) {
      // Skip events an admin has permanently purged locally so a stale
      // archive copy can't zombie-back into the UI.
      const purged = new Set(state.purgedEvents());
      const withoutPurged = events.filter(e => !(e && purged.has(e.id)));
      // Preserve events flagged _recovery_pending (writeEvent push failed) so
      // background sync doesn't overwrite the local status change.
      const localPending = new Map();
      for (const e of state.events() || []) {
        if (e && e._recovery_pending) localPending.set(e.id, e);
      }
      const merged = withoutPurged.map(e => {
        const local = e && localPending.get(e.id);
        if (!local) return e;
        localPending.delete(e.id);
        return { ...e, status: local.status, updated_at: local.updated_at, _recovery_pending: true };
      });
      // Append any pending events that the server hasn't seen yet.
      for (const e of localPending.values()) merged.push(e);
      state.saveEvents(merged);
    }

    /* Hydrate society-overrides cache — the Worker holds the
     * authoritative role-mapping / attributes doc. Without this,
     * saving from a fresh browser (empty local overrides) would
     * silently clobber server-side edits made from another device
     * (real bug seen 2026-08-22: role emails vanished after
     * sign-out + clear-history + sign-in). Requires an authenticated
     * caller; anonymous callers get 401 and we keep local cache. */
    try {
      const settings = await readSettings();
      if (settings && settings.overrides && typeof settings.overrides === 'object') {
        state.saveSocietyOverrides(settings.overrides);
      }
    } catch (_e) { /* anonymous / offline — keep local cache */ }

    /* Hydrate contributions cache — only meaningful when signed in
     * (Worker returns 401 for anonymous). Merges server records with
     * any locally cached extras (proof attachments live only in the
     * browser). Dedupe by id. */
    try {
      const remote = await listContributions();
      if (Array.isArray(remote) && remote.length) {
        const local = state.contribs() || [];
        const byId = new Map();
        for (const r of remote) if (r && r.id) byId.set(r.id, { ...r });
        for (const l of local) if (l && l.id) {
          // Fall back to the full local record when the server response
          // does not include this id in the current window — the old
          // `|| {}` reduced the record to just proof fields.
          const merged = { ...(byId.get(l.id) || l), ...pickLocalOnly(l) };
          byId.set(l.id, merged);
        }
        state.saveContribs(Array.from(byId.values()));
      }
    } catch (_e) { /* auth / network — fall back to local cache */ }

    /* Hydrate expenses cache — mirror of the contributions merge so
     * a committee member on device B sees pending expenses that
     * resident A submitted on device A. Locally-cached proofs
     * (data URLs) are preserved because the server never sees them. */
    try {
      const remote = await listExpenses();
      if (Array.isArray(remote)) {
        const local = state.expenses() || [];
        const byId = new Map();
        for (const r of remote) if (r && r.id) byId.set(r.id, { ...r });
        for (const l of local) if (l && l.id) {
          const prior = byId.get(l.id) || {};
          // Preserve locally-attached blobs + optimistic-only rows.
          const preserved = {
            proof_data_url: l.proof_data_url,
            proof_name: l.proof_name,
            proof_size: l.proof_size,
          };
          if (!byId.has(l.id) && !l._path) {
            // Optimistic local-only row; POST may still be in-flight.
            byId.set(l.id, l);
          } else {
            byId.set(l.id, { ...prior, ...preserved });
          }
        }
        state.saveExpenses(Array.from(byId.values()));
      }
    } catch (_e) { /* auth / network — fall back to local cache */ }

    // Apply shared recovery overrides (admin-authored) so migrations
    // and restored statuses survive every server refresh on every device.
    try { applyRecoveryOverridesToState(); } catch (_e) { /* never block sync */ }

    // Skip the re-render dispatch while the user is actively editing so
    // in-progress form input (event title, contribute amount, etc.) is
    // not wiped by the router re-mounting the view.
    if (!isUserEditing()) {
      try { window.dispatchEvent(new HashChangeEvent('hashchange')); } catch (_e) { /* older browsers */ }
    }
  } catch (e) {
    /* Log-only. Never block the app on sync failures. */
    // eslint-disable-next-line no-console
    console.warn('[sync] worker fetch failed — using local cache', e && e.message ? e.message : e);
  } finally {
    _running = false;
    _lastRunAt = Date.now();
    _lastSuccessAt = Date.now();
  }
}

// Exposed for UI freshness indicators (see manage.js Refresh chip).
export function lastSyncAt() { return _lastSuccessAt; }

/* --- Auto-refresh choreography ---------------------------------
 *
 * Two lightweight signals drive background refresh so the UI feels
 * "live" without any polling storm:
 *
 *   1. `visibilitychange` fires whenever the tab is refocused. We
 *      trigger a sync so a user coming back after a while sees the
 *      committee's latest verify / new contribution instantly.
 *   2. `setInterval` runs every AUTO_REFRESH_MS while the tab is
 *      visible. The throttle guarantees we never fire more than once
 *      per MIN_GAP_MS window even if multiple triggers coincide.
 *
 * Every fetch also drives the topbar golden shimmer via
 * `installFetchWrapper` (already wired in app.js), so users get a
 * subtle glow-progress cue during background updates without a
 * dedicated spinner. */
const AUTO_REFRESH_MS = 60_000;
const MIN_GAP_MS      = 20_000;
let   _lastRunAt      = 0;
let   _lastSuccessAt  = 0;
function _throttledSync(reason) {
  if (typeof document === 'undefined') return;
  if (document.hidden) return;                     /* skip while tab in background */
  if (Date.now() - _lastRunAt < MIN_GAP_MS) return; /* respect the min-gap window   */
  if (isUserEditing()) return;                     /* never overwrite in-progress edits */
  syncFromWorker().catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[sync/${reason}] failed`, e && e.message ? e.message : e);
  });
}
export function installAutoRefresh() {
  if (typeof window === 'undefined') return;
  if (installAutoRefresh._wired) return;
  installAutoRefresh._wired = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _throttledSync('visibility');
  });
  setInterval(() => _throttledSync('interval'), AUTO_REFRESH_MS);
}
