/* Event + contribution service. */
'use strict';
import { cfg, state } from './store.js';
import { catalog } from './features.js';
import { emit as notifyEmit } from './notify.js';

export const STATUS = Object.freeze({
  DRAFT: 'draft', REVIEW: 'review', PUBLISHED: 'published',
  CLOSED: 'closed', ARCHIVED: 'archived'
});

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
function shouldTrackHistory(evt, actor) {
  return !!(evt && evt.history_enabled && actor && roleIsModerator(actor.role));
}
function appendHistory(evt, actor, action, detail) {
  if (!shouldTrackHistory(evt, actor)) return;
  const row = {
    event: evt.id,
    event_title: evt.title,
    actor: actor.email || actor.id || '',
    actor_role: actor.role || '',
    action,
    detail,
  };
  state.addEventHistory(row);
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    state.enqueueArchive({
      kind: 'history',
      path: `history/${sanitizeForPath(evt.slug || evt.id || 'event')}/${ts}.json`,
      content: JSON.stringify({ ...row, ts: new Date().toISOString() }, null, 2),
      eventId: evt.id,
    });
  } catch (_e) { /* best-effort */ }
}

function sanitizeForPath(v) {
  return String(v || '').replace(/[^a-z0-9_.-]+/gi, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'event';
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
    slug: slugify(tpl.label + '-' + now.getFullYear()),
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

export function saveEvent(evt, actor) {
  const evts = state.events();
  const priorStatus = (evts.find(e => e.id === evt.id) || {}).status || null;
  evt.updated_at = new Date().toISOString();
  const i = evts.findIndex(e => e.id === evt.id);
  if (i >= 0) evts[i] = evt; else evts.push(evt);
  state.saveEvents(evts);
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
    .filter(e => e.status === STATUS.PUBLISHED || e.status === STATUS.CLOSED);
  const byKey = new Map();
  const keyOf = e => (e.slug || (e.title || '').toLowerCase().trim() || e.id);
  for (const e of filtered) {
    const k = keyOf(e);
    const prev = byKey.get(k);
    if (!prev || (e.updated_at || '') > (prev.updated_at || '')) byKey.set(k, e);
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

export function addContribution(payload, actor) {
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
  const rec = {
    id: uid('c'),
    event: payload.event,
    contributor: payload.contributor,
    contributor_name: payload.contributor_name,
    /* Contributor email is captured on the form (mandatory) so we can
     * notify the payer directly at submit and verify time without
     * having to look them up in the users list. When on_behalf is true
     * this is the BENEFICIARY's email, not the filler's. */
    contributor_email: payload.contributor_email || '',
    /* Mobile number (10-digit, starting 6-9) captured on the form.
     * Used ONLY by the committee for post-submit rectification (wrong
     * name / flat on a receipt). Never rendered on the public board. */
    contributor_mobile: payload.contributor_mobile || '',
    flat: payload.flat,
    amount: Number(payload.amount || 0),
    method: payload.method,
    anonymous: !!payload.anonymous,
    hide_amount: !!payload.hide_amount,
    ref: payload.ref || '',
    remarks: payload.remarks || '',
    /* Payment proof (screenshot / PDF), stored as a data URL. Compressed
     * client-side in the contribute view before it lands here so we
     * don't blow the localStorage quota. Committee uses this to verify.
     * Attach is MANDATORY when on_behalf is true. */
    proof_data_url: payload.proof_data_url || '',
    proof_name: payload.proof_name || '',
    proof_size: payload.proof_size || 0,
    /* On-behalf-of trail. When true, the signed-in user (`filled_by_*`)
     * paid or is registering the payment for someone else, and that
     * someone else is the `contributor_name/email/flat` above. */
    on_behalf: !!payload.on_behalf,
    filled_by_id:    payload.filled_by_id    || null,
    filled_by_name:  payload.filled_by_name  || null,
    filled_by_email: payload.filled_by_email || null,
    status: 'pending',
    receipt: null,
    created_by: actor ? actor.id : payload.contributor,
    created_at: new Date().toISOString(),
    verified_by: null,
    verified_at: null,
  };
  list.push(rec);
  state.saveContribs(list);
  state.audit({ actor: rec.created_by, action: 'contrib.create', contrib: rec.id, event: rec.event, amount: rec.amount, on_behalf: rec.on_behalf });
  return rec;
}

export function verifyContribution(contribId, actor) {
  const list = state.contribs();
  const rec = list.find(c => c.id === contribId);
  if (!rec) throw new Error('unknown contribution');
  rec.status = 'verified';
  rec.verified_by = actor ? actor.id : null;
  rec.verified_at = new Date().toISOString();
  state.saveContribs(list);
  state.audit({ actor: actor ? actor.id : null, action: 'contrib.verify', contrib: rec.id });
  const evt = state.events().find(e => e.id === rec.event);
  if (evt && actor) {
    appendHistory(evt, actor, 'contrib.verify', `contrib=${rec.id};amount=${rec.amount || 0}`);
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

export function publicBoardFor(eventId) {
  return contribsFor(eventId)
    .filter(c => c.status === 'verified')
    .map(c => ({
      when: c.verified_at || c.created_at,
      name: c.anonymous ? 'Anonymous' : (c.contributor_name || '—'),
      flat: c.anonymous ? '' : (c.flat || ''),
      amount: c.hide_amount ? null : c.amount,
    }))
    .sort((a, b) => (b.when || '').localeCompare(a.when || ''));
}
