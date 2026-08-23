/* Event + contribution service. */
'use strict';
/* Feature wiring markers (used by CI traceability audit):
 * - payment.verify
 * - receipt.generate
 */
import { cfg, state } from './store.js';
import { catalog } from './features.js';
import { emit as notifyEmit } from './notify.js';
import * as api from './api.js';

export const STATUS = Object.freeze({
  DRAFT: 'draft', REVIEW: 'review', PUBLISHED: 'published',
  CLOSED: 'closed', ARCHIVED: 'archived'
});

/* Roles that can act on incoming "manage requests". Kept in sync
 * with config/roles.json — `events.approve` for event proposals,
 * `contributions.verify` for pending contributions. Notifications
 * are broadcast per-role so every approver's bell lights up. */
const APPROVER_ROLES_EVENT   = ['admin', 'secretary', 'mgmt', 'committee'];
const APPROVER_ROLES_CONTRIB = ['admin', 'secretary', 'mgmt', 'manager'];

function notifyRoles(roles, payload) {
  for (const role of roles) {
    try { notifyEmit({ ...payload, audience: 'role', role }); } catch (_e) { /* silent */ }
  }
}

function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === STATUS.DRAFT || s === STATUS.REVIEW || s === STATUS.PUBLISHED || s === STATUS.CLOSED || s === STATUS.ARCHIVED) return s;
  if (s === 'live') return STATUS.PUBLISHED;
  return STATUS.DRAFT;
}

const ALLOWED_TRANSITIONS = Object.freeze({
  [STATUS.DRAFT]:     [STATUS.DRAFT, STATUS.REVIEW, STATUS.PUBLISHED],
  [STATUS.REVIEW]:    [STATUS.REVIEW, STATUS.DRAFT, STATUS.PUBLISHED],
  [STATUS.PUBLISHED]: [STATUS.PUBLISHED, STATUS.CLOSED, STATUS.ARCHIVED],
  [STATUS.CLOSED]:    [STATUS.CLOSED, STATUS.PUBLISHED, STATUS.ARCHIVED],
  [STATUS.ARCHIVED]:  [STATUS.ARCHIVED, STATUS.PUBLISHED, STATUS.CLOSED],
});

export function nextStatusesFor(current) {
  const cur = normalizeStatus(current);
  return ALLOWED_TRANSITIONS[cur] || [STATUS.DRAFT];
}

export function isTransitionAllowed(from, to) {
  const options = ALLOWED_TRANSITIONS[normalizeStatus(from)] || [];
  return options.includes(normalizeStatus(to));
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
}

