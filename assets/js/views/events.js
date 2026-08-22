/* Events index — public list + creation entrypoint for authorised roles. */
'use strict';
import { el, mount, fmtDate, fmtINR } from '../dom.js';
import { state } from '../store.js';
import { totalFor, verifiedCount, listTemplates, newEventFromTemplate, saveEvent, STATUS, publicEvents } from '../events.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { navigate } from '../router.js';
import { toast } from '../dom.js';
import { eventCard, shouldMaskPublic } from './home.js';

export async function render(root) {
  const user = session();
  const canCreate  = await can(user, 'events.create');
  const canPropose = await can(user, 'events.propose');
  const canApprove = await can(user, 'events.approve');
  const canVerify  = await can(user, 'contributions.verify');
  /* Public-mask overlay: applied ONLY to the anonymous public cards
   * below (published / closed). Committee/admin rows never mask
   * because they need the full information to manage the pipeline. */
  const masked = await shouldMaskPublic(user);
  /* Draft / Review / Archived are back-of-house. Residents only see
   * PUBLISHED (accepting contributions) and CLOSED (past events -
   * they can still see the outcome), plus any REVIEW events THEY
   * proposed so they can track their own proposal. Anyone with
   * create-or-verify access sees everything so the pipeline is
   * discoverable. */
  const canSeeAll = canCreate || canVerify;
  const norm = (raw) => {
    const s = String(raw || '').trim().toLowerCase();
    if (s === STATUS.PUBLISHED || s === STATUS.CLOSED || s === STATUS.REVIEW || s === STATUS.DRAFT || s === STATUS.ARCHIVED) return s;
    if (s === 'live') return STATUS.PUBLISHED;
    return STATUS.DRAFT;
  };
  const all = state.events().slice().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const myEmail = user && user.email;
  const myId = user && user.id;
  /* Owner check: an event is "mine" when I proposed it OR when I
   * created it. Compare against both id and email so events survive
   * a role change (e.g. the account that created a draft as admin
   * later signs in via Google and provisions as resident). */
  const isMine = (e) => {
    if (!e) return false;
    const owners = [e.created_by, e.proposed_by, e.approved_by].map(v => String(v || '').toLowerCase());
    const meVals = [String(myId || '').toLowerCase(), String(myEmail || '').toLowerCase()].filter(Boolean);
    return owners.some(o => o && meVals.includes(o));
  };
  const publicList = publicEvents();
  const events = canSeeAll
    ? all
    : dedupe([
      ...publicList,
      /* My drafts / reviews / archived — always visible to the owner
       * regardless of their current role. Prevents the "events
       * disappear after sign-in" bug when a creator's role downgrades
       * (e.g. admin persona → Google resident sign-in). */
      ...all.filter(e => isMine(e)),
    ]);

  const head = el('div', { class: 'row row-between', style: 'margin-bottom:18px' },
    el('div', {},
      el('h1', { text: 'Community events' }),
      el('p', { class: 'sub', text: canCreate
        ? 'Every event is created by the committee. Nothing is hard-coded.'
        : (canPropose ? 'Suggest an event — the committee will review and publish it.' : 'Every event is created by the committee.') })
    ),
    canCreate
      ? el('button', { class: 'btn', on: { click: () => openTemplatePicker(user, { propose: false }) } }, '＋ New event')
      : (canPropose ? el('button', { class: 'btn', on: { click: () => openTemplatePicker(user, { propose: true }) } }, '＋ Propose event') : null)
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
        ...list.map(evt => (st === STATUS.PUBLISHED || st === STATUS.CLOSED) ? eventCard(evt, { masked }) : adminRow(evt, user))
      )
    ));
  }

  if (!events.length) sections.push(el('div', { class: 'card card-pad' },
    el('h3', { text: 'No events yet.' }),
    el('p', { class: 'sub', text: canCreate ? 'Click "New event" to pick a template.' : 'Ask a committee member to create the first event.' })
  ));

  /* Non-admin roles that have some events in storage but none matching
   * their filter: gently confirm data is intact so they don't think
   * their events "disappeared" after a role change or sign-out cycle. */
  if (!canSeeAll && !events.length && all.length) {
    sections.push(el('div', { class: 'card card-pad', style: 'margin-top:16px' },
      el('h3', { text: 'Some events are hidden with your current role' }),
      el('p', { class: 'sub', text: `${all.length} event(s) are on record but only Published / Closed events (or ones you created / proposed) are visible for your role. Sign in with the account that created them to see the full pipeline.` })
    ));
  }

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
  return ({ draft: 'Drafts', review: 'Pending approval', published: 'Live now', closed: 'Recently closed', archived: 'Archived' })[s] || s;
}

