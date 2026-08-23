/* Event Operations Workspace view.
 *
 * Route:  #/e/:eventId/operations
 *         #/e/:eventId/operations/activity/:activityId
 *         #/e/:eventId/operations/people
 *         #/e/:eventId/operations/matrix
 *
 * Phase-1 scope shipped:
 *   Overview  · Ownership · Activities (with primary + co-lead assign)
 * Phase-2/3/4 scaffolded (tabs render placeholder cards) so the
 * downstream slices can drop in without touching the shell:
 *   People directory · 7-Day plan · Matrix
 *
 * Design brief in docs/requirement.md §23.
 */
'use strict';
/* Feature wiring markers (used by CI traceability audit):
 * - operations.workspace
 * - operations.people
 * - operations.tasks
 * - operations.matrix
 */
import { el, mount, clear, fmtDate, toast, modal } from '../dom.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { isEventOn } from '../features.js';
import { findEvent } from '../events.js';
import { navigate } from '../router.js';
import {
  loadOps, seedOwnershipIfEmpty, healthSnapshot,
  upsertPerson, upsertOwnership, upsertActivity,
  removeActivity, removeOwnership, removePerson,
  findPerson, findActivity, selfPersonId,
  normaliseTask, upsertTask, toggleTaskDone, removeTask, taskStats,
  OPS_STATUS, OPS_STATUS_LABEL,
  DEFAULT_CATEGORIES,
} from '../operations.js';

/* ---------- entry ---------- */

export async function render(root, ctx = {}) {
  const user = session();
  if (!user) {
    navigate('/login?next=' + encodeURIComponent(location.hash));
    return;
  }
  const evtId = ctx && ctx.match && ctx.match.id;
  const evt = findEvent(evtId);
  if (!evt) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Event not found' }),
      el('a', { class: 'btn btn-ghost', href: '#/events' }, 'Back to events')
    ));
  }

  const workspaceOn = await isEventOn('operations.workspace', evt);
  if (!workspaceOn) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: '🎯 Operations workspace is off for this event' }),
      el('p', { class: 'sub', text: 'Enable "Event Operations Workspace" in the event editor features to plan owners, activities, and volunteers here.' }),
      el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}` }, 'Back to event')
    ));
  }

  const [canView, canManage, canOwnership, canManagePeople] = await Promise.all([
    can(user, 'operations.view'),
    can(user, 'operations.manage'),
    can(user, 'operations.ownership.manage'),
    can(user, 'operations.people.manage'),
  ]);
  if (!canView) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Not authorised' }),
      el('p', { class: 'sub', text: 'You need operations.view to see this workspace. Ask an admin.' })
    ));
  }
  // Sub-feature flags pre-resolved so every render helper can stay
  // synchronous. Each flag defaults to true if the master workspace
  // flag is on but the sub-feature toggle is missing.
  const [peopleOn, tasksOn, matrixOn, contactOn, timelineOn, wizardOn] = await Promise.all([
    isEventOn('operations.people', evt),
    isEventOn('operations.tasks', evt),
    isEventOn('operations.matrix', evt),
    isEventOn('operations.contact_directory', evt),
    isEventOn('operations.timeline', evt),
    isEventOn('operations.wizard', evt),
  ]);
  const caps = {
    opsManage: canManage,
    opsOwnership: canOwnership,
    opsPeople: canManagePeople,
    opsPeopleOn: peopleOn,
    opsTasksOn: tasksOn,
    opsMatrixOn: matrixOn,
    opsContactOn: contactOn,
    opsTimelineOn: timelineOn,
    opsWizardOn: wizardOn,
  };

  const sub  = (ctx && ctx.match && ctx.match.sub) || 'overview';
  const activityId = ctx && ctx.match && ctx.match.activityId || '';
  const params = (ctx && ctx.params) || new URLSearchParams();

  const doc = loadOps(evt.id);
  const health = healthSnapshot(doc);
  const selfPid = selfPersonId(doc, user);

  const shell = el('div', { class: 'tvh-ops-shell' });

  shell.append(renderHeader(evt, health, sub));

  if (sub === 'activity' && activityId) {
    shell.append(renderActivityDetail(evt, doc, activityId, user, caps));
  } else if (sub === 'people') {
    shell.append(renderPeoplePanel(evt, doc, user, caps));
  } else if (sub === 'plan') {
    shell.append(renderPlanPanel(evt, doc, user, caps, params));
  } else if (sub === 'matrix') {
    shell.append(renderMatrixPanel(evt, doc, user, caps, params));
  } else if (sub === 'activities') {
    shell.append(renderActivitiesPanel(evt, doc, user, caps));
  } else {
    shell.append(renderOverview(evt, doc, health, selfPid, user, caps));
  }

  mount(root, shell);
}

/* ---------- header ---------- */

function renderHeader(evt, health, activeTab) {
  const daySpan = [evt.start_at, evt.end_at].filter(Boolean).map(d => fmtDate(d)).join(' – ');
  const tabs = [
    { id: 'overview',   label: 'Overview',   href: `#/e/${evt.id}/operations` },
    { id: 'plan',       label: '7-Day Plan', href: `#/e/${evt.id}/operations/plan` },
    { id: 'activities', label: 'Activities', href: `#/e/${evt.id}/operations/activities` },
    { id: 'people',     label: 'People',     href: `#/e/${evt.id}/operations/people` },
    { id: 'matrix',     label: 'Matrix',     href: `#/e/${evt.id}/operations/matrix` },
  ];
  return el('section', { class: 'tvh-ops-hero card card-pad' },
    el('div', { class: 'row row-between', style: 'align-items:flex-start;flex-wrap:wrap;gap:12px' },
      el('div', { style: 'min-width:0' },
        el('h1', { style: 'margin:0 0 4px', text: '🎯 Operations · ' + evt.title }),
        el('p', { class: 'sub', style: 'margin:0', text: daySpan || 'Event dates not set' })
      ),
      el('a', { class: 'btn btn-ghost btn-sm', href: `#/e/${evt.id}` }, '← Event')
    ),
    el('nav', { class: 'tvh-ops-tabs', role: 'tablist' },
      ...tabs.map(t => el('a', {
        class: 'tvh-ops-tab' + (t.id === activeTab || (activeTab === 'activity' && t.id === 'activities') ? ' active' : ''),
        href: t.href,
        role: 'tab',
      }, t.label))
    )
  );
}

/* ---------- Overview ---------- */

