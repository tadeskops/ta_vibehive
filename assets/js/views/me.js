/* My activity view — signed-in user's own contributions + expenses.
 *
 * Route: `#/me` (also linked from the header persona chip).
 *
 * Shows:
 *   - Contributions the user submitted (verified / pending / invalid)
 *     with an inline Receipt link when verified.
 *   - Expenses the user submitted against events (pending / verified),
 *     so residents can see whether the committee has cleared their
 *     petty-cash submissions.
 *
 * Anonymous callers get a "sign in" prompt (same pattern as the rest
 * of the app). This view never reveals other residents' rows. */
'use strict';
import { el, mount, fmtDate, fmtINR } from '../dom.js';
import { session } from '../auth.js';
import { state } from '../store.js';

function normEmail(v) { return String(v || '').trim().toLowerCase(); }

function ownsContribution(c, user) {
  if (!c || !user) return false;
  const email = normEmail(user.email);
  const id    = normEmail(user.id);
  const flat  = String(user.flat || '').trim().toLowerCase();
  const cFlat = String(c.flat || '').trim().toLowerCase();
  /* A contribution belongs to the BENEFICIARY, never the filler.
   * When `on_behalf` is true the payer's identity lives on
   * `filled_by_*` + `created_by` — those must NOT count as ownership,
   * otherwise the on-behalf record shows up on both ledgers. Match
   * only on the beneficiary keys the form actually writes: the
   * beneficiary flat, the beneficiary email, and (for non-on-behalf
   * rows) the beneficiary account id in `contributor`. */
  return (
    (flat && cFlat === flat) ||
    (email && normEmail(c.contributor_email) === email) ||
    (id && normEmail(c.contributor) === id)
  );
}

function ownsExpense(x, user) {
  if (!x || !user) return false;
  const email = normEmail(user.email);
  const id    = normEmail(user.id);
  const cb    = normEmail(x.created_by);
  return (email && cb === email) || (id && cb === id);
}

function statusPillCls(status) {
  if (status === 'verified') return 'pill pill-sage';
  if (status === 'void')     return 'pill pill-muted';
  return 'pill';
}

function statusPillText(status) {
  if (status === 'void') return 'invalid';
  return status || 'pending';
}