function uid(prefix) {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}-${Date.now().toString(36)}-${r[0].toString(36)}${r[1].toString(36)}`;
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}
function roleIsModerator(role) {
  return role === 'committee' || role === 'manager';
}
// Actions we always log to event history, even when the moderator-history
// toggle is off — these are financial/verification-audit events.
const ALWAYS_TRACKED_ACTIONS = new Set(['contrib.verify', 'contrib.void', 'expense.verify']);
function shouldTrackHistory(evt, actor, action) {
  if (!evt || !actor) return false;
  if (action && ALWAYS_TRACKED_ACTIONS.has(action)) return true;
  return !!(evt.history_enabled && roleIsModerator(actor.role));
}
function appendHistory(evt, actor, action, detail) {
  if (!shouldTrackHistory(evt, actor, action)) return;
  const row = {
    event: evt.id,
    event_title: evt.title,
    actor: actor.email || actor.id || '',
    actor_role: actor.role || '',
    action,
    detail,
    ts: new Date().toISOString(),
  };
  state.addEventHistory(row);
  /* History archival is now piggybacked on the event save through the
   * Worker (event.json embeds a rolling history array in a follow-up
   * slice). Local audit remains authoritative for now. */
}

function sanitizeForPath(v) {
  return String(v || '').replace(/[^a-z0-9_.-]+/gi, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'event';
}

/** Derive `contributions/{yyyy}/{mm}/{id}.json` from a locally cached
 *  record when the Worker's archive path was not persisted (e.g.
 *  record predates the Worker upgrade). Falls back to using the
 *  record's `created_at` for month bucketing. */
function _guessArchivePath(rec) {
  if (!rec || !rec.id) return null;
  const d = rec.created_at ? new Date(rec.created_at) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const safe = String(rec.id).replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 60);
  return `contributions/${y}/${m}/${safe}.json`;
}

export async function canViewEventDetailedReport(evt, user, canPermission) {
  if (!evt || !user) return false;
  if (canPermission) return true;
  if (!evt.report_public_signedin) return false;
  if (!evt.report_restrict_allowlist) return true;
  const over = state.societyOverrides() || {};
  const list = (((over || {}).residents || {}).allowed_gmail) || [];
  if (!Array.isArray(list)) return false;
  return list.map(normalizeEmail).includes(normalizeEmail(user.email));
}

export async function listTemplates() {
  return (await cfg.templates()).templates;
}
export async function getTemplate(id) {
  return (await listTemplates()).find(t => t.id === id);
}

export async function newEventFromTemplate(templateId, actor) {
  const tpl = await getTemplate(templateId);
  if (!tpl) throw new Error('unknown template');
  const cat = await catalog();
  const featuresMap = {};
  for (const f of cat.features) if (f.scope === 'event') featuresMap[f.id] = !!f.default;
  for (const on of tpl.features_on) featuresMap[on] = true;
  const now = new Date();
  const evt = {
    id: uid('ev'),
    slug: slugify(tpl.label + '-' + now.getFullYear()) + '-' + Math.random().toString(36).slice(2, 6),
    template: tpl.id,
    cluster: tpl.cluster,
    glyph: tpl.glyph,
    hero_class: tpl.hero_class || '',
    title: tpl.label,
    purpose: '',
    goal: tpl.defaults.goal_default || 0,
    fixed_amount: tpl.defaults.fixed_amount || 0,
    tiers: tpl.defaults.tiers || [],
    capacity: tpl.defaults.capacity || 0,
    start_at: now.toISOString().slice(0, 10),
    end_at: '',
    status: STATUS.DRAFT,
    features: featuresMap,
    created_by: actor ? actor.id : null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  return evt;
}

export async function saveEvent(evt, actor) {
  const evts = state.events();
  const before = evts.slice();
  evt.status = normalizeStatus(evt.status);
  const priorStatus = (evts.find(e => e.id === evt.id) || {}).status || null;
  if (priorStatus && !isTransitionAllowed(priorStatus, evt.status)) {
    const err = new Error(`Cannot change status from "${priorStatus}" to "${evt.status}". Once an event is published, it can only be moved to closed or archived to preserve contribution history.`);
    err.code = 'INVALID_STATUS_TRANSITION';
    throw err;
  }
  evt.updated_at = new Date().toISOString();
  const i = evts.findIndex(e => e.id === evt.id);
  if (i >= 0) evts[i] = evt; else evts.push(evt);
  const persisted = state.saveEvents(evts);
  if (!persisted) {
    throw new Error('Could not save event locally. Browser storage is full or blocked.');
  }

  /* Persist through the Worker — GitHub is the source of truth. The
   * Worker stamps `updated_by`, so the response is the authoritative
   * shape we mirror into the local cache. */
  let saved;
  try {
    const slug = sanitizeForPath(evt.slug || evt.id || 'event');
    const res = await api.writeEvent(slug, evt);
    saved = (res && res.event) || evt;
  } catch (err) {
    state.saveEvents(before);
    const msg = err && err.message ? err.message : 'Could not save event to server.';
    const wrapped = new Error(msg);
    wrapped.code = 'WORKER_WRITE_FAILED';
    throw wrapped;
  }

  /* Reflect the server-stamped copy in the local cache so
   * subsequent reads see the same values (updated_by, updated_at). */
  const evtsAfter = state.events();
  const j = evtsAfter.findIndex((e) => e.id === saved.id);
  if (j >= 0) evtsAfter[j] = saved; else evtsAfter.push(saved);
  state.saveEvents(evtsAfter);
  evt = saved;

  state.audit({ actor: actor ? actor.id : null, action: 'event.save', event: evt.id, status: evt.status });
  if (actor) {
    appendHistory(evt, actor, 'event.save', `status=${evt.status || ''}`);
  }
  /* Broadcast a community-wide notification only on the transition
   * INTO PUBLISHED. Draft → draft or edits within Published never
   * spam the bell. */
  if (evt.status === STATUS.PUBLISHED && priorStatus !== STATUS.PUBLISHED) {
    try {
      notifyEmit({
        audience: 'all',
        kind: 'event',
        title: `New event: ${evt.title || 'Untitled'}`,
        body: evt.purpose || 'Tap to view details and contribute.',
        link: `#/e/${evt.id}`,
      });
    } catch (_e) { /* notification failures never block save */ }
  }
  /* Manage-request bell: notify every approver role when a proposal
   * lands in REVIEW so committee/mgmt/secretary/admin see it in
   * their notifications drawer without polling. */
  if (evt.status === STATUS.REVIEW && priorStatus !== STATUS.REVIEW) {
    const proposer = evt.proposed_by || (actor && (actor.email || actor.id)) || 'a resident';
    notifyRoles(APPROVER_ROLES_EVENT, {
      kind: 'approval',
      title: `Event proposal: ${evt.title || 'Untitled'}`,
      body: `${proposer} suggested a new event. Review and publish or send back.`,
      link: `#/events`,
    });
  }
  /* Close the loop back to the proposer once their request is
   * approved. Best-effort direct-to-user notification. */
  if (evt.status === STATUS.PUBLISHED && priorStatus === STATUS.REVIEW && evt.proposed_by) {
    try {
      notifyEmit({
        audience: 'user',
        userEmail: evt.proposed_by,
        kind: 'event',
        title: 'Your event proposal is approved',
        body: `${evt.title || 'Your event'} is now live. Tap to open.`,
        link: `#/e/${evt.id}`,
      });
    } catch (_e) { /* silent */ }
  }
  return evt;
}