function renderOverview(evt, doc, health, selfPid, user, caps) {
  const wrap = el('div', { class: 'tvh-ops-overview' });

  // Summary tiles
  const tiles = el('div', { class: 'grid grid-4' },
    kpi('👑 Event Owners',   `${health.owners.filled} / ${health.owners.total}`, 'assigned'),
    kpi('🎯 Activities',     String(health.activities.total),                    'planned'),
    kpi('👥 Volunteers',     String(health.volunteers.unique),                   'unique people'),
    kpi('⚠ Attention',       String(health.attention.length),                    'items'),
  );
  wrap.append(tiles);

  // Operational health bars
  wrap.append(el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { style: 'margin:0 0 10px', text: 'Operational health' }),
    el('div', { class: 'tvh-ops-health' },
      healthBar('🟢 Ready',        health.activities.ready       || 0, 'is-ready'),
      healthBar('🟡 In progress',  health.activities.in_progress || 0, 'is-progress'),
      healthBar('🔴 Attention',    health.activities.attention   || 0, 'is-attention'),
      healthBar('⚪ Not started',   health.activities.not_started || 0, 'is-idle'),
    )
  ));

  // Needs Attention list
  if (health.attention.length) {
    wrap.append(el('section', { class: 'card card-pad', style: 'margin-top:16px' },
      el('h3', { style: 'margin:0 0 10px', text: 'Needs attention' }),
      el('ul', { class: 'tvh-ops-attn' },
        ...health.attention.slice(0, 12).map(a => {
          const li = el('li', {});
          const href = a.activityId ? `#/e/${evt.id}/operations/activity/${a.activityId}` : `#/e/${evt.id}/operations/activities`;
          li.append(el('a', { class: 'tvh-ops-attn-link', href }, '⚠ ', a.label));
          return li;
        })
      )
    ));
  } else if (health.activities.total) {
    wrap.append(el('section', { class: 'card card-pad', style: 'margin-top:16px' },
      el('h3', { style: 'margin:0 0 4px', text: '🟢 Everything under control' }),
      el('p', { class: 'sub', style: 'margin:0', text: 'Every activity has leads and volunteers assigned. Keep it up.' })
    ));
  }

  // Ownership grid
  wrap.append(renderOwnershipSection(evt, doc, user, caps, selfPid));

  // Empty-state nudge
  if (!health.activities.total) {
    wrap.append(el('section', { class: 'card card-pad tvh-ops-empty', style: 'margin-top:16px;text-align:center' },
      el('h3', { text: "🎯 Let's organise this event" }),
      el('p', { class: 'sub', text: 'Break the event into activities, assign two leads each, and build your volunteer team.' }),
      caps.opsManage ? el('a', { class: 'btn', href: `#/e/${evt.id}/operations/activities` }, 'Start planning') : null
    ));
  }
  return wrap;
}

/* ---------- Ownership ---------- */

function renderOwnershipSection(evt, doc, user, caps, selfPid) {
  const wrap = el('section', { class: 'card card-pad', style: 'margin-top:16px' });
  wrap.append(el('div', { class: 'row row-between', style: 'align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px' },
    el('div', {},
      el('h3', { style: 'margin:0', text: '👑 Event Owners' }),
      el('small', { class: 'sub', text: 'High-level areas of responsibility. Each owner monitors the activities under their area.' })
    ),
    caps.opsOwnership ? el('button', { class: 'btn btn-sm', on: { click: () => openOwnershipModal(evt, doc, null, user) } }, '＋ Owner area') : null,
    (caps.opsOwnership && !doc.ownership.length) ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => {
      seedOwnershipIfEmpty(evt.id, user);
      toast('Seeded default ownership areas.', 'ok');
      navigate('/e/' + evt.id + '/operations');
    } } }, 'Seed default areas') : null,
  ));
  if (!doc.ownership.length) {
    wrap.append(el('p', { class: 'sub', text: 'No ownership areas yet. Use "Seed default areas" to start with the four standard areas (Overall / Cultural / Operations / Finance).' }));
    return wrap;
  }
  wrap.append(el('div', { class: 'tvh-ops-owner-grid' },
    ...doc.ownership.map(o => renderOwnerCard(evt, doc, o, user, caps, selfPid))
  ));
  return wrap;
}

function renderOwnerCard(evt, doc, o, user, caps, selfPid) {
  const person = findPerson(doc, o.person_id);
  const relatedActivities = (doc.activities || []).filter(a => a.owner_id === o.id).slice(0, 6);
  const card = el('article', { class: 'tvh-ops-owner-card' + (person && person.id === selfPid ? ' is-self' : '') },
    el('div', { class: 'tvh-ops-owner-head' },
      el('div', { class: 'lbl', text: o.area.toUpperCase() }),
      caps.opsOwnership ? el('button', { class: 'tvh-ops-icon-btn', title: 'Edit', on: { click: () => openOwnershipModal(evt, doc, o, user) } }, '✎') : null
    ),
    person
      ? el('div', { class: 'tvh-ops-owner-person' },
          el('div', { class: 'tvh-ops-avatar', text: initialsOf(person.name) }),
          el('div', { class: 'tvh-ops-owner-meta' },
            el('div', { class: 'tvh-ops-owner-name', text: person.name }),
            el('small', { class: 'sub', text: person.flat ? 'Flat ' + person.flat : 'Flat not set' })
          )
        )
      : el('div', { class: 'tvh-ops-owner-empty' },
          el('span', { class: 'pill pill-muted', text: 'Not assigned' }),
          caps.opsOwnership ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => openOwnershipModal(evt, doc, o, user) } }, 'Assign owner') : null
        ),
    o.description ? el('small', { class: 'sub', style: 'display:block;margin-top:6px', text: o.description }) : null,
    relatedActivities.length ? el('ul', { class: 'tvh-ops-owner-activities' },
      ...relatedActivities.map(a => el('li', {}, el('a', { href: `#/e/${evt.id}/operations/activity/${a.id}` }, (a.icon || '·') + ' ' + a.title)))
    ) : null
  );
  return card;
}

function openOwnershipModal(evt, doc, existing, user) {
  const entry = existing ? { ...existing } : { area: '', description: '', person_id: '', responsibilities: [] };
  const areaInp = el('input', { type: 'text', value: entry.area, required: '', placeholder: 'e.g. Cultural Program' });
  const descInp = el('textarea', { rows: 2, placeholder: 'What this owner is responsible for.' }, entry.description || '');
  const personSel = renderPersonPicker(doc, entry.person_id);
  modal({
    title: existing ? 'Edit ownership area' : 'Add ownership area',
    body: el('div', {},
      field('Area name', areaInp),
      field('Description', descInp),
      field('Owner', personSel),
      el('small', { class: 'sub', text: 'The owner is the point of contact for every activity in this area.' })
    ),
    actions: [
      { label: 'Cancel', close: true },
      existing ? { label: 'Delete', kind: 'btn-emerg', onClick: (close) => {
        if (!confirm('Remove this ownership area? Any activity in this area will be left un-owned.')) return;
        removeOwnership(evt.id, existing.id, user);
        close();
        toast('Ownership area removed.', 'ok');
        navigate('/e/' + evt.id + '/operations');
      } } : null,
      { label: existing ? 'Save' : 'Add area', onClick: (close) => {
        try {
          upsertOwnership(evt.id, {
            id: entry.id,
            area: areaInp.value.trim(),
            description: descInp.value.trim(),
            person_id: personSel.value,
            responsibilities: entry.responsibilities || [],
          }, user);
        } catch (err) { toast(err.message || 'Save failed', 'err'); return; }
        close();
        toast(existing ? 'Ownership updated.' : 'Ownership added.', 'ok');
        navigate('/e/' + evt.id + '/operations');
      } }
    ].filter(Boolean),
  });
}

