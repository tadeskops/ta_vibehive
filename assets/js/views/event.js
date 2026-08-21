/* Event detail view — public read-only + admin edit tabs. */
'use strict';
import { el, mount, fmtDate, fmtINR, daysLeft, toast, modal } from '../dom.js';
import { findEvent, totalFor, verifiedCount, publicBoardFor, saveEvent, STATUS, contribsFor } from '../events.js';
import { catalog, isEventOn, validateEventFeatures } from '../features.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { navigate } from '../router.js';

export async function render(root, { match }) {
  const evt = findEvent(match.id);
  if (!evt) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Event not found.' })));
  const user = session();
  const mode = match.mode || 'view';
  const canEdit = await can(user, 'events.edit.own');
  const canPublish = await can(user, 'events.publish');
  const canClose = await can(user, 'events.close');
  const canVerify = await can(user, 'contributions.verify');

  if (mode === 'edit' && canEdit) return renderEdit(root, evt, user, { canPublish, canClose });
  if (mode === 'manage' && canVerify) return renderManage(root, evt, user);

  const hero = el('section', { class: 'hero', style: heroBg(evt) },
    el('div', { class: 'row row-between' },
      el('div', {},
        el('div', { class: 'pill', text: evt.glyph + ' ' + evt.template.toUpperCase() }),
        el('h1', { text: evt.title }),
        el('p', { class: 'sub', text: evt.purpose || 'Community event created by the committee.' })
      ),
      el('div', { class: 'row' },
        canEdit ? el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}/edit` }, 'Edit') : null,
        canVerify ? el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}/manage` }, 'Manage') : null,
        evt.status === STATUS.PUBLISHED && await isEventOn('contribution.voluntary', evt) ? el('a', { class: 'btn', href: `#/e/${evt.id}/contribute` }, 'Contribute') : null,
        evt.status === STATUS.PUBLISHED && await isEventOn('registration.on', evt) ? el('a', { class: 'btn btn-sage', href: `#/e/${evt.id}/register` }, 'Register') : null
      )
    )
  );

  const showProgress = await isEventOn('reporting.progress', evt);
  const showBoard = await isEventOn('privacy.public_board', evt);
  const hideAmount = await isEventOn('privacy.amount_hidden', evt);
  const goal = evt.goal || 0;
  const total = totalFor(evt.id);
  const pct = goal ? Math.min(100, Math.round((total / goal) * 100)) : 0;
  const dl = daysLeft(evt.end_at);

  const stats = el('div', { class: 'grid grid-4' },
    goal ? statCard('Goal', fmtINR(goal)) : null,
    statCard('Raised', fmtINR(total)),
    statCard('Contributors', String(verifiedCount(evt.id))),
    dl != null ? statCard('Time left', dl > 0 ? `${dl} days` : 'Closes today') : null
  );

  const progress = (showProgress && goal) ? el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { text: 'Progress' }),
    el('div', { class: 'progress' }, el('i', { style: { width: pct + '%' } })),
    el('div', { class: 'progress-meta' }, el('span', { text: fmtINR(total) + ' raised' }), el('span', { text: pct + '% of goal' }))
  ) : null;

  const board = showBoard ? renderPublicBoard(evt, hideAmount) : null;
  const featurePanel = await renderEnabledFeaturePanel(evt);

  mount(root, hero, stats, progress, featurePanel, board);
}

function heroBg(evt) {
  if (evt.hero_class === 'sage') return 'background:linear-gradient(120deg,#dbeacc,#b9d4a4)';
  if (evt.hero_class === 'gold') return 'background:linear-gradient(120deg,#f7dfad,#e6c078)';
  if (evt.hero_class === 'emerg') return 'background:linear-gradient(120deg,#f2c9c1,#e59d92)';
  return '';
}

function statCard(k, v) {
  return el('div', { class: 'card stat' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: v })
  );
}

