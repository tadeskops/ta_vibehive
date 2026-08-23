/* Event Operations Workspace — data layer.
 *
 * One document per event held under `tvh:v1:operations:<eventId>`.
 * Kept as a single blob so archive push replaces the whole doc
 * atomically. See docs/requirement.md §23 for the design brief.
 *
 * Shape:
 *   {
 *     version: 1,
 *     updated_at, updated_by,
 *     people:    [ { id, name, flat, mobile, email } ],
 *     ownership: [ { id, area, person_id, description, responsibilities:[] } ],
 *     activities:[ {
 *       id, title, category, icon,
 *       days:[Number], start_time, end_time, location,
 *       owner_id, status, primary_lead_id, co_lead_id,
 *       volunteer_ids:[], responsibilities:[], tasks:[]
 *     } ],
 *   }
 *
 * IDs are used everywhere so a person's name/flat/mobile changes in
 * one place and every activity reflects it.
 */
'use strict';
import { state } from './store.js';

export const OPS_STATUS = Object.freeze({
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  READY:       'ready',
  ATTENTION:   'attention',
});

export const OPS_STATUS_LABEL = {
  not_started: 'Not started',
  in_progress: 'In progress',
  ready:       'Ready',
  attention:   'Needs attention',
};

/* Curated starter categories so the empty state is not a blank slate.
 * Admin can add / rename / disable categories via the Activities tab. */
export const DEFAULT_CATEGORIES = [
  { id: 'rituals',     label: 'Rituals & पूजा',      icon: '🙏' },
  { id: 'cultural',    label: 'Cultural',              icon: '🎭' },
  { id: 'decoration',  label: 'Decoration & Setup',    icon: '🎨' },
  { id: 'hospitality', label: 'Hospitality',           icon: '🍛' },
  { id: 'safety',      label: 'Safety & Support',      icon: '🛡' },
  { id: 'comms',       label: 'Communication',         icon: '📣' },
];

export const DEFAULT_OWNERSHIP_AREAS = [
  { area: 'Overall Coordination', description: 'Event owner. Escalation point.' },
  { area: 'Cultural Program',     description: 'All cultural activities and performances.' },
  { area: 'Operations & Logistics', description: 'Setup, decor, sound, safety.' },
  { area: 'Finance & Coordination', description: 'Budget tracking + committee liaison.' },
];