/* ---------- Activities panel ---------- */

function renderActivitiesPanel(evt, doc, user, caps) {
  const wrap = el('div', {});
  wrap.append(el('section', { class: 'card card-pad' },
    el('div', { class: 'row row-between', style: 'align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px' },
      el('div', {},
        el('h3', { style: 'margin:0', text: '🎯 Activities' }),
        el('small', { class: 'sub', text: 'Every activity should have a primary + co-lead. Volunteers are attached inside the activity.' })
      ),
      caps.opsManage ? el('button', { class: 'btn btn-sm', on: { click: () => openActivityModal(evt, doc, null, user) } }, '＋ Activity') : null
    ),
    doc.activities.length
      ? el('div', { class: 'tvh-ops-activity-grid' },
          ...doc.activities.map(a => renderActivityCard(evt, doc, a, user, caps))
        )
      : el('p', { class: 'sub', text: 'No activities yet. Click "+ Activity" to add the first one.' })
  ));
  return wrap;
}

function renderActivityCard(evt, doc, a, user, caps) {
  const primary = findPerson(doc, a.primary_lead_id);
  const coLead  = findPerson(doc, a.co_lead_id);
  const owner   = doc.ownership.find(o => o.id === a.owner_id);
  const status  = a.status || OPS_STATUS.NOT_STARTED;
  const statusClass = statusPillClass(status);
  const missingBits = [];
  if (!primary) missingBits.push('Primary lead');
  if (!coLead)  missingBits.push('Co-lead');
  if (!(a.volunteer_ids || []).length) missingBits.push('Volunteers');
  return el('article', { class: 'tvh-ops-activity-card' },
    el('a', { class: 'tvh-ops-activity-body', href: `#/e/${evt.id}/operations/activity/${a.id}` },
      el('div', { class: 'row', style: 'gap:8px;align-items:center' },
        el('div', { class: 'tvh-ops-activity-icon', text: a.icon || '🎯' }),
        el('div', { style: 'min-width:0;flex:1' },
          el('div', { class: 'tvh-ops-activity-title', text: a.title }),
          el('small', { class: 'sub', text: (a.category ? categoryLabel(doc, a.category) + ' · ' : '') + (a.location || '—') })
        ),
        el('span', { class: 'pill ' + statusClass, text: OPS_STATUS_LABEL[status] || status }),
      ),
      el('div', { class: 'tvh-ops-activity-leads' },
        leadChip('Primary', primary),
        leadChip('Co-lead', coLead),
        el('span', { class: 'tvh-ops-vol-chip', title: 'Volunteers assigned', text: '👥 ' + ((a.volunteer_ids || []).length) })
      ),
      (a.start_time || a.days.length) ? el('small', { class: 'sub', style: 'display:block;margin-top:6px', text: [
        a.days.length ? `Day ${a.days.slice().sort((x,y)=>x-y).join(', ')}` : '',
        a.start_time,
      ].filter(Boolean).join(' · ') }) : null,
      missingBits.length ? el('div', { class: 'tvh-ops-missing', text: '⚠ ' + missingBits.join(' · ') + ' missing' }) : null,
      owner ? el('small', { class: 'sub', style: 'display:block;margin-top:6px', text: '👑 ' + owner.area }) : null
    ),
    caps.opsManage ? el('button', { class: 'tvh-ops-icon-btn', title: 'Edit activity', on: { click: (e) => { e.preventDefault(); openActivityModal(evt, doc, a, user); } } }, '✎') : null,
  );
}

function openActivityModal(evt, doc, existing, user) {
  const entry = existing ? { ...existing } : {
    title: '', category: '', icon: '', days: [], start_time: '', end_time: '',
    location: '', owner_id: '', status: OPS_STATUS.NOT_STARTED,
    primary_lead_id: '', co_lead_id: '', volunteer_ids: [], tasks: [],
  };
  const titleInp = el('input', { type: 'text', value: entry.title, required: '', placeholder: 'e.g. Cultural Evening' });
  const iconInp  = el('input', { type: 'text', value: entry.icon || '', maxlength: '4', placeholder: 'e.g. 🎭', style: 'width:80px' });
  const catSel = el('select', {},
    el('option', { value: '', text: 'Uncategorised' }),
    ...(doc.categories || DEFAULT_CATEGORIES).map(c => el('option', { value: c.id, selected: entry.category === c.id, text: `${c.icon || ''} ${c.label}` }))
  );
  const locationInp = el('input', { type: 'text', value: entry.location || '', placeholder: 'e.g. Society stage' });
  const dayInps = renderDayPicker(evt, entry.days || []);
  const startInp = el('input', { type: 'time', value: entry.start_time || '' });
  const endInp   = el('input', { type: 'time', value: entry.end_time   || '' });
  const ownerSel = el('select', {},
    el('option', { value: '', text: '— no owner —' }),
    ...doc.ownership.map(o => el('option', { value: o.id, selected: entry.owner_id === o.id, text: o.area }))
  );
  const primarySel = renderPersonPicker(doc, entry.primary_lead_id, { placeholder: '— pick primary lead —' });
  const coLeadSel  = renderPersonPicker(doc, entry.co_lead_id,      { placeholder: '— pick co-lead —' });
  const statusSel  = el('select', {},
    ...Object.values(OPS_STATUS).map(s => el('option', { value: s, selected: entry.status === s, text: OPS_STATUS_LABEL[s] }))
  );
  modal({
    title: existing ? 'Edit activity' : 'New activity',
    body: el('div', { class: 'tvh-ops-form' },
      el('div', { class: 'row', style: 'gap:8px;align-items:flex-end' },
        field('Icon', iconInp, { grow: 0 }),
        field('Title', titleInp, { grow: 1 })
      ),
      el('div', { class: 'row', style: 'gap:8px' },
        field('Category', catSel, { grow: 1 }),
        field('Owner area', ownerSel, { grow: 1 })
      ),
      field('Location', locationInp),
      field('Days of event', dayInps.wrap),
      el('div', { class: 'row', style: 'gap:8px' },
        field('Start time', startInp, { grow: 1 }),
        field('End time', endInp, { grow: 1 })
      ),
      el('div', { class: 'row', style: 'gap:8px' },
        field('Primary lead ★', primarySel, { grow: 1 }),
        field('Co-lead ★', coLeadSel, { grow: 1 })
      ),
      field('Status', statusSel),
      el('small', { class: 'sub', text: '★ Both leads are strongly recommended. Assign volunteers inside the activity detail.' })
    ),
    actions: [
      { label: 'Cancel', close: true },
      existing ? { label: 'Delete', kind: 'btn-emerg', onClick: (close) => {
        if (!confirm('Delete this activity? Volunteers stay in the People directory.')) return;
        removeActivity(evt.id, existing.id, user);
        close();
        toast('Activity deleted.', 'ok');
        navigate('/e/' + evt.id + '/operations/activities');
      } } : null,
      { label: existing ? 'Save' : 'Add activity', onClick: (close) => {
        try {
          const days = dayInps.selectedDays();
          upsertActivity(evt.id, {
            id: entry.id,
            title: titleInp.value.trim(),
            icon: iconInp.value.trim(),
            category: catSel.value,
            days,
            start_time: startInp.value || '',
            end_time: endInp.value || '',
            location: locationInp.value.trim(),
            owner_id: ownerSel.value,
            status: statusSel.value,
            primary_lead_id: primarySel.value,
            co_lead_id: coLeadSel.value,
            volunteer_ids: entry.volunteer_ids || [],
            tasks: entry.tasks || [],
          }, user);
        } catch (err) { toast(err.message || 'Save failed', 'err'); return; }
        close();
        toast(existing ? 'Activity updated.' : 'Activity added.', 'ok');
        navigate('/e/' + evt.id + '/operations/activities');
      } }
    ].filter(Boolean),
  });
}

