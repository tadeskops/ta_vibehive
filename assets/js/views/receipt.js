/* Receipt view — printable PDF-ready. Uses window.print() for PDF export
 * so no third-party PDF lib is loaded (CSP-safe, supply-chain-safe). */
'use strict';
import { el, mount, fmtINR, fmtDate, toast } from '../dom.js';
import { state, getSociety } from '../store.js';
import { findEvent } from '../events.js';
import { attachReceipt } from '../receipts.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';

export async function render(root, { match }) {
  const contribs = state.contribs();
  const rec = contribs.find(c => c.id === match.id);
  if (!rec) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Contribution not found.' })));
  const evt = findEvent(rec.event);
  const soc = await getSociety();
  const user = session();
  const canView = user && (user.id === rec.contributor || await can(user, 'receipts.download'));
  if (!canView) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Not authorised.' })));

  if (rec.status !== 'verified') {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Pending verification' }),
      el('p', { text: 'The Management Committee has not verified this contribution yet. A receipt is generated only after verification.' }),
      el('a', { class: 'btn', href: `#/e/${rec.event}` }, 'Back to event')
    ));
  }

  if (!rec.receipt) { await attachReceipt(rec); }
  const r = state.contribs().find(c => c.id === rec.id).receipt;

  const actions = el('div', { class: 'row row-end print-hide', style: 'margin-bottom:16px' },
    el('a', { class: 'btn btn-ghost', href: `#/e/${rec.event}` }, '← Event'),
    el('a', { class: 'btn btn-ghost', href: `#/verify/${encodeURIComponent(r ? r.id : '')}` }, '🔎 Verify online'),
    el('button', { class: 'btn', on: { click: () => window.print() } }, '🖨 Download PDF / Print')
  );

  const receipt = el('article', { class: 'receipt' },
    el('header', { class: 'receipt-head' },
      el('img', { src: 'assets/images/TaLogo.png', alt: '' }),
      el('div', {},
        el('h2', { text: soc.english_name }),
        el('small', { text: `${soc.legal_name} · Reg ${soc.reg_no} · ${soc.location}` })
      )
    ),
    el('h3', { style: 'text-align:center;margin:0 0 8px', text: 'Contribution Receipt' }),
    el('div', { class: 'receipt-meta' },
      metaRow('Receipt no.', r.id),
      metaRow('Issued on', fmtDate(r.issued_at)),
      metaRow('Event', (evt ? evt.title : '—')),
      metaRow('Purpose', (evt ? (evt.purpose || evt.template) : '—')),
      metaRow('Contributor', rec.anonymous ? 'Anonymous (record maintained)' : rec.contributor_name),
      metaRow('Flat / Unit', rec.anonymous ? '—' : (rec.flat || '—')),
      metaRow('Payment method', rec.method || '—'),
      metaRow('Payment reference', rec.ref || '—')
    ),
    el('div', { class: 'receipt-total', text: 'Amount received · ' + fmtINR(r.amount) }),
    el('p', { style: 'font-size:12px;color:var(--muted)', text: 'Received with thanks. This receipt is issued for records only. No goods or services have been supplied in exchange.' }),
    el('div', { class: 'receipt-stamp' },
      el('div', {},
        el('small', { text: 'For ' + soc.short_name }),
        el('div', { style: 'font-weight:800;margin-top:20px', text: rec.verified_by || 'Authorised signatory' })
      ),
      el('img', { src: 'assets/images/TaStampBlue.png', alt: 'society stamp' })
    ),
    el('div', { class: 'receipt-verify' },
      el('div', { text: 'Verify hash: ' + r.verify_hash }),
      el('div', { text: 'Verify online: ' + verifyUrl(r.id) }),
      el('div', { text: 'Anti-forgery: warm cream base · gold border · seal watermark · verify hash · immutable audit log' })
    )
  );

  mount(root, actions, receipt);
}
function metaRow(k, v) { return el('div', {}, el('small', { text: k }), el('div', {}, el('b', { text: v }))); }
function verifyUrl(id) {
  const base = location.origin + location.pathname.replace(/index\.html$/, '');
  return base + '#/verify/' + encodeURIComponent(id);
}