function nextId(prefix) {
  // Compact, sortable, url-safe.
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Load the ops doc for an event. Returns a normalised skeleton with
 * empty collections when the event has none saved yet, so callers can
 * treat `.people`, `.ownership`, `.activities` as always-present
 * arrays.
 */
export function loadOps(eventId) {
  const raw = state.operationsFor(eventId);
  if (!raw || typeof raw !== 'object') return blankDoc();
  return {
    version:    Number(raw.version) || 1,
    updated_at: raw.updated_at || null,
    updated_by: raw.updated_by || null,
    people:     Array.isArray(raw.people)     ? raw.people     : [],
    ownership:  Array.isArray(raw.ownership)  ? raw.ownership  : [],
    activities: Array.isArray(raw.activities) ? raw.activities : [],
    categories: Array.isArray(raw.categories) ? raw.categories : DEFAULT_CATEGORIES.slice(),
  };
}

export function blankDoc() {
  return {
    version: 1,
    updated_at: null,
    updated_by: null,
    people: [],
    ownership: [],
    activities: [],
    categories: DEFAULT_CATEGORIES.slice(),
  };
}

function saveDoc(eventId, doc, actor) {
  doc.updated_at = new Date().toISOString();
  doc.updated_by = actor && (actor.email || actor.id) || doc.updated_by || null;
  state.saveOperationsFor(eventId, doc);
  return doc;
}

/* ---------- People directory ---------- */

export function upsertPerson(eventId, person, actor) {
  if (!person || !person.name) throw new Error('Name is required.');
  const doc = loadOps(eventId);
  const scrubMobile = (m) => String(m || '').replace(/\D+/g, '').replace(/^91(?=\d{10}$)/, '');
  const clean = {
    id:     person.id || nextId('p'),
    name:   String(person.name).trim(),
    flat:   String(person.flat || '').trim(),
    mobile: scrubMobile(person.mobile),
    email:  String(person.email || '').trim().toLowerCase(),
  };
  const idx = doc.people.findIndex(p => p.id === clean.id);
  if (idx >= 0) doc.people[idx] = { ...doc.people[idx], ...clean };
  else doc.people.push(clean);
  return { doc: saveDoc(eventId, doc, actor), person: clean };
}

export function removePerson(eventId, personId, actor) {
  const doc = loadOps(eventId);
  doc.people = doc.people.filter(p => p.id !== personId);
  // Detach the id from every reference so no dangling links remain.
  for (const o of doc.ownership) if (o.person_id === personId) o.person_id = '';
  for (const a of doc.activities) {
    if (a.owner_id === personId) a.owner_id = '';
    if (a.primary_lead_id === personId) a.primary_lead_id = '';
    if (a.co_lead_id === personId) a.co_lead_id = '';
    a.volunteer_ids = (a.volunteer_ids || []).filter(v => v !== personId);
  }
  return saveDoc(eventId, doc, actor);
}

export function findPerson(doc, personId) {
  if (!doc || !personId) return null;
  return (doc.people || []).find(p => p.id === personId) || null;
}

/* ---------- Ownership ---------- */

export function seedOwnershipIfEmpty(eventId, actor) {
  const doc = loadOps(eventId);
  if (doc.ownership.length) return doc;
  doc.ownership = DEFAULT_OWNERSHIP_AREAS.map(a => ({
    id: nextId('o'),
    area: a.area,
    description: a.description,
    person_id: '',
    responsibilities: [],
  }));
  return saveDoc(eventId, doc, actor);
}

export function upsertOwnership(eventId, entry, actor) {
  if (!entry || !entry.area) throw new Error('Ownership area is required.');
  const doc = loadOps(eventId);
  const clean = {
    id: entry.id || nextId('o'),
    area: String(entry.area).trim(),
    description: String(entry.description || '').trim(),
    person_id: entry.person_id || '',
    responsibilities: Array.isArray(entry.responsibilities) ? entry.responsibilities : [],
  };
  const idx = doc.ownership.findIndex(o => o.id === clean.id);
  if (idx >= 0) doc.ownership[idx] = { ...doc.ownership[idx], ...clean };
  else doc.ownership.push(clean);
  return saveDoc(eventId, doc, actor);
}

export function removeOwnership(eventId, ownershipId, actor) {
  const doc = loadOps(eventId);
  doc.ownership = doc.ownership.filter(o => o.id !== ownershipId);
  return saveDoc(eventId, doc, actor);
}

/* ---------- Activities ---------- */

export function upsertActivity(eventId, activity, actor) {
  if (!activity || !activity.title) throw new Error('Activity title is required.');
  const doc = loadOps(eventId);
  const clean = {
    id: activity.id || nextId('a'),
    title: String(activity.title).trim(),
    category: activity.category || '',
    icon: activity.icon || '',
    days: Array.isArray(activity.days) ? activity.days.map(Number).filter(Number.isFinite) : [],
    start_time: activity.start_time || '',
    end_time:   activity.end_time || '',
    location:   String(activity.location || '').trim(),
    owner_id:   activity.owner_id || '',
    status: OPS_STATUS[String(activity.status || '').toUpperCase()] || activity.status || OPS_STATUS.NOT_STARTED,
    primary_lead_id: activity.primary_lead_id || '',
    co_lead_id:      activity.co_lead_id || '',
    volunteer_ids:   Array.isArray(activity.volunteer_ids) ? [...new Set(activity.volunteer_ids)] : [],
    responsibilities: Array.isArray(activity.responsibilities) ? activity.responsibilities : [],
    tasks: Array.isArray(activity.tasks) ? activity.tasks : [],
  };
  const idx = doc.activities.findIndex(a => a.id === clean.id);
  if (idx >= 0) doc.activities[idx] = { ...doc.activities[idx], ...clean };
  else doc.activities.push(clean);
  return { doc: saveDoc(eventId, doc, actor), activity: clean };
}

export function removeActivity(eventId, activityId, actor) {
  const doc = loadOps(eventId);
  doc.activities = doc.activities.filter(a => a.id !== activityId);
  return saveDoc(eventId, doc, actor);
}

/* ---------- Tasks (per-activity checklist) ---------- */

// Normalises legacy string entries (["do X", "do Y"]) into the object
// shape so the UI can render them uniformly.
export function normaliseTask(t) {
  if (t && typeof t === 'object') {
    return {
      id:          t.id || nextId('t'),
      text:        String(t.text || '').trim(),
      done:        !!t.done,
      assigned_to: t.assigned_to || '',
      due_day:     Number.isFinite(Number(t.due_day)) ? Number(t.due_day) : null,
      notes:       String(t.notes || '').trim(),
      created_at:  t.created_at || null,
      updated_at:  t.updated_at || null,
    };
  }
  return {
    id: nextId('t'),
    text: String(t || '').trim(),
    done: false,
    assigned_to: '',
    due_day: null,
    notes: '',
    created_at: null,
    updated_at: null,
  };
}

export function upsertTask(eventId, activityId, task, actor) {
  if (!task || !String(task.text || '').trim()) throw new Error('Task text is required.');
  const doc = loadOps(eventId);
  const a = doc.activities.find(x => x.id === activityId);
  if (!a) throw new Error('Activity not found.');
  a.tasks = (a.tasks || []).map(normaliseTask);
  const nowIso = new Date().toISOString();
  const clean = { ...normaliseTask(task), updated_at: nowIso };
  const idx = a.tasks.findIndex(t => t.id === clean.id);
  if (idx >= 0) a.tasks[idx] = { ...a.tasks[idx], ...clean };
  else { clean.created_at = nowIso; a.tasks.push(clean); }
  return { doc: saveDoc(eventId, doc, actor), task: clean };
}

export function toggleTaskDone(eventId, activityId, taskId, actor) {
  const doc = loadOps(eventId);
  const a = doc.activities.find(x => x.id === activityId);
  if (!a) return doc;
  a.tasks = (a.tasks || []).map(normaliseTask);
  const t = a.tasks.find(x => x.id === taskId);
  if (!t) return doc;
  t.done = !t.done;
  t.updated_at = new Date().toISOString();
  return saveDoc(eventId, doc, actor);
}

export function removeTask(eventId, activityId, taskId, actor) {
  const doc = loadOps(eventId);
  const a = doc.activities.find(x => x.id === activityId);
  if (!a) return doc;
  a.tasks = (a.tasks || []).map(normaliseTask).filter(t => t.id !== taskId);
  return saveDoc(eventId, doc, actor);
}

export function taskStats(activity) {
  const tasks = (activity && activity.tasks || []).map(normaliseTask);
  const done = tasks.filter(t => t.done).length;
  return { total: tasks.length, done, pending: tasks.length - done };
}

export function findActivity(doc, activityId) {
  if (!doc || !activityId) return null;
  return (doc.activities || []).find(a => a.id === activityId) || null;
}

/* ---------- Health / Attention ---------- */

/**
 * Roll up the whole doc into a health snapshot the Overview tab
 * consumes. Also produces the "Needs Attention" list.
 */
export function healthSnapshot(doc) {
  const counts = { ready: 0, in_progress: 0, attention: 0, not_started: 0 };
  const attention = [];

  for (const o of doc.ownership || []) {
    if (!o.person_id) attention.push({ kind: 'ownership.no_owner', label: `${o.area} — owner missing`, ownershipId: o.id });
  }

  for (const a of doc.activities || []) {
    const s = a.status || OPS_STATUS.NOT_STARTED;
    counts[s] = (counts[s] || 0) + 1;

    if (!a.primary_lead_id && !a.co_lead_id) {
      attention.push({ kind: 'activity.no_lead', label: `${a.title} — no leads assigned`, activityId: a.id });
    } else if (!a.primary_lead_id) {
      attention.push({ kind: 'activity.no_primary', label: `${a.title} — primary lead missing`, activityId: a.id });
    } else if (!a.co_lead_id) {
      attention.push({ kind: 'activity.no_colead', label: `${a.title} — co-lead missing`, activityId: a.id });
    }
    if ((a.volunteer_ids || []).length === 0 && s !== OPS_STATUS.NOT_STARTED) {
      attention.push({ kind: 'activity.no_volunteers', label: `${a.title} — no volunteers`, activityId: a.id });
    }
    if (s === OPS_STATUS.ATTENTION) {
      attention.push({ kind: 'activity.marked_attention', label: `${a.title} — flagged`, activityId: a.id });
    }
  }

  const totalOwners = (doc.ownership || []).length;
  const filledOwners = (doc.ownership || []).filter(o => !!o.person_id).length;
  const totalPeople = (doc.people || []).length;
  const totalActivities = (doc.activities || []).length;
  const volunteerCount = new Set(
    (doc.activities || []).flatMap(a => a.volunteer_ids || [])
  ).size;

  return {
    owners: { filled: filledOwners, total: totalOwners },
    activities: { total: totalActivities, ...counts },
    people: { total: totalPeople },
    volunteers: { unique: volunteerCount },
    attention,
  };
}

/**
 * Assignment-based access check: can this user modify this activity?
 * True for actors with `operations.manage` OR for the primary/co-lead
 * of the activity itself. Used by activity detail delegation, per
 * requirement.md §23 (delegated access model).
 */
export function canManageActivity(activity, user, caps) {
  if (!user) return false;
  if (caps && caps.opsManage) return true;
  if (!activity) return false;
  const uid = String(user.email || user.id || '').toLowerCase();
  const pid = String(activity.primary_lead_id || '').toLowerCase();
  const cid = String(activity.co_lead_id || '').toLowerCase();
  // Assignment match works when the linked person's email happens to
  // equal the caller's; otherwise fall through to caps only.
  return uid && (uid === pid || uid === cid);
}

/**
 * Best-effort resolution: caller's linked person id in the ops doc.
 * Matches by email first, then by id. Used to highlight self in the
 * Ownership + People views.
 */
export function selfPersonId(doc, user) {
  if (!doc || !user) return '';
  const email = String(user.email || '').toLowerCase();
  const uid = String(user.id || '').toLowerCase();
  for (const p of doc.people || []) {
    if (email && String(p.email || '').toLowerCase() === email) return p.id;
    if (uid && String(p.id || '').toLowerCase() === uid) return p.id;
  }
  return '';
}