/* ---------- Activity detail ---------- */

function renderActivityDetail(evt, doc, activityId, user, caps) {
  const a = findActivity(doc, activityId);
  if (!a) {
    return el('div', { class: 'card card-pad' },
      el('h2', { text: 'Activity not found' }),
      el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}/operations/activities` }, '← Activities')
    );
  }
  const primary = findPerson(doc, a.primary_lead_id);
  const coLead  = findPerson(doc, a.co_lead_id);
  const owner   = doc.ownership.find(o => o.id === a.owner_id);
  const volunteers = (a.volunteer_ids || []).map(id => findPerson(doc, id)).filter(Boolean);

  const wrap = el('div', {});
  wrap.append(el('section', { class: 'card card-pad' },
    el('div', { class: 'row row-between', style: 'flex-wrap:wrap;gap:8px;align-items:flex-start' },
      el('div', { style: 'min-width:0' },
        el('h2', { style: 'margin:0', text: (a.icon || '🎯') + ' ' + a.title }),
        el('small', { class: 'sub', text: [
          owner ? '👑 ' + owner.area : null,
          a.location ? '📍 ' + a.location : null,
          a.days.length ? 'Day ' + a.days.slice().sort((x,y)=>x-y).join(', ') : null,
          a.start_time ? a.start_time : null,
        ].filter(Boolean).join(' · ') || 'No schedule set' })
      ),
      el('span', { class: 'pill ' + statusPillClass(a.status), text: OPS_STATUS_LABEL[a.status] || a.status }),
    ),
    caps.opsManage ? el('div', { class: 'row', style: 'gap:6px;margin-top:10px;flex-wrap:wrap' },
      el('button', { class: 'btn btn-sm', on: { click: () => openActivityModal(evt, doc, a, user) } }, '✎ Edit'),
      el('a', { class: 'btn btn-sm btn-ghost', href: `#/e/${evt.id}/operations/activities` }, '← Activities')
    ) : el('a', { class: 'btn btn-sm btn-ghost', style: 'margin-top:10px', href: `#/e/${evt.id}/operations/activities` }, '← Activities')
  ));

  // Leadership block
  wrap.append(el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { style: 'margin:0 0 8px', text: '👥 Leadership' }),
    el('div', { class: 'tvh-ops-lead-grid' },
      renderLeadCard('Primary Lead', primary, caps),
      renderLeadCard('Co-Lead',      coLead,  caps),
    ),
    (!primary || !coLead) ? el('small', { class: 'sub', style: 'display:block;margin-top:8px', text: '⚠ Both leads should be assigned before the event day.' }) : null
  ));

  // Volunteers block
  wrap.append(renderVolunteerPanel(evt, doc, a, user, caps));

  // Responsibilities block (simple text list for phase-1)
  wrap.append(el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { style: 'margin:0 0 8px', text: '📋 Responsibilities' }),
    (a.responsibilities || []).length
      ? el('ul', {}, ...(a.responsibilities || []).map(r => el('li', { text: r })))
      : el('small', { class: 'sub', text: 'No responsibilities noted yet. Add them from the activity edit modal.' })
  ));

  // Tasks — real checklist gated by operations.tasks flag.
  wrap.append(renderTasksPanel(evt, doc, a, user, caps));

  return wrap;
}

function renderTasksPanel(evt, doc, activity, user, caps) {
  const tasksOn = caps.opsTasksOn;
  const wrap = el('section', { class: 'card card-pad', style: 'margin-top:16px' });
  if (!tasksOn) {
    wrap.append(
      el('h3', { style: 'margin:0 0 8px', text: '✅ Tasks' }),
      el('small', { class: 'sub', text: 'Task tracking is disabled for this event. Turn on operations.tasks in the event feature toggles.' })
    );
    return wrap;
  }
  const stats = taskStats(activity);
  wrap.append(el('div', { class: 'row row-between', style: 'align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:10px' },
    el('div', {},
      el('h3', { style: 'margin:0', text: '✅ Tasks' }),
      el('small', { class: 'sub', text: stats.total ? `${stats.done} / ${stats.total} done` : 'No tasks yet.' })
    ),
    caps.opsManage ? el('button', { class: 'btn btn-sm', on: { click: () => openTaskModal(evt, doc, activity, null, user) } }, '＋ Task') : null
  ));
  const tasks = (activity.tasks || []).map(normaliseTask);
  if (tasks.length) {
    wrap.append(el('ul', { class: 'tvh-ops-task-list' },
      ...tasks.map(t => renderTaskRow(evt, doc, activity, t, user, caps))
    ));
  }
  return wrap;
}

function renderTaskRow(evt, doc, activity, t, user, caps) {
  const assignee = t.assigned_to ? findPerson(doc, t.assigned_to) : null;
  const li = el('li', { class: 'tvh-ops-task' + (t.done ? ' is-done' : '') },
    el('button', { class: 'tvh-ops-task-check', type: 'button', 'aria-label': t.done ? 'Mark not done' : 'Mark done', on: { click: () => {
      if (!caps.opsManage) return;
      toggleTaskDone(evt.id, activity.id, t.id, user);
      navigate('/e/' + evt.id + '/operations/activity/' + activity.id);
    } } }, t.done ? '☑' : '☐'),
    el('div', { class: 'tvh-ops-task-body' },
      el('div', { class: 'tvh-ops-task-text', text: t.text || '(no text)' }),
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:2px' },
        assignee ? el('span', { class: 'tvh-ops-lead-chip' },
          el('span', { class: 'tvh-ops-avatar tvh-ops-avatar-sm', text: initialsOf(assignee.name) }),
          el('span', { text: assignee.name })
        ) : null,
        Number.isFinite(t.due_day) ? el('span', { class: 'pill pill-muted', text: 'Day ' + t.due_day }) : null,
        t.notes ? el('small', { class: 'sub', style: 'flex-basis:100%;margin-top:2px', text: t.notes }) : null,
      )
    ),
    caps.opsManage ? el('button', { class: 'tvh-ops-icon-btn tvh-ops-task-edit', title: 'Edit', on: { click: () => openTaskModal(evt, doc, activity, t, user) } }, '✎') : null
  );
  return li;
}