function renderPublicBoard(evt, hideAmount) {
  const rows = publicBoardFor(evt.id);
  const body = el('table', { class: 'table' },
    el('thead', {}, el('tr', {}, el('th', { text: 'When' }), el('th', { text: 'Contributor' }), el('th', { text: 'Flat' }), el('th', { class: 'num', text: 'Amount' }))),
    el('tbody', {}, ...(rows.length ? rows.slice(0, 20).map(r => el('tr', {},
      el('td', { text: fmtDate(r.when) }),
      el('td', { text: r.name }),
      el('td', { text: r.flat }),
      el('td', { class: 'num', text: (r.amount == null || hideAmount) ? '—' : fmtINR(r.amount) })
    )) : [el('tr', {}, el('td', { colspan: 4, text: 'No verified contributions yet.', style: 'text-align:center;color:var(--muted)' }))]))
  );
  return el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { text: '🌸 Contributor board' }),
    body
  );
}

async function renderEnabledFeaturePanel(evt) {
  const cat = await catalog();
  const enabled = cat.features.filter(f => f.scope === 'event' && !!evt.features[f.id]);
  if (!enabled.length) return null;
  const grouped = new Map();
  for (const f of enabled) {
    const arr = grouped.get(f.cluster) || [];
    arr.push(f); grouped.set(f.cluster, arr);
  }
  return el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { text: 'Enabled modules' }),
    el('p', { class: 'sub', text: 'Only these features are active for this event. Everything else is hidden.' }),
    el('div', { class: 'grid grid-3' },
      ...Array.from(grouped.entries()).map(([cluster, feats]) => el('div', { class: 'panel', style: 'margin:0' },
        el('h4', { text: labelForCluster(cat, cluster) }),
        ...feats.map(f => el('div', { class: 'feature-row' },
          el('span', { class: 'name', text: f.label }),
          el('span', { class: 'pill pill-sage', text: 'ON' })
        ))
      ))
    )
  );
}
function labelForCluster(cat, id) { const c = cat.clusters.find(x => x.id === id); return c ? c.label : id; }