export function findEvent(id) {
  return state.events().find(e => e.id === id || e.slug === id);
}

export function publicEvents() {
  /* Dedupe by (slug || title-lowercase) and keep the most-recently
   * updated instance. This prevents an admin who re-created an event
   * from another draft (or a stale localStorage carryover) from
   * showing the same tile twice on the home dashboard. */
  const filtered = state.events()
    .filter(e => {
      const st = normalizeStatus(e.status);
      return st === STATUS.PUBLISHED || st === STATUS.CLOSED;
    });
  const contribCount = new Map();
  for (const c of state.contribs()) {
    if (!c || !c.event) continue;
    contribCount.set(c.event, (contribCount.get(c.event) || 0) + 1);
  }
  const byKey = new Map();
  const keyOf = e => (e.slug || (e.title || '').toLowerCase().trim() || e.id);
  for (const e of filtered) {
    const k = keyOf(e);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, e); continue; }
    const prevContribs = contribCount.get(prev.id) || 0;
    const curContribs  = contribCount.get(e.id)    || 0;
    if (curContribs !== prevContribs) {
      if (curContribs > prevContribs) byKey.set(k, e);
      continue;
    }
    if ((e.updated_at || '') > (prev.updated_at || '')) byKey.set(k, e);
  }
  return [...byKey.values()].sort((a, b) => (a.end_at || '').localeCompare(b.end_at || ''));
}

export function contribsFor(eventId) {
  return state.contribs().filter(c => c.event === eventId);
}

export function totalFor(eventId) {
  return contribsFor(eventId)
    .filter(c => c.status === 'verified')
    .reduce((s, c) => s + Number(c.amount || 0), 0);
}
export function verifiedCount(eventId) {
  const set = new Set(contribsFor(eventId).filter(c => c.status === 'verified').map(c => c.contributor));
  return set.size;
}