function openTaskModal(evt, doc, activity, existing, user) {
  const entry = existing ? normaliseTask(existing) : {
    id: '', text: '', done: false, assigned_to: '', due_day: null, notes: '',
  };
  const textInp = el('input', { type: 'text', value: entry.text, required: '', placeholder: 'e.g. Confirm sound vendor by Day 2' });
  const doneChk = el('input', { type: 'checkbox', checked: !!entry.done });
  const assigneeSel = renderPersonPicker(doc, entry.assigned_to, { placeholder: '— unassigned —' });
  const dueSel = el('select', {},
    el('option', { value: '', text: '— no due day —' }),
    ...Array.from({ length: countDays(evt) }, (_, i) => {
      const day = i + 1;
      return el('option', { value: String(day), selected: entry.due_day === day, text: 'Day ' + day });
    })
  );
  const notesInp = el('textarea', { rows: 2, placeholder: 'Optional notes.' }, entry.notes || '');
  modal({
    title: existing ? 'Edit task' : 'New task',
    body: el('div', { class: 'tvh-ops-form' },
      field('Task', textInp),
      el('label', { class: 'check-row' }, doneChk, el('span', { text: 'Mark as done' })),
      el('div', { class: 'row', style: 'gap:8px' },
        field('Assigned to', assigneeSel, { grow: 1 }),
        field('Due day', dueSel, { grow: 1 })
      ),
      field('Notes', notesInp)
    ),
    actions: [
      { label: 'Cancel', close: true },
      existing ? { label: 'Delete', kind: 'btn-emerg', onClick: (close) => {
        if (!confirm('Delete this task?')) return;
        removeTask(evt.id, activity.id, existing.id, user);
        close();
        toast('Task deleted.', 'ok');
        navigate('/e/' + evt.id + '/operations/activity/' + activity.id);
      } } : null,
      { label: existing ? 'Save' : 'Add task', onClick: (close) => {
        try {
          upsertTask(evt.id, activity.id, {
            id: entry.id || undefined,
            text: textInp.value.trim(),
            done: doneChk.checked,
            assigned_to: assigneeSel.value,
            due_day: dueSel.value ? Number(dueSel.value) : null,
            notes: notesInp.value.trim(),
          }, user);
        } catch (err) { toast(err.message || 'Save failed', 'err'); return; }
        close();
        toast(existing ? 'Task updated.' : 'Task added.', 'ok');
        navigate('/e/' + evt.id + '/operations/activity/' + activity.id);
      } }
    ].filter(Boolean),
  });
}

function renderLeadCard(label, person, caps) {
  return el('div', { class: 'tvh-ops-lead-card' },
    el('div', { class: 'lbl', text: label.toUpperCase() }),
    person
      ? el('div', { class: 'row', style: 'gap:10px;align-items:center' },
          el('div', { class: 'tvh-ops-avatar', text: initialsOf(person.name) }),
          el('div', { style: 'min-width:0' },
            el('div', { class: 'tvh-ops-owner-name', text: person.name }),
            el('small', { class: 'sub', text: person.flat ? '🏠 ' + person.flat : '' }),
            (caps && caps.opsManage && person.mobile) ? el('small', { class: 'sub', style: 'display:block', text: '📞 ' + person.mobile }) : null
          )
        )
      : el('span', { class: 'pill pill-muted', text: 'Not assigned' })
  );
}

function renderVolunteerPanel(evt, doc, activity, user, caps) {
  const wrap = el('section', { class: 'card card-pad', style: 'margin-top:16px' });
  wrap.append(el('div', { class: 'row row-between', style: 'align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px' },
    el('div', {},
      el('h3', { style: 'margin:0', text: '🤝 Volunteers · ' + ((activity.volunteer_ids || []).length) }),
      el('small', { class: 'sub', text: 'Pick from the People directory or add a new person.' })
    ),
    caps.opsManage ? el('button', { class: 'btn btn-sm', on: { click: () => openVolunteerPicker(evt, doc, activity, user) } }, '＋ Assign') : null
  ));
  const vols = (activity.volunteer_ids || []).map(id => findPerson(doc, id)).filter(Boolean);
  if (!vols.length) {
    wrap.append(el('p', { class: 'sub', text: 'No volunteers yet.' }));
    return wrap;
  }
  wrap.append(el('div', { class: 'tvh-ops-vol-list' },
    ...vols.map(v => el('div', { class: 'tvh-ops-vol-item' },
      el('div', { class: 'tvh-ops-avatar', text: initialsOf(v.name) }),
      el('div', { style: 'min-width:0;flex:1' },
        el('div', { class: 'tvh-ops-owner-name', text: v.name }),
        el('small', { class: 'sub', text: v.flat ? '🏠 ' + v.flat : '' })
      ),
      caps.opsManage ? el('button', { class: 'tvh-ops-icon-btn', title: 'Remove volunteer', on: { click: () => {
        const nextIds = (activity.volunteer_ids || []).filter(id => id !== v.id);
        upsertActivity(evt.id, { ...activity, volunteer_ids: nextIds }, user);
        toast('Volunteer removed.', 'ok');
        navigate('/e/' + evt.id + '/operations/activity/' + activity.id);
      } } }, '×') : null
    ))
  ));
  return wrap;
}

function openVolunteerPicker(evt, doc, activity, user) {
  const alreadyIn = new Set(activity.volunteer_ids || []);
  const available = doc.people.filter(p => !alreadyIn.has(p.id));
  const sel = el('select', { multiple: '', size: Math.min(8, Math.max(4, available.length)) },
    ...available.map(p => el('option', { value: p.id, text: `${p.name}${p.flat ? ' · ' + p.flat : ''}` }))
  );
  modal({
    title: 'Assign volunteers',
    body: el('div', {},
      available.length
        ? field('Pick people (Ctrl/⌘ + click for multiple)', sel)
        : el('p', { class: 'sub', text: 'Everyone in the People directory is already on this activity. Add more people from the People tab.' }),
      el('div', { style: 'text-align:center;margin:10px 0;color:var(--muted);font-weight:800', text: '— or —' }),
      el('a', { class: 'btn btn-ghost btn-block', href: `#/e/${evt.id}/operations/people` }, '＋ Add a new person to the directory')
    ),
    actions: [
      { label: 'Cancel', close: true },
      { label: 'Add selected', onClick: (close) => {
        const picked = Array.from(sel.selectedOptions).map(o => o.value);
        if (!picked.length) { close(); return; }
        const next = [...new Set([...(activity.volunteer_ids || []), ...picked])];
        upsertActivity(evt.id, { ...activity, volunteer_ids: next }, user);
        close();
        toast(`${picked.length} volunteer${picked.length === 1 ? '' : 's'} added.`, 'ok');
        navigate('/e/' + evt.id + '/operations/activity/' + activity.id);
      } }
    ]
  });
}