function adminRow(evt, user) {
  const canApprove = user && (user.role === 'admin' || user.role === 'mgmt' || user.role === 'committee');
  const showApprove = canApprove && evt.status === STATUS.REVIEW;
  return el('article', { class: 'card card-content' },
    el('div', { class: 'row row-between' },
      el('div', {},
        el('h3', { class: 'card-title', text: evt.glyph + ' ' + evt.title }),
        el('p', { class: 'card-sub', text: `Template: ${evt.template} · Updated ${fmtDate(evt.updated_at)}`
          + (evt.proposed_by ? ` · Proposed by ${evt.proposed_by}` : '') })
      ),
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        el('span', { class: 'pill pill-muted', text: evt.status }),
        showApprove ? el('button', { class: 'btn btn-sm', on: { click: async () => {
          try {
            const e2 = { ...evt, status: STATUS.PUBLISHED, approved_by: user.email, approved_at: new Date().toISOString() };
            await saveEvent(e2, user);
            toast('Event approved and published', 'ok');
            location.reload();
          } catch (err) {
            toast((err && err.message) || 'Could not publish event', 'err');
          }
        } } }, '✓ Approve') : null,
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

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || !it.id) continue;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

async function openTemplatePicker(user, opts) {
  const propose = !!(opts && opts.propose);
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
        if (propose) {
          /* Resident proposal — event lands in REVIEW until an
           * approver publishes it. Author is recorded for the
           * "Pending approval" surface. */
          evt.status = STATUS.REVIEW;
          evt.proposed_by = user && user.email ? user.email : (user && user.id) || null;
          evt.proposed_at = new Date().toISOString();
        }
        await saveEvent(evt, user);
        close();
        toast(propose ? 'Proposal submitted for review' : 'Draft created', 'ok');
        navigate('/e/' + evt.id + (propose ? '' : '/edit'));
      } catch (err) {
        creating = false;
        const msg = err && err.message ? err.message : 'Could not create draft';
        if ((err && (err.code === 'ARCHIVE_NOT_CONFIGURED' || err.code === 'ARCHIVE_DISABLED'))
            || /archive repo\/pat not configured|archive is disabled/i.test(msg)) {
          toast('Archive persistence is not configured. Open Settings -> Attributes -> Archive persistence, then save and try again.', 'warn');
          close();
          navigate('/settings/attributes');
          return;
        }
        toast(msg, 'err');
      }
    } } },
      el('div', { class: 'row', style: 'font-size:32px' }, t.glyph),
      el('h3', { class: 'card-title', text: t.label }),
      el('p', { class: 'card-sub', text: (t.examples || []).slice(0, 3).join(' · ') })
    ))
  );
  const box = el('div', { class: 'modal', style: 'max-width:720px' },
    el('div', { class: 'modal-head' },
      el('h3', { text: propose ? 'Suggest an event' : 'Choose a template' }),
      el('button', { class: 'x-close', on: { click: close } }, '×')
    ),
    el('div', { class: 'modal-body' },
      el('p', { class: 'sub', text: propose
        ? 'Pick a template that matches what you have in mind. The committee will review and publish it.'
        : 'Each template pre-configures a feature set. You can override anything per event.' }),
      cards
    )
  );
  back.append(box);
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.body.append(back);
}