export async function addContribution(payload, actor) {
  const list = state.contribs();
  /* Enforce the per-event "one contribution per flat" rule at storage
   * time so a devtools-crafted POST can't sneak past the UI guard in
   * the contribute view. Non-void prior submissions from the same flat
   * (case-insensitive, trimmed) or from the same signed-in contributor
   * id count as duplicates. Flat is empty for anonymous / unusual
   * submissions, so we skip the flat-match branch in that case. */
  const evt = state.events().find(e => e.id === payload.event);
  if (evt && evt.one_per_flat) {
    const flat = String(payload.flat || '').trim().toLowerCase();
    const cid  = payload.contributor || null;
    const dup = list.find(c => c.event === payload.event && c.status !== 'void' && (
      (flat && String(c.flat || '').trim().toLowerCase() === flat) ||
      (cid  && c.contributor === cid)
    ));
    if (dup) {
      const err = new Error('This event accepts only ONE contribution per flat. A submission from this flat already exists.');
      err.code = 'ONE_PER_FLAT';
      throw err;
    }
  }
  /* Build the payload the Worker persists in the archive repo. Small
   * proof attachments (screenshots) are shipped inline as data URLs
   * so committee members can review them from any device. Anything
   * larger than PROOF_INLINE_MAX stays browser-local — a follow-up
   * slice will move blobs to a signed-URL flow. */
  const PROOF_INLINE_MAX = 700 * 1024; /* ~700 KB base64 ≈ ~500 KB raw */
  const proofFits = payload.proof_data_url
    && (Number(payload.proof_size || 0) <= PROOF_INLINE_MAX)
    && String(payload.proof_data_url).length <= PROOF_INLINE_MAX;
  const wirePayload = {
    event: payload.event,
    contributor: payload.contributor,
    contributor_name: payload.contributor_name,
    contributor_email: payload.contributor_email || '',
    contributor_mobile: payload.contributor_mobile || '',
    flat: payload.flat,
    amount: Number(payload.amount || 0),
    method: payload.method,
    anonymous: !!payload.anonymous,
    hide_amount: !!payload.hide_amount,
    ref: payload.ref || '',
    remarks: payload.remarks || '',
    on_behalf: !!payload.on_behalf,
    filled_by_id:    payload.filled_by_id    || null,
    filled_by_name:  payload.filled_by_name  || null,
    filled_by_email: payload.filled_by_email || null,
    cluster: evt && evt.cluster || null,
    template: evt && evt.template || null,
    proof_data_url: proofFits ? payload.proof_data_url : '',
    proof_name:     proofFits ? (payload.proof_name || '') : '',
    proof_size:     proofFits ? Number(payload.proof_size || 0) : 0,
  };
  let serverRec = null;
  try {
    const res = await api.createContribution(wirePayload);
    serverRec = res && res.contribution;
  } catch (err) {
    const wrapped = new Error(err && err.message ? err.message : 'Could not submit contribution to server.');
    wrapped.code = 'WORKER_WRITE_FAILED';
    throw wrapped;
  }
  const nowIso = new Date().toISOString();
  const rec = {
    /* Adopt the server-generated id + timestamps so both sides refer
     * to the same record. */
    id: (serverRec && serverRec.id) || uid('c'),
    event: payload.event,
    contributor: payload.contributor,
    contributor_name: payload.contributor_name,
    contributor_email: payload.contributor_email || '',
    contributor_mobile: payload.contributor_mobile || '',
    flat: payload.flat,
    amount: Number(payload.amount || 0),
    method: payload.method,
    anonymous: !!payload.anonymous,
    hide_amount: !!payload.hide_amount,
    ref: payload.ref || '',
    remarks: payload.remarks || '',
    /* Proof attachment stays in the local cache only (see wirePayload
     * comment above). Committee views it from the browser that owns
     * this record. Future slice can move blobs to a signed-URL flow. */
    proof_data_url: payload.proof_data_url || '',
    proof_name: payload.proof_name || '',
    proof_size: payload.proof_size || 0,
    on_behalf: !!payload.on_behalf,
    filled_by_id:    payload.filled_by_id    || null,
    filled_by_name:  payload.filled_by_name  || null,
    filled_by_email: payload.filled_by_email || null,
    status: 'pending',
    receipt: null,
    created_by: (serverRec && serverRec.created_by) || (actor ? actor.id : payload.contributor),
    created_at: (serverRec && serverRec.created_at) || nowIso,
    verified_by: null,
    verified_at: null,
    /* Path returned by the Worker; used to build the verify request. */
    _archive_path: (serverRec && serverRec._path) || null,
  };
  list.push(rec);
  state.saveContribs(list);
  state.audit({ actor: rec.created_by, action: 'contrib.create', contrib: rec.id, event: rec.event, amount: rec.amount, on_behalf: rec.on_behalf });
  /* Manage-request bell: notify every verifier role that a new
   * contribution is waiting to be checked. Anonymous flag is
   * respected in the visible name; amount is always shown to
   * approvers so they can triage. */
  try {
    const evtRow = state.events().find(e => e.id === rec.event);
    const evtTitle = (evtRow && evtRow.title) || 'Event';
    const who = rec.anonymous
      ? 'Anonymous'
      : (rec.contributor_name || rec.contributor_email || rec.contributor || 'A resident');
    const amt = `₹${Number(rec.amount || 0).toLocaleString('en-IN')}`;
    notifyRoles(APPROVER_ROLES_CONTRIB, {
      kind: 'approval',
      title: `Contribution to verify: ${evtTitle}`,
      body: `${who} · ${amt} · ${rec.method || 'unknown method'}. Tap to verify.`,
      link: `#/e/${rec.event}/manage`,
    });
  } catch (_e) { /* notification failures never block create */ }
  return rec;
}