/* ---------- edit view ---------- */
async function renderEdit(root, evt, user, caps) {
  const cat = await catalog();
  const form = el('form', { class: 'card card-pad', on: { submit: e => e.preventDefault() } });

  const titleI = field('title', 'Event title', el('input', { type: 'text', value: evt.title, required: true }));
  const purposeI = field('purpose', 'Purpose (1-line)', el('input', { type: 'text', value: evt.purpose || '' }));
  const goalI = field('goal', 'Goal (₹)', el('input', { type: 'number', value: String(evt.goal || 0), min: '0' }));
  const startI = field('start', 'Start date', el('input', { type: 'date', value: evt.start_at || '' }));
  const endI = field('end', 'End / deadline', el('input', { type: 'date', value: evt.end_at || '' }));
  const capI = field('cap', 'Capacity', el('input', { type: 'number', value: String(evt.capacity || 0), min: '0' }));
  const fixedI = field('fixed', 'Fixed amount (₹, if applicable)', el('input', { type: 'number', value: String(evt.fixed_amount || 0), min: '0' }));

  const clusters = cat.clusters.filter(c => cat.features.some(f => f.cluster === c.id && f.scope === 'event'));
  const featureChecks = new Map();
  const featurePanel = el('section', { style: 'margin-top:14px' }, el('h3', { text: 'Feature configuration' }),
    ...clusters.map(cl => el('div', { class: 'panel' },
      el('h4', { text: cl.label }),
      ...cat.features.filter(f => f.cluster === cl.id && f.scope === 'event').map(f => {
        const on = evt.features[f.id] === undefined ? !!f.default : !!evt.features[f.id];
        const cb = el('input', { type: 'checkbox', checked: on });
        featureChecks.set(f.id, cb);
        return el('label', { class: 'check-row' }, cb, el('span', {}, el('div', { class: 'name', text: f.label }), (f.depends_on || []).length ? el('small', { text: 'depends on: ' + f.depends_on.join(', ') }) : null));
      })
    ))
  );

  const statusSel = el('select', {},
    ...Object.values(STATUS).map(s => el('option', { value: s, selected: evt.status === s, text: s.charAt(0).toUpperCase() + s.slice(1) }))
  );

  const actions = el('div', { class: 'row row-between', style: 'margin-top:16px' },
    el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}` }, 'Cancel'),
    el('div', { class: 'row' },
      el('span', { text: 'Status:' }),
      statusSel,
      el('button', { class: 'btn', on: { click: async () => {
        const updated = {
          ...evt,
          title: titleI.querySelector('input').value.trim() || evt.title,
          purpose: purposeI.querySelector('input').value.trim(),
          goal: Number(goalI.querySelector('input').value || 0),
          start_at: startI.querySelector('input').value || evt.start_at,
          end_at: endI.querySelector('input').value || evt.end_at,
          capacity: Number(capI.querySelector('input').value || 0),
          fixed_amount: Number(fixedI.querySelector('input').value || 0),
          features: Object.fromEntries(Array.from(featureChecks.entries()).map(([k, cb]) => [k, cb.checked])),
          status: statusSel.value,
        };
        const errs = await validateEventFeatures(updated.features);
        if (errs.length) { toast(`Fix dependencies: ${errs[0].id} needs ${errs[0].missing}`, 'err'); return; }
        if (updated.status === STATUS.PUBLISHED && !caps.canPublish) { toast('You cannot publish. Ask Management Committee.', 'err'); return; }
        if (updated.status === STATUS.CLOSED && !caps.canClose) { toast('Only Management Committee can close.', 'err'); return; }
        saveEvent(updated, user);
        toast('Event saved', 'ok');
        navigate('/e/' + updated.id);
      } } }, 'Save event')
    )
  );

  form.append(el('h2', { text: 'Edit event' }),
    el('div', { class: 'grid grid-2' }, titleI, purposeI, goalI, capI, startI, endI, fixedI),
    featurePanel,
    actions
  );
  mount(root, form);
}

function field(id, label, input) {
  return el('div', { class: 'field' }, el('label', { for: id, text: label }), input);
}

/* ---------- manage / verify view ---------- */
async function renderManage(root, evt, user) {
  const items = contribsFor(evt.id);
  const head = el('section', { class: 'card card-pad' },
    el('h2', { text: 'Manage · ' + evt.title }),
    el('p', { class: 'sub', text: 'Verify or void contributions. Verified contributions immediately mint a stamped receipt.' })
  );
  const tbl = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'When' }),
      el('th', { text: 'Contributor' }),
      el('th', { text: 'Flat' }),
      el('th', { text: 'Method' }),
      el('th', { class: 'num', text: 'Amount' }),
      el('th', { text: 'Status' }),
      el('th', { text: 'Actions' })
    )),
    el('tbody', {}, ...(items.length ? items.map(c => contribRow(c, evt, user)) : [el('tr', {}, el('td', { colspan: 7, text: 'No contributions yet.', style: 'text-align:center;color:var(--muted)' }))]))
  );
  mount(root, head, el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' }, tbl));
}

function contribRow(c, evt, user) {
  const tr = el('tr', {},
    el('td', { text: fmtDate(c.created_at) }),
    el('td', { text: c.anonymous ? 'Anonymous' : (c.contributor_name || '—') }),
    el('td', { text: c.anonymous ? '' : (c.flat || '') }),
    el('td', { text: c.method || '—' }),
    el('td', { class: 'num', text: fmtINR(c.amount) }),
    el('td', {}, el('span', { class: 'pill ' + (c.status === 'verified' ? 'pill-sage' : c.status === 'void' ? 'pill-muted' : ''), text: c.status })),
    el('td', {}, el('div', { class: 'row' },
      c.status === 'pending' ? el('button', { class: 'btn btn-sm', on: { click: async () => {
        const mod = await import('../events.js'); const rec = await import('../receipts.js');
        const verified = mod.verifyContribution(c.id, user);
        await rec.attachReceipt(verified);
        toast('Verified & receipt minted', 'ok');
        renderManage(document.getElementById('main'), evt, user);
      } } }, 'Verify') : null,
      c.status !== 'void' ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => {
        modal({
          title: 'Void contribution?',
          body: el('p', { text: 'This marks the record as void. The receipt (if any) will be invalidated.' }),
          actions: [
            { label: 'Cancel', close: true },
            { label: 'Void', kind: 'btn-emerg', onClick: async (close) => {
              const mod = await import('../events.js');
              mod.voidContribution(c.id, user, 'manual');
              close(); toast('Voided', 'ok');
              renderManage(document.getElementById('main'), evt, user);
            } }
          ]
        });
      } } }, 'Void') : null,
      c.receipt ? el('a', { class: 'btn btn-sm btn-ghost', href: `#/receipt/${c.id}` }, 'Receipt') : null
    ))
  );
  return tr;
}
