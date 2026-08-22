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
import { listEvents, listContributions, whoami, readSettings } from './api.js';
import { state } from './store.js';

let _running = false;

/** Local-only fields that must survive when merging with the server's
 *  authoritative record (e.g. proof attachments live only in the
 *  browser that submitted the contribution). */
function pickLocalOnly(rec) {
  const out = {};
  if (rec.proof_data_url) out.proof_data_url = rec.proof_data_url;
  if (rec.proof_name) out.proof_name = rec.proof_name;
  if (rec.proof_size) out.proof_size = rec.proof_size;
  if (rec._archive_path) out._archive_path = rec._archive_path;
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
      state.saveEvents(events);
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
          const merged = { ...(byId.get(l.id) || {}), ...pickLocalOnly(l) };
          byId.set(l.id, merged);
        }
        state.saveContribs(Array.from(byId.values()));
      }
    } catch (_e) { /* auth / network — fall back to local cache */ }

    try { window.dispatchEvent(new HashChangeEvent('hashchange')); } catch (_e) { /* older browsers */ }
  } catch (e) {
    /* Log-only. Never block the app on sync failures. */
    // eslint-disable-next-line no-console
    console.warn('[sync] worker fetch failed — using local cache', e && e.message ? e.message : e);
  } finally {
    _running = false;
    _lastRunAt = Date.now();
  }
}

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
function _throttledSync(reason) {
  if (typeof document === 'undefined') return;
  if (document.hidden) return;                     /* skip while tab in background */
  if (Date.now() - _lastRunAt < MIN_GAP_MS) return; /* respect the min-gap window   */
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