export async function render(root) {
  const user = session();
  if (!user) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Sign in to see your activity' }),
      el('p', { class: 'sub', text: 'This page shows the contributions and expenses linked to your account.' }),
      el('a', { class: 'btn', href: '#/login', style: 'margin-top:8px' }, 'Sign in')
    ));
  }

  const eventsById = new Map(state.events().map(e => [e.id, e]));
  const contribs = state.contribs()
    .filter(c => ownsContribution(c, user))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const expenses = state.expenses()
    .filter(x => ownsExpense(x, user))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  const contribTotal = contribs.filter(c => c.status === 'verified').reduce((s, c) => s + Number(c.amount || 0), 0);
  const expenseVerified = expenses.filter(x => x.status === 'verified').reduce((s, x) => s + Number(x.amount || 0), 0);
  const expensePending  = expenses.filter(x => x.status === 'pending' || !x.status).reduce((s, x) => s + Number(x.amount || 0), 0);

  const hero = el('section', { class: 'card card-pad' },
    el('h1', { text: 'Your activity' }),
    el('p', { class: 'sub', text: `Signed in as ${user.name || user.email}. Contributions filed on behalf of someone else stay on their ledger — records are linked to the beneficiary's flat${user.flat ? ` (${user.flat})` : ''}, not the person filling the form.` }),
    el('div', { class: 'grid grid-3', style: 'margin-top:10px' },
      stat('Contributed (verified)', fmtINR(contribTotal), `${contribs.filter(c => c.status === 'verified').length} of ${contribs.length}`),
      stat('Expenses verified', fmtINR(expenseVerified), `${expenses.filter(x => x.status === 'verified').length} entries`),
      stat('Expenses awaiting check', fmtINR(expensePending), `${expenses.filter(x => x.status === 'pending' || !x.status).length} entries`)
    )
  );

  const contribSection = el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' },
    el('div', { style: 'padding:14px 16px 4px' },
      el('h3', { style: 'margin:0', text: 'Your contributions' }),
      el('small', { class: 'sub', text: 'Tap a verified row to open the receipt.' })
    ),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'When' }),
        el('th', { text: 'Event' }),
        el('th', { text: 'Method' }),
        el('th', { class: 'num', text: 'Amount' }),
        el('th', { text: 'Status' }),
        el('th', { text: 'Actions' })
      )),
      el('tbody', {}, ...(contribs.length ? contribs.map(c => {
        const evt = eventsById.get(c.event);
        return el('tr', {},
          el('td', { text: fmtDate(c.created_at) }),
          el('td', {}, evt ? el('a', { href: `#/e/${evt.id}`, text: evt.title || evt.id }) : el('span', { class: 'sub', text: c.event || '—' })),
          el('td', { text: c.method || '—' }),
          el('td', { class: 'num', text: c.hide_amount ? '—' : fmtINR(c.amount) }),
          el('td', {}, el('span', { class: statusPillCls(c.status), text: statusPillText(c.status) })),
          el('td', {}, c.status === 'verified' ? el('a', { class: 'btn btn-sm btn-ghost', href: `#/receipt/${c.id}`, text: '🧾 Receipt' }) : el('span', { class: 'sub', text: '—' }))
        );
      }) : [el('tr', {}, el('td', { colspan: 6, text: 'No contributions yet. Head to an event and tap Contribute.', style: 'text-align:center;color:var(--muted);padding:14px' }))]))
    )
  );

  const expenseSection = el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' },
    el('div', { style: 'padding:14px 16px 4px' },
      el('h3', { style: 'margin:0', text: 'Your submitted expenses' }),
      el('small', { class: 'sub', text: 'These appear on the event dashboard and community expense card only after the committee verifies them.' })
    ),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'When' }),
        el('th', { text: 'Event' }),
        el('th', { text: 'Category' }),
        el('th', { text: 'Description' }),
        el('th', { class: 'num', text: 'Amount' }),
        el('th', { text: 'Status' }),
        el('th', { text: 'Receipt' })
      )),
      el('tbody', {}, ...(expenses.length ? expenses.map(x => {
        const evt = eventsById.get(x.event_id);
        const proofCell = (x.receipt_url || x.proof_data_url)
          ? el('div', { style: 'display:flex;flex-direction:column;gap:4px;align-items:flex-start' },
              x.receipt_url ? el('a', { class: 'btn btn-sm btn-ghost', href: x.receipt_url, target: '_blank', rel: 'noopener' }, '🔗 URL') : null,
              x.proof_data_url ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => openMyProof(x) } }, '🖼 View proof') : null
            )
          : el('span', { class: 'sub', text: '—' });
        return el('tr', {},
          el('td', { text: fmtDate(x.created_at) }),
          el('td', {}, evt ? el('a', { href: `#/e/${evt.id}`, text: evt.title || evt.id }) : el('span', { class: 'sub', text: x.event_id || '—' })),
          el('td', { text: x.category || '—' }),
          el('td', { style: 'max-width:280px;white-space:normal', text: x.description || '' }),
          el('td', { class: 'num', text: fmtINR(x.amount) }),
          el('td', {}, el('span', { class: statusPillCls(x.status), text: statusPillText(x.status) })),
          el('td', {}, proofCell)
        );
      }) : [el('tr', {}, el('td', { colspan: 7, text: 'No expenses submitted yet. Open an event and tap "＋ Submit expense".', style: 'text-align:center;color:var(--muted);padding:14px' }))]))
    )
  );

  mount(root, hero, contribSection, expenseSection);
}

/* Local proof-viewer used by the "Your submitted expenses" table.
 * Kept inline because we don't share the event-page's modal helper
 * across views by design (each view owns its own dialog copy). */
function openMyProof(x) {
  const back = el('div', { class: 'modal-back' });
  const close = () => back.remove();
  const isImg = /^data:image\//.test(x.proof_data_url);
  const box = el('div', { class: 'modal' },
    el('div', { class: 'modal-head' },
      el('h3', { text: 'Expense proof · ' + (x.category || 'expense') }),
      el('button', { class: 'x-close', 'aria-label': 'Close', on: { click: close } }, '×')
    ),
    el('div', { class: 'modal-body' },
      el('div', { class: 'sub', style: 'margin-bottom:8px' },
        (x.proof_name ? x.proof_name + ' · ' : '') + (x.proof_size ? '~' + Math.round(x.proof_size / 1024) + ' KB' : '')
      ),
      isImg
        ? el('img', { src: x.proof_data_url, alt: 'expense proof', style: 'max-width:100%;max-height:60vh;border:1px solid var(--line);border-radius:6px' })
        : el('a', { class: 'btn', href: x.proof_data_url, target: '_blank', rel: 'noopener' }, 'Open attachment in new tab')
    ),
    el('div', { class: 'modal-foot' },
      el('button', { class: 'btn btn-ghost', on: { click: close } }, 'Close')
    )
  );
  back.append(box);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.append(back);
}

function stat(k, v, sub) {
  return el('div', { class: 'card stat' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: v }),
    sub ? el('div', { class: 'd', text: sub }) : null
  );
}
