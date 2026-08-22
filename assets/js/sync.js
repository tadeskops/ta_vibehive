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
import { listEvents, whoami } from './api.js';
import { state } from './store.js';

let _running = false;

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
      try { window.dispatchEvent(new HashChangeEvent('hashchange')); } catch (_e) { /* older browsers */ }
    }
  } catch (e) {
    /* Log-only. Never block the app on sync failures. */
    // eslint-disable-next-line no-console
    console.warn('[sync] worker fetch failed — using local cache', e && e.message ? e.message : e);
  } finally {
    _running = false;
  }
}
