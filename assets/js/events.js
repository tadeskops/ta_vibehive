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
  const rec = {
    id: uid('c'),
    event: payload.event,
    contributor: payload.contributor,
    contributor_name: payload.contributor_name,
    flat: payload.flat,
    amount: Number(payload.amount || 0),
    method: payload.method,
    anonymous: !!payload.anonymous,
    hide_amount: !!payload.hide_amount,
    ref: payload.ref || '',
    remarks: payload.remarks || '',
    /* Payment proof (screenshot / PDF), stored as a data URL. Compressed
     * client-side in the contribute view before it lands here so we
     * don't blow the localStorage quota. Committee uses this to verify. */
    proof_data_url: payload.proof_data_url || '',
    proof_name: payload.proof_name || '',
    proof_size: payload.proof_size || 0,
    status: 'pending',
    receipt: null,
    created_by: actor ? actor.id : payload.contributor,
    created_at: new Date().toISOString(),
    verified_by: null,
    verified_at: null,
  };
  list.push(rec);
  state.saveContribs(list);
  state.audit({ actor: rec.created_by, action: 'contrib.create', contrib: rec.id, event: rec.event, amount: rec.amount });
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
  /* Notify the contributor directly (best-effort — falls back to
   * community-wide if we can't infer an email). */
  try {
    const evt = state.events().find(e => e.id === rec.event);
    const title = 'Your contribution is verified';
    const body  = `${evt ? evt.title : 'Event'} · ₹${Number(rec.amount || 0).toLocaleString('en-IN')} received. Receipt ready.`;
    const link  = `#/e/${rec.event}`;
    if (rec.contributor && String(rec.contributor).includes('@')) {
      notifyEmit({ audience: 'user', userEmail: rec.contributor, kind: 'receipt', title, body, link });
    } else if (rec.created_by) {
      notifyEmit({ audience: 'user', userId: rec.created_by, kind: 'receipt', title, body, link });
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