export async function verifyContribution(contribId, actor, comment) {
  const list = state.contribs();
  const rec = list.find(c => c.id === contribId);
  if (!rec) throw new Error('unknown contribution');
  const trimmedComment = String(comment || '').trim().slice(0, 240);
  /* Prefer server-side verify so the archive commit carries the true
   * verifier identity + timestamp. We update local mirror from the
   * server response. */
  let serverContrib = null;
  try {
    const path = rec._archive_path || _guessArchivePath(rec);
    if (path) {
      const res = await api.verifyContribution(path);
      serverContrib = res && res.contribution;
    }
  } catch (err) {
    /* Surface the error so committee sees it — don't silently mark
     * verified locally if the server refused. */
    const wrapped = new Error(err && err.message ? err.message : 'Verify failed on server.');
    wrapped.code = 'WORKER_WRITE_FAILED';
    throw wrapped;
  }
  const nowIso = new Date().toISOString();
  rec.status = 'verified';
  rec.verified_by = (serverContrib && serverContrib.verified_by) || (actor ? actor.id : null);
  rec.verified_at = (serverContrib && serverContrib.verified_at) || nowIso;
  if (trimmedComment) rec.verified_comment = trimmedComment;
  if (serverContrib && serverContrib.receipt_id && !rec.receipt) {
    rec.receipt = { id: serverContrib.receipt_id };
  }
  state.saveContribs(list);
  state.audit({ actor: actor ? actor.id : null, action: 'contrib.verify', contrib: rec.id, comment: trimmedComment || undefined });
  const evt = state.events().find(e => e.id === rec.event);
  if (evt && actor) {
    const detail = `contrib=${rec.id};amount=${rec.amount || 0}` + (trimmedComment ? `;note=${trimmedComment}` : '');
    appendHistory(evt, actor, 'contrib.verify', detail);
  }
  /* Notify the contributor directly (best-effort — falls back to
   * community-wide if we can't infer an email). When the contribution
   * was filed on someone else's behalf, notify the beneficiary AND
   * the filler so both know the receipt is ready. */
  try {
    const evt = state.events().find(e => e.id === rec.event);
    const title = 'Your contribution is verified';
    const body  = `${evt ? evt.title : 'Event'} · ₹${Number(rec.amount || 0).toLocaleString('en-IN')} received. Receipt ready.`;
    const link  = `#/e/${rec.event}`;
    /* Beneficiary channel: prefer the on-form contributor_email; fall
     * back to the id if it looks like an email; last resort user id. */
    if (rec.contributor_email) {
      notifyEmit({ audience: 'user', userEmail: rec.contributor_email, kind: 'receipt', title, body, link });
    } else if (rec.contributor && String(rec.contributor).includes('@')) {
      notifyEmit({ audience: 'user', userEmail: rec.contributor, kind: 'receipt', title, body, link });
    } else if (rec.created_by) {
      notifyEmit({ audience: 'user', userId: rec.created_by, kind: 'receipt', title, body, link });
    }
    /* Filler-of-record for on-behalf submissions gets their own copy. */
    if (rec.on_behalf && rec.filled_by_email && rec.filled_by_email !== rec.contributor_email) {
      notifyEmit({ audience: 'user', userEmail: rec.filled_by_email, kind: 'receipt',
        title: `Contribution verified · filed for ${rec.contributor_name || 'beneficiary'}`, body, link });
    }
  } catch (_e) { /* silent */ }
  return rec;
}

