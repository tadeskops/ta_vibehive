/* Event Operations Workspace — archive layer (Slice 4).
 *
 * Archiving is off by default (operations.archive flag). When on, admins
 * can take timestamped snapshots of the ops doc. Snapshots live in
 * localStorage so they are testable without the Worker; if we ever ship
 * a Worker route (POST /operations/archive) the same helper pushes there
 * with a best-effort attempt. A failed push does NOT block the local save.
 */
'use strict';
import { state } from './store.js';

const NS_ARCHIVE = 'tvh:v1:archive:';

function key(eventId) { return NS_ARCHIVE + eventId; }

/** Return the list of archived snapshots for an event, newest first.
 *  Each entry: { id, ts, actor_id, size_bytes, activity_count, person_count }.
 */
export function listArchives(eventId) {
  try {
    const raw = localStorage.getItem(key(eventId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice().sort((a, b) => (b.ts || '').localeCompare(a.ts || '')) : [];
  } catch (_) { return []; }
}

/** Return the full snapshot document (or null if not found). */
export function getArchive(eventId, snapshotId) {
  const list = listArchives(eventId);
  const meta = list.find(x => x.id === snapshotId);
  if (!meta) return null;
  return meta;
}

/** Push a snapshot of the ops doc.
 *  Returns { ok, id, ts } on success or { ok:false, error } on failure.
 *  Always writes locally; Worker push is best-effort and non-blocking.
 */
export async function archiveEvent(eventId, doc, actor) {
  if (!eventId || !doc) return { ok: false, error: 'missing eventId/doc' };
  const ts = new Date().toISOString();
  const id = 'snap-' + ts.replace(/[:.]/g, '').slice(0, 15);
  const snapshot = {
    id, ts,
    actor_id: actor && actor.id || null,
    actor_name: actor && actor.name || null,
    activity_count: (doc.activities || []).length,
    person_count: (doc.people || []).length,
    ownership_count: (doc.ownership || []).length,
    doc: JSON.parse(JSON.stringify(doc)),
  };
  snapshot.size_bytes = JSON.stringify(snapshot.doc).length;

  const list = listArchives(eventId);
  list.unshift(snapshot);
  // Keep only last 20 snapshots per event to bound storage.
  const trimmed = list.slice(0, 20);
  try {
    localStorage.setItem(key(eventId), JSON.stringify(trimmed));
  } catch (e) {
    return { ok: false, error: 'localStorage: ' + (e && e.message || e) };
  }
  state.audit({
    actor: actor ? actor.id : null,
    action: 'operations.archive.snapshot',
    event_id: eventId, snapshot_id: id, ts,
  });

  // Best-effort Worker push (not shipped yet). Silently ignore rejection.
  tryPushWorker(eventId, snapshot).catch(() => {});

  return { ok: true, id, ts, size_bytes: snapshot.size_bytes };
}

async function tryPushWorker(eventId, snapshot) {
  const base = (window.__TVH_WORKER_BASE || '').trim();
  if (!base) return;
  try {
    await fetch(base.replace(/\/$/, '') + '/operations/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, snapshot }),
      credentials: 'include',
      keepalive: true,
    });
  } catch (_) { /* silent */ }
}

export function deleteArchive(eventId, snapshotId, actor) {
  const list = listArchives(eventId).filter(x => x.id !== snapshotId);
  try {
    localStorage.setItem(key(eventId), JSON.stringify(list));
    state.audit({
      actor: actor ? actor.id : null,
      action: 'operations.archive.delete',
      event_id: eventId, snapshot_id: snapshotId,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message || String(e) };
  }
}