/* ---------- People directory (Phase 2 seed) ---------- */

function renderPeoplePanel(evt, doc, user, caps) {
  const wrap = el('div', {});
  wrap.append(el('section', { class: 'card card-pad' },
    el('div', { class: 'row row-between', style: 'align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px' },
      el('div', {},
        el('h3', { style: 'margin:0', text: '📇 People directory' }),
        el('small', { class: 'sub', text: 'Reusable people for owners, leads, and volunteers. Contact info stays private to this event.' })
      ),
      caps.opsPeople ? el('button', { class: 'btn btn-sm', on: { click: () => openPersonModal(evt, doc, null, user) } }, '＋ Add person') : null
    ),
    doc.people.length
      ? el('div', { class: 'tvh-ops-people-grid' },
          ...doc.people.map(p => renderPersonCard(evt, doc, p, user, caps))
        )
      : el('p', { class: 'sub', text: 'No people added yet. Start by adding the event owner and the cultural lead.' })
  ));
  return wrap;
}

function renderPersonCard(evt, doc, p, user, caps) {
  const roles = [];
  for (const o of doc.ownership) if (o.person_id === p.id) roles.push('👑 ' + o.area);
  for (const a of doc.activities) {
    if (a.primary_lead_id === p.id) roles.push(`⭐ ${a.title} · primary`);
    else if (a.co_lead_id === p.id) roles.push(`⭐ ${a.title} · co-lead`);
    else if ((a.volunteer_ids || []).includes(p.id)) roles.push(`🤝 ${a.title}`);
  }
  return el('article', { class: 'tvh-ops-person-card' },
    el('div', { class: 'row', style: 'gap:10px;align-items:center' },
      el('div', { class: 'tvh-ops-avatar', text: initialsOf(p.name) }),
      el('div', { style: 'min-width:0;flex:1' },
        el('div', { class: 'tvh-ops-owner-name', text: p.name }),
        el('small', { class: 'sub', text: p.flat ? '🏠 ' + p.flat : 'Flat not set' })
      ),
      caps.opsPeople ? el('button', { class: 'tvh-ops-icon-btn', title: 'Edit', on: { click: () => openPersonModal(evt, doc, p, user) } }, '✎') : null
    ),
    (caps.opsManage && p.mobile) ? el('small', { class: 'sub', style: 'display:block;margin-top:4px', text: '📞 ' + p.mobile }) : null,
    roles.length ? el('ul', { class: 'tvh-ops-person-roles' }, ...roles.slice(0, 6).map(r => el('li', { text: r }))) : null,
  );
}

function openPersonModal(evt, doc, existing, user) {
  const entry = existing ? { ...existing } : { name: '', flat: '', mobile: '', email: '' };
  const nameInp   = el('input', { type: 'text', value: entry.name, required: '', placeholder: 'e.g. Rahul Jain' });
  const flatInp   = el('input', { type: 'text', value: entry.flat, placeholder: 'e.g. A-203' });
  const mobileInp = el('input', { type: 'tel',  value: entry.mobile, inputmode: 'numeric', maxlength: '10', placeholder: '10-digit mobile' });
  const emailInp  = el('input', { type: 'email', value: entry.email, placeholder: 'optional' });
  modal({
    title: existing ? 'Edit person' : 'Add person',
    body: el('div', {},
      field('Name', nameInp),
      field('Flat / House', flatInp),
      field('Mobile', mobileInp),
      field('Email (optional)', emailInp),
      el('small', { class: 'sub', text: 'Mobile and email are visible only to committee roles.' })
    ),
    actions: [
      { label: 'Cancel', close: true },
      existing ? { label: 'Remove', kind: 'btn-emerg', onClick: (close) => {
        if (!confirm('Remove this person from the event? Their assignments will be cleared.')) return;
        removePerson(evt.id, existing.id, user);
        close();
        toast('Person removed.', 'ok');
        navigate('/e/' + evt.id + '/operations/people');
      } } : null,
      { label: existing ? 'Save' : 'Add person', onClick: (close) => {
        try {
          upsertPerson(evt.id, {
            id: entry.id,
            name: nameInp.value.trim(),
            flat: flatInp.value.trim(),
            mobile: mobileInp.value.trim(),
            email: emailInp.value.trim(),
          }, user);
        } catch (err) { toast(err.message || 'Save failed', 'err'); return; }
        close();
        toast(existing ? 'Person updated.' : 'Person added.', 'ok');
        navigate('/e/' + evt.id + '/operations/people');
      } }
    ].filter(Boolean),
  });
}

/* ---------- 7-Day visual plan (Slice 2, Phase 3) ---------- */

// Morning 06:00-11:59, Afternoon 12:00-17:59, Evening 18:00-23:59.
// Activities without a start_time fall into "Anytime" so a coordinator
// still sees them on the day they own.
function timeBucket(t) {
  if (!t) return 'anytime';
  const h = parseInt(String(t).slice(0, 2), 10);
  if (!Number.isFinite(h)) return 'anytime';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}
const RAILS = [
  { id: 'morning',   label: '🌅 Morning',   sub: '6 AM – 12 PM' },
  { id: 'afternoon', label: '☀ Afternoon', sub: '12 PM – 6 PM' },
  { id: 'evening',   label: '🌙 Evening',   sub: '6 PM – Midnight' },
  { id: 'anytime',   label: '⏱ Anytime',    sub: 'no time set' },
];