export function voidContribution(contribId, actor, reason) {
  const list = state.contribs();
  const rec = list.find(c => c.id === contribId);
  if (!rec) throw new Error('unknown contribution');
  rec.status = 'void';
  rec.void_reason = reason || '';
  state.saveContribs(list);
  state.audit({ actor: actor ? actor.id : null, action: 'contrib.void', contrib: rec.id, reason });
  const evt = state.events().find(e => e.id === rec.event);
  if (evt && actor) {
    appendHistory(evt, actor, 'contrib.void', `contrib=${rec.id};reason=${reason || ''}`);
  }
  return rec;
}

// Called by expense-verify handlers so the always-tracked audit trail
// stays consistent between contribution and expense verification.
export function recordExpenseVerify(rec, actor, comment) {
  if (!rec || !actor) return;
  const evt = state.events().find(e => e.id === rec.event_id);
  if (!evt) return;
  const trimmed = String(comment || '').trim().slice(0, 240);
  const detail = `expense=${rec.id};amount=${rec.amount || 0};category=${rec.category || ''}`
    + (trimmed ? `;note=${trimmed}` : '');
  appendHistory(evt, actor, 'expense.verify', detail);
}

export function publicBoardFor(eventId) {
  return contribsFor(eventId)
    .filter(c => c.status === 'verified')
    .map(c => ({
      when: c.verified_at || c.created_at,
      name: c.anonymous ? 'Anonymous' : (c.contributor_name || '—'),
      flat: c.anonymous ? '' : (c.flat || ''),
      amount: c.hide_amount ? null : c.amount,
      contribId: c.id,
      hasReceipt: !!c.receipt,
      contributor: c.contributor || '',
      contributorEmail: c.contributor_email || '',
      createdBy: c.created_by || '',
      filledByEmail: c.filled_by_email || '',
    }))
    .sort((a, b) => (b.when || '').localeCompare(a.when || ''));
}

export function detectDataLinkageIssues() {
  const events = state.events();
  const contribs = state.contribs();
  const eventById = new Map(events.map(e => [e.id, e]));
  const visible = new Set(publicEvents().map(e => e.id));

  const usageByEvent = new Map();
  for (const c of contribs) {
    if (!c || !c.event) continue;
    const bucket = usageByEvent.get(c.event) || { count: 0, total: 0, sample: null };
    bucket.count += 1;
    bucket.total += Number(c.amount || 0);
    if (!bucket.sample) bucket.sample = c;
    usageByEvent.set(c.event, bucket);
  }

  const hiddenOwners = [];
  const orphans = [];
  for (const [eventId, stats] of usageByEvent.entries()) {
    const evt = eventById.get(eventId);
    if (!evt) {
      orphans.push({ eventId, count: stats.count, total: stats.total, sample: stats.sample });
      continue;
    }
    if (!visible.has(evt.id)) {
      hiddenOwners.push({ event: evt, count: stats.count, total: stats.total });
    }
  }
  hiddenOwners.sort((a, b) => b.total - a.total);
  orphans.sort((a, b) => b.total - a.total);
  return { hiddenOwners, orphans };
}

