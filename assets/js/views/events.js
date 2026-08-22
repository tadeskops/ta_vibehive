/* Events index — public list + creation entrypoint for authorised roles. */
'use strict';
import { el, mount, fmtDate, fmtINR } from '../dom.js';
import { state } from '../store.js';
import { totalFor, verifiedCount, listTemplates, newEventFromTemplate, saveEvent, STATUS } from '../events.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { navigate } from '../router.js';
import { toast } from '../dom.js';
import { eventCard } from './home.js';

export async function render(root) {
  const user = session();
  const canCreate = await can(user, 'events.create');
  const canVerify = await can(user, 'contributions.verify');
  /* Draft / Review / Archived are back-of-house. Residents only see
   * PUBLISHED (accepting contributions) and CLOSED (past events -
   * they can still see the outcome). Anyone with create-or-verify
   * access sees everything so the pipeline is discoverable. */
  const canSeeAll = canCreate || canVerify;
  const all = state.events().slice().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const events = canSeeAll ? all : all.filter(e => e.status === STATUS.PUBLISHED || e.status === STATUS.CLOSED);

  const head = el('div', { class: 'row row-between', style: 'margin-bottom:18px' },
    el('div', {},
      el('h1', { text: 'Community events' }),
      el('p', { class: 'sub', text: 'Every event is created by the committee. Nothing is hard-coded.' })
    ),
    canCreate ? el('button', { class: 'btn', on: { click: () => openTemplatePicker(user) } }, '＋ New event') : null
  );

  const grouped = groupBy(events, e => e.status);
  const sections = [];
  const order = canSeeAll
    ? [STATUS.PUBLISHED, STATUS.REVIEW, STATUS.DRAFT, STATUS.CLOSED, STATUS.ARCHIVED]
    : [STATUS.PUBLISHED, STATUS.CLOSED];
  for (const st of order) {
    const list = grouped.get(st) || [];
    if (!list.length) continue;
    sections.push(el('section', { style: 'margin-top:26px' },
      el('div', { class: 'row row-between' },
        el('h3', { text: labelForStatus(st) }),
        el('span', { class: 'pill pill-muted', text: `${list.length}` })
      ),
      el('div', { class: 'grid grid-3', style: 'margin-top:12px' },
        ...list.map(evt => (st === STATUS.PUBLISHED || st === STATUS.CLOSED) ? eventCard(evt) : adminRow(evt, user))
      )
    ));
  }

  if (!events.length) sections.push(el('div', { class: 'card card-pad' },
    el('h3', { text: 'No events yet.' }),
    el('p', { class: 'sub', text: canCreate ? 'Click "New event" to pick a template.' : 'Ask a committee member to create the first event.' })
  ));

  mount(root, head, ...sections);

  /* Deep-link from the mobile "+" sheet: if the user tapped "Create a
   * new event", sessionStorage carries a one-shot flag that pops the
   * template picker straight away. Consumed + cleared here. */
  try {
    if (canCreate && sessionStorage.getItem('tvh:new-event') === '1') {
      sessionStorage.removeItem('tvh:new-event');
      setTimeout(() => openTemplatePicker(user), 60);
    }
  } catch (_e) { /* private mode / quota - ignore */ }
}

function labelForStatus(s) {
  return ({ draft: 'Drafts', review: 'Under review', published: 'Live now', closed: 'Recently closed', archived: 'Archived' })[s] || s;
}

function adminRow(evt, user) {
  return el('article', { class: 'card card-content' },
    el('div', { class: 'row row-between' },
      el('div', {},
        el('h3', { class: 'card-title', text: evt.glyph + ' ' + evt.title }),
        el('p', { class: 'card-sub', text: `Template: ${evt.template} · Updated ${fmtDate(evt.updated_at)}` })
      ),
      el('div', { class: 'row' },
        el('span', { class: 'pill pill-muted', text: evt.status }),
        el('a', { class: 'btn btn-sm btn-ghost', href: `#/e/${evt.id}/edit` }, 'Edit'),
        el('a', { class: 'btn btn-sm', href: `#/e/${evt.id}` }, 'Open')
      )
    )
  );
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

async function openTemplatePicker(user) {
  const tpls = await listTemplates();
  const back = el('div', { class: 'modal-back' });
  const close = () => back.remove();
  /* Guard against a double-click / rapid-fire tap creating two draft
   * events for the same template. Without this the picker fires
   * `newEventFromTemplate` twice (Date.now() is only ms-precision so
   * the two drafts share a slug), which shows up on the dashboard as
   * mysteriously duplicated tiles. */
  let creating = false;
  const cards = el('div', { class: 'grid grid-2', style: 'margin-top:8px' },
    ...tpls.map(t => el('button', { class: 'card card-content', style: 'text-align:left;cursor:pointer', on: { click: async (e) => {
      if (creating) return;
      creating = true;
      try {
        const btn = e.currentTarget;
        if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
        const evt = await newEventFromTemplate(t.id, user);
        saveEvent(evt, user);
        close();
        toast('Draft created', 'ok');
        navigate('/e/' + evt.id + '/edit');
      } catch (err) {
        creating = false;
        toast(err && err.message ? err.message : 'Could not create draft', 'err');
      }
    } } },
      el('div', { class: 'row', style: 'font-size:32px' }, t.glyph),
      el('h3', { class: 'card-title', text: t.label }),
      el('p', { class: 'card-sub', text: (t.examples || []).slice(0, 3).join(' · ') })
    ))
  );
  const box = el('div', { class: 'modal', style: 'max-width:720px' },
    el('div', { class: 'modal-head' },
      el('h3', { text: 'Choose a template' }),
      el('button', { class: 'x-close', on: { click: close } }, '×')
    ),
    el('div', { class: 'modal-body' },
      el('p', { class: 'sub', text: 'Each template pre-configures a feature set. You can override anything per event.' }),
      cards
    )
  );
  back.append(box);
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.body.append(back);
}