function renderPlanPanel(evt, doc, user, caps, params) {
  if (!caps.opsTimelineOn) {
    return el('section', { class: 'card card-pad' },
      el('h3', { style: 'margin:0 0 4px', text: '📅 7-Day plan' }),
      el('small', { class: 'sub', text: 'Timeline is disabled for this event (operations.timeline is off). Enable it in the event feature toggles.' })
    );
  }
  const daysTotal = countDays(evt);
  const wantedDay = Math.min(Math.max(1, Number(params.get('day')) || 1), daysTotal);

  const dayStrip = el('div', { class: 'tvh-ops-day-pills' },
    ...Array.from({ length: daysTotal }, (_, i) => {
      const day = i + 1;
      const dayActs = doc.activities.filter(a => (a.days || []).includes(day));
      const attention = dayActs.some(a => !a.primary_lead_id || !a.co_lead_id);
      return el('a', {
        class: 'tvh-ops-day-btn' + (day === wantedDay ? ' active' : ''),
        href: `#/e/${evt.id}/operations/plan?day=${day}`,
      },
        el('div', { class: 'tvh-ops-day-btn-num', text: 'DAY ' + day }),
        el('div', { class: 'tvh-ops-day-btn-date', text: dayLabel(evt, day) || '—' }),
        el('div', { class: 'tvh-ops-day-btn-meta', text: dayActs.length + (dayActs.length === 1 ? ' activity' : ' activities') }),
        attention ? el('span', { class: 'tvh-ops-day-btn-dot', title: 'Needs attention', text: '●' }) : null
      );
    })
  );

  const dayActs = doc.activities
    .filter(a => (a.days || []).includes(wantedDay))
    .slice()
    .sort((x, y) => String(x.start_time || 'z').localeCompare(String(y.start_time || 'z')));

  const rails = RAILS.map(r => {
    const bucket = dayActs.filter(a => timeBucket(a.start_time) === r.id);
    if (r.id === 'anytime' && !bucket.length) return null;
    return el('div', { class: 'tvh-ops-rail' },
      el('div', { class: 'tvh-ops-rail-head' },
        el('div', { class: 'tvh-ops-rail-label', text: r.label }),
        el('small', { class: 'sub', text: r.sub })
      ),
      bucket.length
        ? el('div', { class: 'tvh-ops-rail-body' },
            ...bucket.map(a => renderTimelineActivity(evt, doc, a))
          )
        : el('small', { class: 'sub', style: 'display:block;margin-top:6px', text: 'Nothing scheduled.' })
    );
  }).filter(Boolean);

  return el('section', { class: 'card card-pad' },
    el('div', { class: 'row row-between', style: 'align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:8px' },
      el('div', {},
        el('h3', { style: 'margin:0', text: '📅 Day ' + wantedDay + ' plan' }),
        el('small', { class: 'sub', text: dayLabel(evt, wantedDay) || 'No date set' })
      ),
      caps.opsManage ? el('a', { class: 'btn btn-sm btn-ghost', href: `#/e/${evt.id}/operations/activities` }, '＋ Add activity') : null
    ),
    dayStrip,
    el('div', { class: 'tvh-ops-rails' }, ...rails),
    !dayActs.length ? el('p', { class: 'sub', style: 'margin-top:12px', text: 'No activities scheduled for this day. Add one from the Activities tab and tick this day in the day picker.' }) : null
  );
}

function renderTimelineActivity(evt, doc, a) {
  const primary = findPerson(doc, a.primary_lead_id);
  const coLead  = findPerson(doc, a.co_lead_id);
  const vols = (a.volunteer_ids || []).length;
  return el('a', { class: 'tvh-ops-timeline-card', href: `#/e/${evt.id}/operations/activity/${a.id}` },
    el('div', { class: 'tvh-ops-timeline-time', text: a.start_time || '—' }),
    el('div', { class: 'tvh-ops-timeline-body' },
      el('div', { class: 'row', style: 'gap:8px;align-items:center' },
        el('span', { class: 'tvh-ops-activity-icon', style: 'width:28px;height:28px;font-size:16px', text: a.icon || '🎯' }),
        el('span', { class: 'tvh-ops-activity-title', text: a.title })
      ),
      a.location ? el('small', { class: 'sub', text: '📍 ' + a.location }) : null,
      el('div', { class: 'tvh-ops-activity-leads' },
        leadChip('Primary', primary),
        leadChip('Co-lead', coLead),
        el('span', { class: 'tvh-ops-vol-chip', text: '👥 ' + vols })
      )
    ),
    el('span', { class: 'pill ' + statusPillClass(a.status), text: OPS_STATUS_LABEL[a.status] || a.status })
  );
}

/* ---------- Matrix (Slice 3, Phase 4) ---------- */