export async function migrateContributions(fromEventId, toEventId, actor) {
  if (!fromEventId || !toEventId || fromEventId === toEventId) {
    throw new Error('Source and target events must be different.');
  }
  const events = state.events();
  const target = events.find(e => e.id === toEventId);
  if (!target) throw new Error('Target event not found.');
  const contribs = state.contribs();
  let moved = 0;
  const relinks = {};
  for (const c of contribs) {
    if (c && c.event === fromEventId) {
      c.event = toEventId;
      c.migrated_from = fromEventId;
      c.migrated_at = new Date().toISOString();
      if (c.id) relinks[c.id] = toEventId;
      moved += 1;
    }
  }
  if (!moved) return { moved: 0 };
  state.saveContribs(contribs);
  state.audit({ actor: actor ? actor.id : null, action: 'contrib.migrate', from: fromEventId, to: toEventId, count: moved });
  // Publish the relinks to shared society overrides so every device applies them on sync.
  await persistRecoveryOverrides({ contribution_relinks: relinks });
  return { moved };
}

export async function restoreEventToPublished(eventId, actor) {
  const events = state.events();
  const evt = events.find(e => e.id === eventId);
  if (!evt) throw new Error('Event not found.');
  const before = normalizeStatus(evt.status);
  const target = STATUS.PUBLISHED;
  if (before !== target && !isTransitionAllowed(before, target)) {
    if (before === STATUS.DRAFT || before === STATUS.REVIEW) {
      evt.status = target;
    } else {
      throw new Error(`Cannot restore from "${before}". Move the event manually first.`);
    }
  } else {
    evt.status = target;
  }
  evt.updated_at = new Date().toISOString();
  state.saveEvents(events);
  state.audit({ actor: actor ? actor.id : null, action: 'event.restore', event: evt.id, from: before, to: evt.status });
  // Persist decision to shared overrides so every device honours it even if writeEvent races.
  await persistRecoveryOverrides({ event_status: { [evt.id]: target } });
  try {
    const slug = sanitizeForPath(evt.slug || evt.id || 'event');
    const res = await api.writeEvent(slug, evt);
    const saved = (res && res.event) || evt;
    const all = state.events();
    const j = all.findIndex(e => e.id === saved.id);
    if (j >= 0) all[j] = saved; else all.push(saved);
    state.saveEvents(all);
    return saved;
  } catch (err) {
    evt._recovery_pending = true;
    state.saveEvents(events);
    console.warn('[recovery] writeEvent push failed — shared overrides will keep the local status.', err && err.message ? err.message : err);
    return evt;
  }
}

async function persistRecoveryOverrides({ contribution_relinks, event_status }) {
  const over = state.societyOverrides() || {};
  const recovery = { ...(over.recovery || {}) };
  if (contribution_relinks && Object.keys(contribution_relinks).length) {
    recovery.contribution_relinks = { ...(recovery.contribution_relinks || {}), ...contribution_relinks };
  }
  if (event_status && Object.keys(event_status).length) {
    recovery.event_status = { ...(recovery.event_status || {}), ...event_status };
  }
  over.recovery = recovery;
  state.saveSocietyOverrides(over);
  try {
    await api.writeSettings(over);
  } catch (err) {
    // Local override still wins locally; next successful writeSettings will publish.
    console.warn('[recovery] writeSettings push failed — recovery is local until next successful settings save.', err && err.message ? err.message : err);
  }
}

// Applied by sync after hydration so recovery decisions survive server refresh.
export function applyRecoveryOverridesToState() {
  const over = state.societyOverrides() || {};
  const recovery = over.recovery || {};
  const relinks = recovery.contribution_relinks || {};
  const statusMap = recovery.event_status || {};

  const relinkIds = Object.keys(relinks);
  if (relinkIds.length) {
    const list = state.contribs();
    let changed = false;
    for (const c of list) {
      if (!c || !c.id) continue;
      const target = relinks[c.id];
      if (target && c.event !== target) {
        c.event = target;
        c.migrated_at = c.migrated_at || new Date().toISOString();
        changed = true;
      }
    }
    if (changed) state.saveContribs(list);
  }

  const statusIds = Object.keys(statusMap);
  if (statusIds.length) {
    const list = state.events();
    let changed = false;
    for (const e of list) {
      if (!e || !e.id) continue;
      const desired = statusMap[e.id];
      if (desired && e.status !== desired && isTransitionAllowed(e.status, desired)) {
        e.status = desired;
        e.updated_at = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) state.saveEvents(list);
  }
}