function renderMatrixPanel(evt, doc, user, caps, params) {
  if (!caps.opsMatrixOn) {
    return el('section', { class: 'card card-pad' },
      el('h3', { style: 'margin:0 0 4px', text: '🗂 Responsibility matrix' }),
      el('small', { class: 'sub', text: 'Matrix is disabled for this event (operations.matrix is off). Enable it in the event feature toggles.' })
    );
  }
  const daysTotal = countDays(evt);
  const fDay      = String(params.get('day') || '');       // '' | '1'..'N'
  const fCat      = String(params.get('cat') || '');       // '' | category id
  const fStatus   = String(params.get('status') || '');    // '' | ready | in_progress | attention | planned | confirmed
  const fGap      = String(params.get('gap') || '');       // '' | lead | volunteers
  const fOwner    = String(params.get('owner') || '');     // '' | ownership id

  const allRows = doc.activities.map(a => ({
    a,
    owner: doc.ownership.find(o => o.id === a.owner_id),
    primary: findPerson(doc, a.primary_lead_id),
    co: findPerson(doc, a.co_lead_id),
    vols: (a.volunteer_ids || []).length,
  }));

  const rows = allRows.filter(r => {
    if (fDay && !(r.a.days || []).includes(Number(fDay))) return false;
    if (fCat && r.a.category !== fCat) return false;
    if (fStatus && r.a.status !== fStatus) return false;
    if (fGap === 'lead' && r.a.primary_lead_id && r.a.co_lead_id) return false;
    if (fGap === 'volunteers' && r.vols > 0) return false;
    if (fOwner && r.a.owner_id !== fOwner) return false;
    return true;
  });

  const cats  = (doc.categories && doc.categories.length ? doc.categories : []);
  const owners = doc.ownership || [];

  const filterUrl = (patch) => {
    const p = new URLSearchParams();
    const merged = { day: fDay, cat: fCat, status: fStatus, gap: fGap, owner: fOwner, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const qs = p.toString();
    return `#/e/${evt.id}/operations/matrix${qs ? '?' + qs : ''}`;
  };

  const chip = (label, active, url) =>
    el('a', { class: 'tvh-ops-filter-chip' + (active ? ' active' : ''), href: url }, label);

  const dayFilter = el('div', { class: 'tvh-ops-filter-row' },
    el('span', { class: 'tvh-ops-filter-label', text: 'Day' }),
    chip('All', !fDay, filterUrl({ day: '' })),
    ...Array.from({ length: daysTotal }, (_, i) => {
      const d = String(i + 1);
      return chip('D' + d, fDay === d, filterUrl({ day: d }));
    })
  );

  const catFilter = cats.length ? el('div', { class: 'tvh-ops-filter-row' },
    el('span', { class: 'tvh-ops-filter-label', text: 'Category' }),
    chip('All', !fCat, filterUrl({ cat: '' })),
    ...cats.map(c => chip((c.icon ? c.icon + ' ' : '') + (c.label || c.id), fCat === c.id, filterUrl({ cat: c.id })))
  ) : null;

  const statusOpts = [
    { id: 'planned',     label: 'Planned' },
    { id: 'confirmed',   label: 'Confirmed' },
    { id: 'ready',       label: 'Ready' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'attention',   label: 'Attention' },
  ];
  const statusFilter = el('div', { class: 'tvh-ops-filter-row' },
    el('span', { class: 'tvh-ops-filter-label', text: 'Status' }),
    chip('All', !fStatus, filterUrl({ status: '' })),
    ...statusOpts.map(s => chip(s.label, fStatus === s.id, filterUrl({ status: s.id })))
  );

  const gapFilter = el('div', { class: 'tvh-ops-filter-row' },
    el('span', { class: 'tvh-ops-filter-label', text: 'Gaps' }),
    chip('All', !fGap, filterUrl({ gap: '' })),
    chip('⚠ Missing lead', fGap === 'lead', filterUrl({ gap: 'lead' })),
    chip('👥 No volunteers', fGap === 'volunteers', filterUrl({ gap: 'volunteers' }))
  );

  const ownerFilter = owners.length ? el('div', { class: 'tvh-ops-filter-row' },
    el('span', { class: 'tvh-ops-filter-label', text: 'Owner' }),
    chip('All', !fOwner, filterUrl({ owner: '' })),
    ...owners.map(o => chip(o.area || o.name || '(unnamed)', fOwner === o.id, filterUrl({ owner: o.id })))
  ) : null;

  const anyFilter = fDay || fCat || fStatus || fGap || fOwner;

  return el('section', { class: 'card card-pad' },
    el('div', { class: 'row row-between', style: 'align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:6px' },
      el('div', {},
        el('h3', { style: 'margin:0', text: '🗂 Responsibility matrix' }),
        el('small', { class: 'sub', text: `Showing ${rows.length} of ${allRows.length} activities` })
      ),
      anyFilter ? el('a', { class: 'btn btn-sm btn-ghost', href: `#/e/${evt.id}/operations/matrix`, text: '✕ Clear filters' }) : null
    ),
    el('div', { class: 'tvh-ops-filter-bar' },
      dayFilter,
      catFilter,
      statusFilter,
      gapFilter,
      ownerFilter
    ),
    rows.length
      ? el('div', { class: 'tvh-ops-matrix-scroll' },
          el('table', { class: 'table' },
            el('thead', {}, el('tr', {},
              el('th', { text: 'Activity' }),
              el('th', { text: 'Day' }),
              el('th', { text: 'Owner area' }),
              el('th', { text: 'Primary lead' }),
              el('th', { text: 'Co-lead' }),
              el('th', { class: 'num', text: 'Volunteers' }),
              el('th', { text: 'Status' })
            )),
            el('tbody', {}, ...rows.map(r => el('tr', {},
              el('td', {}, el('a', { href: `#/e/${evt.id}/operations/activity/${r.a.id}`, text: (r.a.icon || '') + ' ' + r.a.title })),
              el('td', { text: (r.a.days || []).map(d => 'D' + d).join(', ') || '—' }),
              el('td', { text: r.owner ? (r.owner.area || r.owner.name || '—') : '—' }),
              el('td', {}, r.primary
                ? el('span', { text: r.primary.name })
                : el('span', { class: 'tvh-ops-gap', text: '⚠ Not assigned' })),
              el('td', {}, r.co
                ? el('span', { text: r.co.name })
                : el('span', { class: 'tvh-ops-gap', text: '⚠ Not assigned' })),
              el('td', { class: 'num' }, r.vols === 0
                ? el('span', { class: 'tvh-ops-gap', text: '0' })
                : el('span', { text: String(r.vols) })),
              el('td', {}, el('span', { class: 'pill ' + statusPillClass(r.a.status), text: OPS_STATUS_LABEL[r.a.status] || r.a.status }))
            )))
          )
        )
      : el('p', { class: 'sub', style: 'margin-top:8px', text: anyFilter ? 'No activities match the selected filters.' : 'Add activities to populate the matrix.' })
  );
}

/* ---------- shared helpers ---------- */

function kpi(k, v, hint) {
  return el('div', { class: 'card stat tvh-ops-kpi' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: v }),
    hint ? el('small', { class: 'sub', text: hint }) : null
  );
}

function healthBar(label, count, cls) {
  const bars = '█'.repeat(Math.min(20, count));
  return el('div', { class: 'tvh-ops-health-row' },
    el('span', { class: 'tvh-ops-health-label', text: label }),
    el('span', { class: 'tvh-ops-health-fill ' + cls, text: bars || '·' }),
    el('span', { class: 'tvh-ops-health-count', text: String(count) })
  );
}

function leadChip(label, person) {
  return el('span', { class: 'tvh-ops-lead-chip', title: label },
    el('span', { class: 'tvh-ops-avatar tvh-ops-avatar-sm', text: person ? initialsOf(person.name) : '?' }),
    el('span', { text: person ? person.name : (label + ' —') })
  );
}

function statusPillClass(s) {
  if (s === OPS_STATUS.READY) return 'pill-sage';
  if (s === OPS_STATUS.IN_PROGRESS) return 'pill-gold';
  if (s === OPS_STATUS.ATTENTION) return 'pill-muted';
  return 'pill-muted';
}

function categoryLabel(doc, id) {
  const c = (doc.categories || DEFAULT_CATEGORIES).find(x => x.id === id);
  return c ? (c.icon + ' ' + c.label) : id;
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function field(labelText, node, opts) {
  const wrap = el('div', { class: 'field' + (opts && opts.grow === 0 ? ' field-shrink' : '') },
    el('label', { text: labelText }),
    node
  );
  if (opts && opts.grow === 1) wrap.style.flex = '1';
  return wrap;
}

function renderPersonPicker(doc, selected, opts = {}) {
  const sel = el('select', {},
    el('option', { value: '', text: opts.placeholder || '— pick person —' }),
    ...(doc.people || []).map(p => el('option', { value: p.id, selected: selected === p.id, text: `${p.name}${p.flat ? ' · ' + p.flat : ''}` }))
  );
  return sel;
}

function renderDayPicker(evt, current) {
  const total = countDays(evt);
  const wrap = el('div', { class: 'tvh-ops-day-picker' });
  const checks = [];
  for (let i = 1; i <= total; i++) {
    const inp = el('input', { type: 'checkbox', value: String(i), checked: current.includes(i) });
    checks.push(inp);
    wrap.append(el('label', { class: 'tvh-ops-day-pill' }, inp, el('span', { text: 'Day ' + i })));
  }
  return {
    wrap,
    selectedDays() { return checks.filter(c => c.checked).map(c => Number(c.value)); },
  };
}

function countDays(evt) {
  if (!evt.start_at || !evt.end_at) return 7;
  const s = new Date(evt.start_at);
  const e = new Date(evt.end_at);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 7;
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
}

function dayLabel(evt, day) {
  if (!evt.start_at) return '';
  const d = new Date(evt.start_at);
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + (day - 1));
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
